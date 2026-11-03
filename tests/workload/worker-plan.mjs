/**
 * What a scripted superagent worker does, turn by turn (PLAN.md phase 4). Plain JS so that both the in-memory acceptance
 * test (tests/workload/acceptance.spec.ts) and the live ACP agent (tests/live/scripted-agent.mjs) drive workers with the
 * same logic; each passes `callTool(name, args)`, which calls the worker's `superagent` MCP tool and returns its
 * structured content, or throws on an error result.
 *
 * A request's text carries its label and plan: `[R07] fix the footer link {plan: pr=107 ask minutes=9}`.
 * - `pr=<n>`: open pull request #n in the first turn (through `openPull`, when the caller can) and report it with `pr_url`;
 * - `ask`: when the work is done, ask one question with `human_action`, and report ready once the answer arrives;
 * - `drop`: when the work is done, report dropped instead of ready;
 * - `minutes=<n>`: how long the simulated work takes (the paper's "simulated time-consuming tool"); the in-memory driver
 *   reads it, a live turn does the work at once.
 * Later messages carry labels too: `[R07-f2]` a follow-up, `[R07-a]` the answer to the question, `[R07-s]` a stop typed
 * on the ticket's thread, `[R07-r1]` a review. A follow-up with `{plan: ack}` is a request within the ticket, which the
 * worker acknowledges; a message that carries another request's label (`[R20]`) is beyond the ticket and is handed back.
 * A stop typed on the ticket's thread is ordinary discussion to the worker: stopping is the Router's call.
 */

/** Every workload label in a text, in order: `R07`, `R07-f2`, `P03`, `C114`, ... */
export const LABEL = /\[((?:[RPU]\d{2}(?:-[a-z]\d*e?)?)|(?:[CB]\d{3}e?))\]/g
export function labelsOf(text) { return [...String(text ?? '').matchAll(LABEL)].map(match => match[1]) }
/** The first request label (`R07`, without a suffix) in a text. */
export function requestLabel(text) { return labelsOf(text).find(label => /^R\d{2}$/.test(label)) }

/** The plan in a request's text; a text without one gets a plain plan: acknowledge, then ready. */
export function planOf(text) {
  const tokens = (/\{plan:([^}]*)\}/.exec(String(text ?? ''))?.[1] ?? '').trim().split(/\s+/).filter(Boolean)
  const value = name => tokens.find(token => token.startsWith(`${name}=`))?.slice(name.length + 1)
  return { label: requestLabel(text), pr: value('pr') ? Number(value('pr')) : undefined, ask: tokens.includes('ask'), drop: tokens.includes('drop'),
    ack: tokens.includes('ack'), minutes: Number(value('minutes') ?? 10) }
}

/** The JSON cards of the messages in a prompt: the source request and each later message, as src/executor/render.ts writes them. */
export function cardsOf(prompt) {
  return [...String(prompt ?? '').matchAll(/```json\n([\s\S]*?)\n```/g)].flatMap(match => {
    try {
      const value = JSON.parse(match[1])
      return (Array.isArray(value) ? value : [value]).filter(item => item && typeof item.trigger_id === 'string')
    } catch { return [] }
  })
}

/** A fresh worker state; the caller keeps one per ticket when it runs several workers. */
export function newWorkerState() { return { started: false, asked: false, answered: false, done: false, acked: [], handedBack: [] } }
/** States by ticket id, for callers that keep none, such as the live agent (one process per thread). */
const states = new Map()

async function stateFor(prompt, callTool) {
  let ticketId = /DSH_SUPERAGENT_TICKET=(\S+)/.exec(prompt)?.[1]
  if (!ticketId) ticketId = JSON.parse((await callTool('orchestrator_read', { resource: 'ticket' })).text).id
  if (!states.has(ticketId)) states.set(ticketId, newWorkerState())
  return states.get(ticketId)
}

/**
 * Runs one turn of a worker on the prompt it received. With `finish` false the simulated work is still going on: the turn
 * acknowledges, reports progress and takes in messages, and holds (the caller keeps the run going). With `finish` true it
 * also does what the plan says comes at the end: ask, or report ready or dropped.
 * @returns the plan's label, what the turn did (`ack`, `pr`, `progress`, `ask`, `answered`, `ready`, `dropped`, `handback:<label>`,
 * `ack:<label>`, `saw-stop`), and whether the turn holds.
 */
export async function runWorkerTurn({ prompt, callTool, state, finish = true, openPull }) {
  state ??= await stateFor(prompt, callTool)
  const did = []
  const cards = cardsOf(prompt)
  const assignment = /^# Superagent ticket /m.test(prompt)
  let rest = cards
  if (assignment && !state.started) {
    const source = cards[0]
    state.plan = planOf(source?.text)
    // A ticket started from a message that is not a request (a gap the rules router has) is named by that message's label.
    state.label = state.plan.label ?? labelsOf(source?.text)[0] ?? 'work'
    state.triggerId = source?.trigger_id
    state.started = true
    rest = cards.slice(1).filter(card => !card.preview)
    if (state.triggerId) { await callTool('orchestrator_ack', { trigger_id: state.triggerId, text: `Working on ${state.label}.` }); did.push('ack') }
    if (state.plan.pr && openPull) { state.prUrl = await openPull(state.plan.pr, `[${state.label}] ${firstLine(source?.text)}`); did.push('pr') }
    await callTool('orchestrator_report', { state: 'progress', summary: `${state.label}: started.`, ...state.prUrl ? { pr_url: state.prUrl } : {} })
    did.push('progress')
  } else if (assignment) rest = []
  const label = state.label ?? 'work'
  const resumed = /ended earlier and the message that follows/.test(prompt)
  for (const card of rest) {
    const labels = labelsOf(card.text)
    const other = labels.find(item => /^R\d{2}$/.test(item) && item !== label)
    if (other) {
      if (!state.handedBack.includes(card.trigger_id)) {
        await callTool('orchestrator_trigger_handback', { trigger_id: card.trigger_id, reason: `A separate request (${other}), not part of ${label}.` })
        state.handedBack.push(card.trigger_id)
        did.push(`handback:${other}`)
      }
      continue
    }
    if (labels.includes(`${label}-s`)) did.push('saw-stop')
    if (labels.includes(`${label}-a`)) { state.answered = true; did.push('answered') }
    if (planOf(card.text).ack && !state.acked.includes(card.trigger_id)) {
      await callTool('orchestrator_ack', { trigger_id: card.trigger_id, text: `Will do, as part of ${label}.` })
      state.acked.push(card.trigger_id)
      did.push(`ack:${labels[0] ?? card.trigger_id}`)
    }
  }
  // A note from the orchestrator carries an answer typed in the console for a ticket from GitHub.
  if (!state.answered && state.asked && (prompt.includes(`[${label}-a]`) || (!labelsOf(prompt).length && prompt.trim() && !assignment))) {
    state.answered = true
    did.push('answered')
  }
  if (!finish) return { label, did, holding: true }

  if (state.done) {
    // A person's message resumed the ended ticket: it is handled, and the ticket is ready again.
    if (resumed) { await callTool('orchestrator_report', { state: 'ready', summary: `${label}: follow-up handled.` }); did.push('ready') }
  } else if (state.plan?.ask && !state.asked) {
    await callTool('orchestrator_report', { state: 'progress', summary: `${label}: one decision is open.`,
      human_action: `Should ${label} keep the old name as an alias? [${label}-q]`, ...state.triggerId ? { question_for_trigger_id: state.triggerId } : {} })
    state.asked = true
    did.push('ask')
  } else if (state.plan?.ask && !state.answered) {
    // Still waiting for the answer; a message that is not it changes nothing.
  } else if (state.plan?.drop) {
    await callTool('orchestrator_report', { state: 'dropped', summary: `${label}: not needed after all.` })
    state.done = true
    did.push('dropped')
  } else if (state.started) {
    await callTool('orchestrator_report', { state: 'ready', summary: `${label} done.`, ...state.asked ? { human_action: null } : {} })
    state.done = true
    did.push('ready')
  }
  return { label, did, holding: false }
}

const firstLine = text => String(text ?? '').split('\n').find(line => line.trim())?.replace(LABEL, '').replace(/\{plan:[^}]*\}/, '').trim().slice(0, 60) || 'Change'
