/**
 * Phase 4 (PLAN.md): the properties the synthetic workload (tests/workload/workload.ts) must show, shared by every tier that
 * plays it: research/workload.md, sections 7.2 (Tier A, the model-backed Router with a scripted model in observe mode), 7.3
 * (Tier B, the rules router), both in tests/workload/acceptance.spec.ts, and 7.4 (Tier C, against a real t3code, in
 * tests/live/workload.spec.ts). The checks: exactly one ticket per request, follow-ups delivered once to the right ticket,
 * nothing proactive launched, nothing sent twice, stops honoured, results relayed with links, questions answered once, worker
 * slots respected. The paper's metrics are logged, not gated.
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import { key, readUntil, type Decision, type Ticket } from '../../vendor/dsh/src/core/index.ts'
import { mentions } from '../../vendor/dsh/src/sources/github-trigger.ts'
import type { Simulation } from './driver.ts'
import { labelsOf } from './worker-plan.mjs'
import { MINUTE, PEOPLE, messageCount, type RequestSpec, type Workload } from './workload.ts'

const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(p * values.length))]!

export interface AcceptanceOptions {
  /** Names the tier in the metrics log line. */
  name: string
  workload: Workload
  router: 'claude' | 'rules'
  maxWorkers: number
  /** Builds and plays the simulation once, before the checks. */
  play: () => Promise<Simulation>
  /** Runs after the simulation is closed, such as stopping a live t3code. */
  close?: () => Promise<void>
  /** How long playing (and closing) may take. */
  timeoutMs?: number
  /** The fewest messages the workload must have; a smaller `scale` has fewer. */
  minMessages?: number
  /**
   * Service errors a tier explains, such as a refusal from a real t3code in a race the service recovers from; each is logged.
   * Any other error fails the run.
   */
  explained?: (error: string, sim: Simulation) => string | undefined
}

/**
 * Registers the checks of one tier: plays the workload once in `beforeAll`, then checks each property on the result in its
 * own `it`. Call it inside a `describe`.
 */
export function acceptance({ name, workload, router, maxWorkers: MAX_WORKERS, play, close, timeoutMs = 90_000, minMessages = 280, explained }: AcceptanceOptions) {
  const SEED = workload.seed
  const requestLabels = workload.requests.map(request => request.label).sort()
  let sim: Simulation
  beforeAll(async () => { sim = await play() }, timeoutMs)
  afterAll(async () => {
    try { await sim?.close() } finally { await close?.() }
  }, 60_000)

  const runtime = () => sim.made.runtime
  const tickets = () => runtime().repo.tickets.list()
  const ticket = (label: string): Ticket => {
    const found = sim.ticketOf(label)
    if (!found) throw new Error(`No ticket for ${label}`)
    return found
  }
  const decisions = (): Decision[] => runtime().repo.threads.list().flatMap(thread => runtime().repo.decisions.byThread(thread.key))
  const labelsOfTrigger = (id: string) => labelsOf(runtime().repo.triggers.get(id)?.text)
  /** How often `[label]` appears in the thread of each request's ticket, by request label. */
  const hits = (label: string): Record<string, number> => {
    const found: Record<string, number> = {}
    for (const ticket of tickets().filter(item => /^R\d{2}$/.test(sim.labelOf(item) ?? ''))) {
      const count = sim.threadOf(ticket)?.messages.reduce((sum, item) => sum + item.text.split(`[${label}]`).length - 1, 0) ?? 0
      if (count) found[sim.labelOf(ticket) ?? ticket.id] = count
    }
    return found
  }
  const spec = (label: string): RequestSpec => workload.requests.find(request => request.label === label)!

  it('plays the whole workload without a worker, console or service error', () => {
    expect(messageCount(workload)).toBeGreaterThanOrEqual(minMessages)
    expect(sim.unfired()).toEqual([])
    expect(sim.workerErrors).toEqual([])
    expect(sim.consoleErrors).toEqual([])
    const errors = sim.made.errors.filter(error => {
      const why = explained?.(error, sim)
      if (why) console.log(`[workload ${name}] explained service error: ${error}\n  ${why}`)
      return !why
    })
    expect(errors).toEqual([])
    // Nothing the Watchdog reads as failing, such as a kind of job that failed three times in a row.
    expect(runtime().health.failing()).toEqual([])
  })

  it('takes exactly one Ticket per explicit request, and none from chatter, bots or unlisted people', () => {
    const labels = tickets().map(item => sim.labelOf(item) ?? item.id)
    expect(labels.filter(label => /^R\d{2}$/.test(label)).sort()).toEqual(requestLabels)
    expect(labels.sort()).toEqual(requestLabels)
    expect(tickets().every(item => item.mandate.strength === 'explicit')).toBe(true)
    // One thread per ticket, and the double-posted R13 is one ticket that both of its messages reached.
    expect(sim.t3.workerThreads()).toHaveLength(tickets().length)
    const r13 = ticket('R13')
    const reached = [...r13.origin.triggerIds, ...r13.inputs.flatMap(input => input.kind === 'trigger' ? [input.triggerId] : [])]
    expect(reached.filter(id => labelsOfTrigger(id).includes('R13'))).toHaveLength(2)
    // What nobody addressed to the agent on Issues no ticket follows never entered the Engine.
    for (const comment of sim.github.comments.filter(item => workload.unrelated.includes(item.number) && !mentions(item.body, PEOPLE.agent))) {
      expect(runtime().repo.triggers.get(key('github-comment', comment.html_url, String(comment.id), comment.updated_at))).toBeUndefined()
    }
    for (const number of workload.unrelated) expect(runtime().repo.triggers.get(key('github-issue', String(number)))).toBeUndefined()
  })

  it('delivers each follow-up, review, answer and CI comment once, to its own ticket and no other request\'s', () => {
    for (const [label, request] of workload.delivered) {
      if (/^R\d{2}$/.test(label)) continue
      // A stop typed on a ticket's thread may end the ticket before its worker gets the message; then it reaches nobody.
      if (/^R\d{2}-s$/.test(label) && !hits(label)[request]) { expect({ label, hits: hits(label) }).toEqual({ label, hits: {} }); continue }
      expect({ label, hits: hits(label) }).toEqual({ label, hits: { [request]: 1 } })
    }
    for (const label of workload.never) expect({ label, hits: hits(label) }).toEqual({ label, hits: {} })
    // The upstream benchmark case: a listed member's addressed request on a ticket's thread stays with that ticket.
    expect(hits('R05-f1')).toEqual({ R05: 1 })
    expect(runtime().outbox.list(record => record.message.kind === 'acknowledgement' && record.message.ticketId === ticket('R05').id)).toHaveLength(2)
    // A separate request typed there goes back for a fresh Eval and becomes its own ticket.
    expect(sim.handbacks).toEqual([{ from: 'R05', label: 'R20' }])
    expect(hits('R20').R05).toBe(1)
    expect(sim.threadOf(ticket('R20'))!.messages[0]!.text).toContain('[R20]')
  })

  it('never launches proactive work in observe mode', () => {
    const launched = sim.t3.calls.filter(call => call.tool === 't3_thread_launch' && !(call.args as { scratch?: boolean }).scratch)
    expect(launched.filter(call => /\[[PU]\d{2}\]/.test((call.args as { message: string }).message))).toEqual([])
    for (const label of workload.proactive) {
      const decided = decisions().filter(decision => decision.triggerIds.some(id => labelsOfTrigger(id).includes(label)))
      expect(decided.length, label).toBeGreaterThan(0)
      expect(decided.every(decision => decision.kind === 'ignore'), label).toBe(true)
      // The model-backed Router judged it and observe mode recorded what it would have done; with Eval off the gate drops it.
      if (router === 'claude') expect(decided.some(decision => decision.audit?.would_accept === true), label).toBe(true)
      else expect(decided.flatMap(decision => decision.reason.map(reason => reason.code))).toContain('not_a_member')
    }
  })

  it('launches, sends and posts nothing twice, even across overlapping polls', async () => {
    const launches = sim.t3.calls.filter(call => call.tool === 't3_thread_launch' && !(call.args as { scratch?: boolean }).scratch)
    expect(new Set(launches.map(call => (call.args as { clientRequestId: string }).clientRequestId)).size).toBe(sim.t3.workerThreads().length)
    for (const thread of sim.t3.workerThreads()) {
      const ids = thread.messages.map(item => item.clientRequestId)
      expect(new Set(ids).size).toBe(ids.length)
    }
    const markers = sim.github.posts.map(post => /<!-- superagent:(\S+) -->/.exec(post.body)?.[1])
    expect(markers.every(Boolean)).toBe(true)
    expect(new Set(markers).size).toBe(markers.length)
    const snapshot = () => ({ tickets: tickets().length, inputs: tickets().reduce((sum, item) => sum + item.inputs.length, 0), decisions: decisions().length,
      messages: sim.t3.workerThreads().reduce((sum, thread) => sum + thread.messages.length, 0), posts: sim.github.posts.length })
    const before = snapshot()
    await sim.repoll()
    expect(snapshot()).toEqual(before)
  })

  it('honours a stop from the console: the ticket ends, its thread stops, and nothing is sent to it afterwards', () => {
    for (const request of workload.requests.filter(item => item.stop === 'console')) {
      const stopped = ticket(request.label)
      expect(stopped.ended).toMatchObject({ outcome: 'stopped', by: 'human' })
      const threadId = runtime().executor.thread(stopped.id)!.threadId!
      const at = sim.t3.calls.findIndex(call => call.tool === 't3_thread_interrupt' && (call.args as { threadId: string; stop?: boolean }).threadId === threadId
        && (call.args as { stop?: boolean }).stop === true)
      expect(at, request.label).toBeGreaterThanOrEqual(0)
      expect(sim.t3.calls.slice(at).filter(call => call.tool === 't3_thread_send' && (call.args as { threadId: string }).threadId === threadId)).toEqual([])
    }
    // A person's comment on the stopped ticket's Issue reaches no worker.
    expect(hits('R07-p')).toEqual({})
  })

  it('relays each result once, with the link to its thread, and ends each ticket as its work did', () => {
    for (const request of workload.requests) {
      const found = ticket(request.label)
      const link = sim.threadOf(found)!.link
      const results = runtime().outbox.list(record => record.message.ticketId === found.id && record.message.text.startsWith('Done:'))
      if (request.stop) { expect(results, request.label).toEqual([]); expect(found.ended?.outcome, request.label).toBe('stopped'); continue }
      expect(results.map(record => record.message.text), request.label).toEqual([`Done: ${request.label} done.\n\n[Open in T3 Code](${link})`])
      if (request.source === 'github') {
        const posted = sim.github.posts.filter(post => post.path === `issues/${request.thread}/comments` && post.body.startsWith(`Done: ${request.label} done.`))
        expect(posted, request.label).toHaveLength(1)
        expect(posted[0]!.body).toContain(`[Open in T3 Code](${link})`)
      }
      expect(found.ended?.outcome, request.label).toBe(request.outcome)
      if (!request.outcome) expect(runtime().view(found).stage).toBe('person/review')
    }
  })

  it('puts each question in the attention queue and delivers its answer once', () => {
    for (const request of workload.requests.filter(item => item.plan.ask)) {
      expect(sim.attentionSeen.has(request.label), request.label).toBe(true)
      expect(hits(`${request.label}-a`)).toEqual({ [request.label]: 1 })
      expect(runtime().view(ticket(request.label)).stage).not.toBe('person/answer')
      const asked = runtime().outbox.list(record => record.message.text.includes(`[${request.label}-q]`))
      expect(asked, request.label).toHaveLength(1)
      if (request.source === 'github') expect(sim.github.posts.filter(post => post.body.includes(`[${request.label}-q]`)), request.label).toHaveLength(1)
    }
    expect(runtime().attention().filter(view => view.stage === 'person/answer')).toEqual([])
  })

  it('never launches a worker beyond maxWorkers, and runs at most one more for a person\'s message', () => {
    expect(sim.t3.atLaunch).toHaveLength(tickets().length)
    expect(Math.max(...sim.t3.atLaunch)).toBeLessThan(MAX_WORKERS)
    expect(sim.maxSlots).toBeLessThanOrEqual(MAX_WORKERS + 1)
    expect(sim.maxRunning).toBeLessThanOrEqual(MAX_WORKERS + 1)
    // The workload is heavy enough that tickets waited for a slot with every slot taken, and each of them launched later.
    expect(sim.maxRunning).toBeGreaterThanOrEqual(MAX_WORKERS)
    expect(sim.queued.size).toBeGreaterThan(0)
    for (const label of sim.queued) expect(sim.threadOf(ticket(label)), label).toBeDefined()
  })

  it('logs the paper\'s metrics: time to result, and Router batching (reported, not gated)', () => {
    const latencies = [...sim.resultAt].flatMap(([label, at]) => sim.requestAt.has(label) ? [(at - sim.requestAt.get(label)!) / MINUTE] : [])
    expect(latencies.length).toBeGreaterThan(0)
    const lines = [`[workload ${name}] seed ${SEED}: ${messageCount(workload)} messages, ${tickets().length} tickets, ${sim.steps} steps;`
      + ` time to result p50 ${percentile(latencies, 0.5).toFixed(1)} min, p95 ${percentile(latencies, 0.95).toFixed(1)} min (simulated).`]
    if (sim.routerCalls) {
      const batches = sim.routerCalls.filter(call => call.candidates > 0)
      const inBurst = batches.filter(call => call.at >= workload.burst.from && call.at < workload.burst.to + 2 * MINUTE)
      const mean = (items: typeof batches) => items.length ? items.reduce((sum, call) => sum + call.candidates, 0) / items.length : 0
      lines.push(`[workload ${name}] Router: ${sim.routerCalls.length} model calls, ${batches.reduce((sum, call) => sum + call.candidates, 0)} candidates;`
        + ` mean batch ${mean(batches).toFixed(2)} overall, ${mean(inBurst).toFixed(2)} in the burst.`)
      expect(batches.length).toBeGreaterThan(0)
    }
    console.log(lines.join('\n'))
  })

  // A follow-up steered into a running turn, or one that starts a run, counts as read when it is sent (T3Executor), so a ready
  // report in that turn, or a merge after it, finds it read and the ending ticket keeps it. The one exception is the core's:
  // a stopped ticket lets go of what its worker read after its last report or turn end, since it can no longer hand it back.
  it('counts a follow-up its worker took in as read, so it goes to no Eval', () => {
    const evaluated = new Set(decisions().flatMap(decision => decision.triggerIds.flatMap(labelsOfTrigger)))
    const people = [...workload.delivered.keys()].filter(label => /^R\d{2}-[fra]\d*e?$/.test(label))
    const readLate = (label: string) => {
      const owner = ticket(workload.delivered.get(label)!)
      const input = owner.inputs.find(item => item.kind === 'trigger' && labelsOfTrigger(item.triggerId).includes(label))
      return owner.ended?.outcome === 'stopped' && input?.kind === 'trigger' && !(input.readAt && input.readAt < readUntil(owner))
    }
    expect(people.filter(label => evaluated.has(label) && !readLate(label))).toEqual([])
  })
  // A worker that acknowledged a follow-up in its last turn read it before its ready report, so the merge or close that comes
  // after finds the work finished and ends the ticket.
  it('ends a ticket at its merge when its worker acknowledged a follow-up in its last turn', () => {
    const acked = workload.events.flatMap(event => event.kind === 'comment' && event.category === 'followup' && event.body.includes('{plan: ack}')
      ? [event.label!.split('-')[0]!] : [])
    const affected = workload.requests.filter(item => item.pull && item.pull !== 'open' && acked.includes(item.label))
    expect(affected.length).toBeGreaterThan(0)
    for (const request of affected) expect(ticket(request.label).ended?.outcome, request.label).toBe(request.outcome)
  })

  // Research/workload.md, section 6.2: a person's message on a ticket's own thread is its worker's to decide, and the Router
  // hears of it through a follow_up notice, as the prototype's main Session does, on which it may stop the ticket. The rules
  // router stops on an addressed follow-up that says just "stop" (src/app/interim-router.ts).
  it('stops a ticket on "@bot stop" typed on its GitHub thread, through the Router, while the ticket lives', () => {
    const typed = workload.requests.filter(item => item.stop === 'github')
    expect(typed.length).toBeGreaterThan(0)
    for (const request of typed) {
      const stopped = ticket(request.label)
      expect(stopped.ended, request.label).toMatchObject({ outcome: 'stopped', by: 'human' })
      const stop = decisions().find(decision => decision.kind === 'stop' && decision.ticketId === stopped.id)
      expect(stop?.triggerIds.flatMap(labelsOfTrigger), request.label).toContain(`${request.label}-s`)
      const threadId = runtime().executor.thread(stopped.id)!.threadId!
      const at = sim.t3.calls.findIndex(call => call.tool === 't3_thread_interrupt' && (call.args as { threadId: string }).threadId === threadId
        && (call.args as { stop?: boolean }).stop === true)
      expect(at, request.label).toBeGreaterThanOrEqual(0)
      expect(sim.t3.calls.slice(at).filter(call => call.tool === 't3_thread_send' && (call.args as { threadId: string }).threadId === threadId)).toEqual([])
    }
  })

  if (router === 'rules') {
    // A follow-up its ticket let go when it ended is an explicit candidate; the rules router takes none as new work, since its
    // worker had it (src/app/interim-router.ts). Only a message the worker handed back, R20 here, becomes a ticket.
    it('starts no Ticket from a follow-up its worker took in', () => {
      expect(tickets().map(item => sim.labelOf(item)).filter(label => label && workload.delivered.has(label) && !/^R\d{2}$/.test(label))).toEqual([])
    })
    // An allowed person's unaddressed comment on a stopped ticket's Issue is an explicit candidate (the stopped ticket receives
    // nothing); the rules router takes only messages addressed to the agent as new requests, and ignores it.
    it('starts no Ticket from a person\'s comment on a stopped ticket\'s Issue', () => {
      expect(sim.ticketOf('R07-p')).toBeUndefined()
      const decided = decisions().filter(decision => decision.triggerIds.some(id => labelsOfTrigger(id).includes('R07-p')))
      expect(decided.map(decision => decision.kind)).toEqual(['ignore'])
    })
  }
}
