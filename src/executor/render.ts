/**
 * What a worker reads: its first message, which in t3code carries the assignment and the worker brief, and each later Input.
 * Ported from the prototype's `src/executor/dsh.ts` (`ticketExecution`, `triggerMessage`, `inputMessage`), with the harness
 * mechanics replaced by t3code's: the worker's tools come from the `superagent` MCP server in its worktree.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { key, threadKey, type Mandate, type PolicyEffect, type Ticket, type TicketInput, type Trigger } from '../../vendor/dsh/src/core/index.ts'

const PROMPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'vendor', 'dsh', 'prompts')
const prompt = (name: string): string => readFileSync(join(PROMPTS, `${name}.md`), 'utf8').trim()
/** The prototype's built-in worker instructions, read once: role, work rules and handoff rules. */
let brief: string | undefined
export const workerBrief = (): string => brief ??= ['worker', 'work', 'handoff-worker'].map(prompt).join('\n\n')

/** Character limits for inline text, as in the prototype; longer text is read with `orchestrator_read`. */
const ASSIGNMENT_CHARS = 1500, TRIGGER_CHARS = 600
const capped = (text: string, limit: number, read: string) =>
  text.length <= limit ? { text } : { text: `${text.slice(0, limit)}…`, chars: text.length, read }

export function triggerCard(trigger: Trigger, note?: string) {
  return { trigger_id: trigger.id, from: trigger.actor.id, thread: threadKey(trigger.threads[0]!), at: trigger.at,
    ...capped(trigger.text, TRIGGER_CHARS, `trigger/${trigger.id}`), ...(trigger.url ? { source_url: trigger.url } : {}),
    ...(note ? { routing_note: note } : {}) }
}

export function mandateInstructions(mandate: Pick<Mandate, 'strength'>): string {
  return mandate.strength === 'inferred' ? 'This ticket has limited proactive authorization. Independently verify that it is a small change '
    + 'internal to one module within the accepted rule scope. If it requires public-interface or behavior changes, new interaction, product '
    + 'decisions or clarification, stop and report dropped; do not expand scope.' : ''
}

export interface ExecutionVariables {
  ticketId: string
  name: string
  directory: string
  branch: string
  /** Only for `pr` delivery: the GitHub repository the pull request goes to. */
  repository?: string
  account?: string
  commitEmail?: string
  /** How the work is delivered (D11); `pr` when not given, as before projects were kept per ticket. */
  delivery?: 'pr' | 'branch'
  /** What the worktree started from, when this service made it, with a note on the checkout's uncommitted changes it left out. */
  base?: { ref: string; sha: string; note?: string }
  /** The project the ticket is in. `purpose` only where the operator lets catalogue text reach a model. */
  project?: { title: string; key: string; root: string; purpose?: string; map?: string }
}

/**
 * The deliverable of a `branch` project (D11), appended to its Assignment and repeated as its Delivery requirements. The
 * vendored brief says to push and open a pull request "unless the assignment explicitly requests a different deliverable"
 * (vendor/dsh/prompts/work.md), which this is.
 */
export const BRANCH_DELIVERABLE = 'Deliverable: commit your change on the ticket branch in this worktree. Do not push and do not open a pull '
  + 'request. Report ready with the branch name and the last commit SHA.'

/** The section the worker brief calls "the Delivery requirements section". */
function deliveryRequirements(variables: ExecutionVariables): string[] {
  if (variables.delivery === 'branch') {
    return ['## Delivery requirements', BRANCH_DELIVERABLE, 'This project takes no pull requests: the operator reviews the ticket branch and '
      + 'merges it locally. Never push it, and never merge it into another branch.']
  }
  return ['## Delivery requirements', `Push the ticket branch and open a pull request${variables.repository ? ` in ${variables.repository}` : ''}, `
    + 'as the instructions say. No merge CLI is named here, so a person merges every pull request.']
}

/** The first message of a worker's thread: who it is, its tools, its brief, its variables, then the assignment and its source. */
export function assignmentMessage(ticket: Ticket, origin: Trigger | undefined, variables: ExecutionVariables, batch: Trigger[] = []): string {
  // A `branch` deliverable goes last in the Assignment section, after any cut, and also for a ticket whose stored assignment
  // has none: one accepted before its project switched to branch delivery (the migration binds those, docs/multi-project-plan.md 3.6).
  const branch = variables.delivery === 'branch'
  const stored = ticket.execution?.assignment ?? ''
  const assignment = branch ? stored.replace(`\n${BRANCH_DELIVERABLE}`, '').replace(BRANCH_DELIVERABLE, '') : stored
  const project = variables.project
  const lines = [
    `# Superagent ticket ${shortId(ticket.id)}: ${ticket.title}`,
    '',
    'You are a worker of the superagent, running in this T3 Code thread. People mostly talk to the superagent on GitHub or in chat; '
      + 'this thread is where your work happens, and a person may also write to you here directly.',
    'Your superagent tools come from the MCP server named `superagent`: orchestrator_read, orchestrator_ack, orchestrator_report, '
      + 'orchestrator_thread_follow, orchestrator_thread_unrelated and orchestrator_trigger_handback. Report through them; do not post to '
      + 'GitHub or chat yourself except as your instructions allow.',
    '',
    '## Instructions',
    workerBrief(),
    '',
    '## Execution variables',
    'The instructions name these as environment variables; their values are:',
    `- DSH_SUPERAGENT_TICKET=${variables.ticketId}`,
    `- DSH_SUPERAGENT_NAME=${variables.name}`,
    `- DSH_SUPERAGENT_DIR=${variables.directory}`,
    `- Branch: ${variables.branch}`,
    ...variables.base ? [`- Base ${variables.base.ref} at ${variables.base.sha}`, ...variables.base.note ? [`- ${variables.base.note}`] : []] : [],
    ...variables.repository ? [`- DSH_SUPERAGENT_GITHUB_REPOSITORY=${variables.repository}`] : [],
    ...variables.account ? [`- DSH_SUPERAGENT_GITHUB_ACCOUNT=${variables.account}`] : [],
    ...variables.commitEmail ? [`- DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL=${variables.commitEmail}`] : [],
    '',
    ...project ? ['## Project', `- ${project.title} (${project.key})`, `- Checkout: ${project.root}; your worktree is a worktree of it.`,
      ...project.purpose ? [`- Purpose: ${project.purpose}`] : [], ...project.map ? [`- Map of the repository: ${project.map}`] : [], ''] : [],
    ...deliveryRequirements(variables),
    '',
    '## Assignment',
    ...assignment ? [assignment.length <= ASSIGNMENT_CHARS ? assignment : `${assignment.slice(0, ASSIGNMENT_CHARS)}… (read ticket/${ticket.id})`] : [],
    ...branch ? [BRANCH_DELIVERABLE] : [],
    ...mandateInstructions(ticket.mandate) ? [mandateInstructions(ticket.mandate)] : [],
    '',
    '## Source request',
    '```json',
    JSON.stringify(origin ? triggerCard(origin) : { trigger_id: ticket.origin.triggerId, read: `trigger/${ticket.origin.triggerId}` }, null, 2),
    '```',
    ...batch.length ? ['', 'Other messages of the same request:', '```json', JSON.stringify(batch.map(trigger => ({ trigger_id: trigger.id,
      from: trigger.actor.id, at: trigger.at, preview: trigger.text.replace(/\s+/g, ' ').slice(0, 160), read: `trigger/${trigger.id}` })), null, 2),
    '```'] : [],
  ]
  return lines.join('\n')
}

const resumed = (inspect: string) => 'This ticket ended earlier and the message that follows, on its thread, resumed it under the same mandate. '
  + `If it asks for more within the original scope, inspect ${inspect} and continue; if it asks for work beyond that scope or `
  + 'for another ticket, hand it back with orchestrator_trigger_handback and report dropped; if it needs nothing, such as thanks, '
  + 'report dropped without a message. Report ready when the follow-up is done. Do not repeat completed work.'
/** A `branch` project has no pull request to look at. */
const RESUMED = { pr: resumed('the worktree, git history and PR state'), branch: resumed('the worktree and git history') }

function policyMessage(effect?: PolicyEffect): string {
  if (!effect) return 'Policy change: the access or admission rules changed. Check that the remaining work stays within the assignment.'
  return ['Policy change:',
    ...(effect.rules ?? []).map(rule => rule.change === 'disabled'
      ? `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, no longer applies: finish only a change within it, or report dropped.`
      : `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, changed. Keep the remaining work within it as it reads now: ${rule.instruction}`),
    ...effect.proactive === false ? ['Work inferred from a rule is no longer accepted: finish only what is in progress within the assignment, '
      + 'or report dropped, and take on nothing new.'] : [],
    ...effect.requesterAllowed === false ? ['The sender this ticket is for may no longer start work here: finish the assignment within its '
      + 'scope, and take no new requests from them on it.'] : []].join('\n')
}

/** One Input as the worker reads it; undefined for legacy inputs that carry nothing to say. */
export function inputMessage(input: TicketInput, trigger?: Trigger, delivery: 'pr' | 'branch' = 'pr'): string | undefined {
  if (input.kind === 'trigger') {
    const card = trigger ? triggerCard(trigger, input.note) : { trigger_id: input.triggerId, read: `trigger/${input.triggerId}` }
    return `New message on this ticket's threads${input.context ? ' (context only, not addressed to this ticket)' : ''}:\n`
      + `\`\`\`json\n${JSON.stringify(card, null, 2)}\n\`\`\``
  }
  if (input.kind === 'policy-changed') return policyMessage(input.effect)
  if (input.kind === 'resumed') return RESUMED[delivery]
  if (input.kind === 'note') return `Note from the orchestrator, for context only: ${input.text}`
  return input.kind === 'text' ? input.text : undefined
}

/** A Ticket's short id, as its t3code thread title shows it. */
export const shortId = (ticketId: string): string => `T-${ticketId.slice(0, 8)}`
/** The t3code thread title of a Ticket, which is how a person recognises superagent work in the sidebar. */
export const threadTitle = (ticket: Pick<Ticket, 'id' | 'title'>): string => `[${shortId(ticket.id)}] ${ticket.title}`.slice(0, 500)
/** A filesystem- and branch-safe short name for a Ticket, ending in a stable id suffix as in the prototype. */
export function ticketName(requested: string | undefined, ticketId: string): string {
  const base = (requested ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'ticket'
  return `${base}-${key(ticketId).slice(0, 8)}`
}
