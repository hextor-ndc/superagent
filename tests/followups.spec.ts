/**
 * People's messages on a Ticket's own thread (research/workload.md, section 6.2; the prototype's tests/followups.spec.ts): the
 * worker decides them, and the Router hears of each through a follow_up notice on which it may only stop the work. The rules
 * router stops on an addressed "stop" and takes only new addressed requests as new work: never a follow-up an ended ticket
 * let go, nor an unaddressed comment; a message the worker handed back becomes its own ticket.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { afterEach, describe, expect, it } from 'vitest'
import { key } from '../vendor/dsh/src/core/index.ts'
import { isStop } from '../src/app/interim-router.ts'
import type { ModelCall } from '../src/router/claude-router.ts'
import { FakeGitHub } from './fake-github.ts'
import { FakeT3 } from './fake-t3.ts'
import { checkout, harness, mcp, until, type Harness } from './harness.ts'

type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming
type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }
interface Item { type: string; trigger_id?: string; text?: string; delivered_to?: { ticket_id: string }[]; note?: string }
type FakeThread = ReturnType<FakeT3['workerThreads']>[number]

const github = { login: 'widget-bot', allowed: ['alice'], gh: 'gh', pollMs: 3_600_000 }

/** One Issue with alice's request on it, polled into a Ticket; returns its worker's thread and an MCP client for that worker. */
async function ticketOnIssue(made: Harness, t3: FakeT3, gh: FakeGitHub): Promise<{ thread: FakeThread; worker: Client; ticketId: string }> {
  await made.runtime.github!.poll()
  gh.open(12, 'carol', 'README heading is wrong')
  gh.backdate(12, 5 * 60_000)
  gh.comment(12, 'alice', '@widget-bot please fix the README heading')
  await made.runtime.github!.poll()
  const thread = await until(() => t3.workerThreads()[0], 'the worker thread')
  const url = (JSON.parse(readFileSync(join(thread.worktreePath!, '.mcp.json'), 'utf8')) as { mcpServers: { superagent: { url: string } } }).mcpServers.superagent.url
  return { thread, worker: await mcp(url), ticketId: made.runtime.repo.tickets.list()[0]!.id }
}
/** Posts a comment on Issue #12 and polls it in. */
async function say(made: Harness, gh: FakeGitHub, login: string, body: string): Promise<string> {
  const comment = gh.comment(12, login, body)
  await made.runtime.github!.poll()
  const id = key('github-comment', comment.html_url, String(comment.id), comment.updated_at)
  await until(() => made.runtime.repo.triggers.get(id), `the trigger for "${body}"`)
  return id
}
const settled = (made: Harness) => until(() => made.runtime.repo.threads.list().every(thread => !thread.evaluating && !thread.pending.length),
  'every Eval decided')
/** The Decisions on Issue #12. */
const decisions = (made: Harness) => made.runtime.repo.decisions.byThread('github:12')

describe('the rules router on a ticket\'s own thread', () => {
  let made: Harness | undefined
  afterEach(async () => { await made?.close(); made = undefined })

  it('reads a stop only from a short "stop" addressed to the agent', () => {
    const agents = ['widget-bot']
    for (const text of ['@widget-bot stop', '@widget-bot stop.', '@widget-bot please stop!', '@widget-bot stop, we are going a different way.',
      '@widget-bot stop [R09-s], we changed plans', '@widget-bot cancel it', '@widget-bot stop now\nThanks.', 'stop @widget-bot',
      '@widget-bot[bot]: stop', 'stop', '@widget-bot stop - we changed plans', '@widget-bot stop: the tests fail because of X', '@widget-bot stop-']) {
      expect(isStop(text, agents), text).toBe(true)
    }
    for (const text of ['@widget-bot stop using lodash here', '@widget-bot please stop the build from failing', '@widget-bot do not stop',
      '@widget-bot the stop button is broken', '@widget-bot cancellation flow needs work', '@widget-bot stopwatch',
      // A word that goes on from "stop" past a joiner is another word.
      '@widget-bot stop-gap fix is fine for now', '@widget-bot stop/start buttons are broken here too', '@widget-bot cancel_order is the right name',
      "@widget-bot stop's handler leaks", '@widget-bot stop’s handler leaks', '@widget-bot stop it-for-now',
      // A stop meant for someone else, or one taken back in the same message.
      '@bob stop! @widget-bot rebase please', '@alice: stop. @widget-bot what do you think?', '@widget-bot @bob stop',
      '@widget-bot stop. Actually keep going but use X', '@widget-bot stop, and continue with the docs instead']) {
      expect(isStop(text, agents), text).toBe(false)
    }
    // Without the agent's name every mention is someone else's.
    expect(isStop('stop @widget-bot')).toBe(false)
  })

  it('stops the ticket on an allowed person\'s "@bot stop" on its Issue, and leaves every other follow-up to the worker', async () => {
    const place = checkout()
    const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])
    const gh = new FakeGitHub('acme/widgets', 'widget-bot')
    made = await harness(t3, place, ':memory:', { github }, { gh: gh.gh })
    const { runtime } = made
    const { thread, ticketId } = await ticketOnIssue(made, t3, gh)

    await say(made, gh, 'alice', '@widget-bot stop using lodash here')
    await say(made, gh, 'alice', 'stop')
    // An unlisted person may not stop it; the Engine records why.
    const guest = await say(made, gh, 'mallory', '@widget-bot stop')
    await until(() => thread.messages.some(message => message.text.includes('stop using lodash')), 'the follow-up in the worker thread')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(runtime.repo.tickets.get(ticketId)!.ended).toBeUndefined()
    expect(runtime.repo.tickets.list()).toHaveLength(1)
    expect(decisions(made!).filter(decision => decision.triggerIds.includes(guest)).map(decision => decision.kind)).not.toContain('stop')

    const stop = await say(made, gh, 'alice', '@widget-bot stop, we are going a different way.')
    const ended = await until(() => runtime.repo.tickets.get(ticketId)!.ended, 'the stop')
    expect(ended).toMatchObject({ outcome: 'stopped', by: 'human' })
    expect(decisions(made!).find(decision => decision.kind === 'stop')).toMatchObject({ ticketId, triggerIds: [stop] })
    await until(() => t3.calls.some(call => call.tool === 't3_thread_interrupt' && (call.args as { stop?: boolean }).stop === true), 'the interrupt')
  })

  // A review's text starts with its decision and an inline comment's with the code it is on; the stop is in the person's words.
  it.each([['an inline comment', 'inline'], ['a review that requests changes', 'review']] as const)(
    'stops the ticket on "@bot stop" written as %s on the pull request it opened', async (_what, kind) => {
      const place = checkout()
      const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])
      const gh = new FakeGitHub('acme/widgets', 'widget-bot')
      made = await harness(t3, place, ':memory:', { github }, { gh: gh.gh })
      const { runtime } = made
      const { worker, ticketId } = await ticketOnIssue(made, t3, gh)
      gh.open(20, 'widget-bot', 'Fix README heading', 'Fixes #12', true)
      await worker.callTool({ name: 'orchestrator_report', arguments: { state: 'progress', summary: 'Opened the PR.',
        pr_url: 'https://github.com/acme/widgets/pull/20' } })

      if (kind === 'inline') gh.reviewComment(20, 'alice', '@widget-bot stop')
      else gh.review(20, 'alice', 'CHANGES_REQUESTED', '@widget-bot stop')
      await runtime.github!.poll()
      expect(await until(() => runtime.repo.tickets.get(ticketId)!.ended, 'the stop')).toMatchObject({ outcome: 'stopped', by: 'human' })
    })

  it('takes no Ticket from an unaddressed comment on a stopped ticket\'s Issue, and one from a new addressed request there', async () => {
    const place = checkout()
    const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])
    const gh = new FakeGitHub('acme/widgets', 'widget-bot')
    made = await harness(t3, place, ':memory:', { github }, { gh: gh.gh })
    const { runtime } = made
    const { ticketId } = await ticketOnIssue(made, t3, gh)
    runtime.engine.stopTicket(ticketId, 'Changed plans.')

    const thanks = await say(made, gh, 'alice', 'Thanks, we will handle it in the redesign instead.')
    await settled(made)
    expect(runtime.repo.tickets.list()).toHaveLength(1)
    expect(decisions(made!).filter(decision => decision.triggerIds.includes(thanks))).toMatchObject([{ kind: 'ignore' }])

    // An addressed request there reaches no ticket (a person stopped it) and is new work, as in the prototype.
    await say(made, gh, 'alice', '@widget-bot please fix the footer instead')
    await until(() => runtime.repo.tickets.list().length === 2, 'the second ticket')
  })

  it('takes a message its worker handed back as its own ticket even when it was not addressed to the agent', async () => {
    const place = checkout()
    const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])
    const gh = new FakeGitHub('acme/widgets', 'widget-bot')
    made = await harness(t3, place, ':memory:', { github }, { gh: gh.gh })
    const { runtime } = made
    const { thread, worker, ticketId } = await ticketOnIssue(made, t3, gh)

    // An allowed person's follow-up without a mention reaches the worker, which hands it back as new work.
    const separate = await say(made, gh, 'alice', 'Separately, please also add a CONTRIBUTING file')
    await until(() => thread.messages.some(message => message.text.includes('CONTRIBUTING')), 'the follow-up in the worker thread')
    await worker.callTool({ name: 'orchestrator_trigger_handback', arguments: { trigger_id: separate, reason: 'Another change.' } })
    const second = await until(() => runtime.repo.tickets.list().find(ticket => ticket.id !== ticketId), 'the handed-back ticket')
    expect(second.origin.triggerIds).toEqual([separate])
    expect(decisions(made!).filter(decision => decision.triggerIds.includes(separate)).map(decision => decision.kind)).toEqual(['accept'])
  })

  it('gives a "stop" to the worker as its answer while the ticket waits on a person', async () => {
    const place = checkout()
    const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])
    const gh = new FakeGitHub('acme/widgets', 'widget-bot')
    made = await harness(t3, place, ':memory:', { github }, { gh: gh.gh })
    const { runtime } = made
    const { thread, worker, ticketId } = await ticketOnIssue(made, t3, gh)
    await worker.callTool({ name: 'orchestrator_report', arguments: { state: 'progress', summary: 'The old job still runs.',
      human_action: 'Should I cancel the old subscription job, or keep it?' } })
    expect(runtime.repo.tickets.get(ticketId)!.attention).toBeDefined()

    await say(made, gh, 'alice', '@widget-bot cancel it')
    await until(() => thread.messages.some(message => message.text.includes('cancel it')), 'the answer in the worker thread')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(runtime.repo.tickets.get(ticketId)!.ended).toBeUndefined()
    expect(decisions(made!).map(decision => decision.kind)).not.toContain('stop')
  })

  it('takes a message its worker handed back as its own ticket, but no Ticket from a follow-up stopped tickets let go', async () => {
    const place = checkout()
    const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])
    const gh = new FakeGitHub('acme/widgets', 'widget-bot')
    made = await harness(t3, place, ':memory:', { github }, { gh: gh.gh })
    const { runtime } = made
    const { thread, worker, ticketId } = await ticketOnIssue(made, t3, gh)

    // The worker hands one follow-up back as separate work: it becomes its own ticket.
    const separate = await say(made, gh, 'alice', '@widget-bot separately, please add a CONTRIBUTING file')
    await until(() => thread.messages.some(message => message.text.includes('CONTRIBUTING')), 'the follow-up in the worker thread')
    await worker.callTool({ name: 'orchestrator_trigger_handback', arguments: { trigger_id: separate, reason: 'Another change.' } })
    const second = await until(() => runtime.repo.tickets.list().find(ticket => ticket.id !== ticketId), 'the handed-back ticket')
    expect(second.origin.triggerIds).toEqual([separate])

    // Both tickets follow the Issue now, so a later follow-up reaches both. A person stops both before either worker took it up:
    // each lets it go, and its Eval takes no new work from it.
    const footer = await say(made, gh, 'alice', '@widget-bot also fix the footer while you are there')
    await until(() => thread.messages.some(message => message.text.includes('footer')), 'the second follow-up in the worker thread')
    expect(runtime.repo.triggers.disposition(footer)?.fanout.sort()).toEqual([ticketId, second.id].sort())
    runtime.engine.stopTicket(second.id)
    runtime.engine.stopTicket(ticketId)
    await until(() => decisions(made!).some(decision => decision.triggerIds.includes(footer)), 'the decision on the let-go follow-up')
    await settled(made)
    expect(decisions(made!).filter(decision => decision.triggerIds.includes(footer))).toMatchObject([{ kind: 'ignore' }])
    expect(runtime.repo.tickets.list()).toHaveLength(2)
  }, 20_000)
  it.each([false, true])('stops neither ticket when a stop resumes two ended tickets on the thread (paused: %s)', async paused => {
    const place = checkout()
    const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])
    const gh = new FakeGitHub('acme/widgets', 'widget-bot')
    made = await harness(t3, place, ':memory:', { github }, { gh: gh.gh })
    const { runtime } = made
    const { thread, worker, ticketId } = await ticketOnIssue(made, t3, gh)
    const separate = await say(made, gh, 'alice', '@widget-bot separately, please add a CONTRIBUTING file')
    await until(() => thread.messages.some(message => message.text.includes('CONTRIBUTING')), 'the follow-up in the worker thread')
    await worker.callTool({ name: 'orchestrator_trigger_handback', arguments: { trigger_id: separate, reason: 'Another change.' } })
    const second = await until(() => runtime.repo.tickets.list().find(ticket => ticket.id !== ticketId), 'the handed-back ticket')
    for (const id of [ticketId, second.id]) {
      await until(() => runtime.repo.tickets.get(id)!.assignments.at(-1)?.state === 'running', `${id} running`)
      runtime.engine.report(id, { state: 'ready', summary: 'Done.' })
      await until(() => runtime.repo.tickets.get(id)!.ended, `${id} ended`)
    }
    if (paused) runtime.setPaused(true)
    await say(made, gh, 'alice', '@widget-bot stop')
    if (paused) { runtime.setPaused(false); runtime.engine.evaluateDue() }
    // Both tickets resume on the stop; the router hears of it with both, so it cannot tell which one to stop.
    await until(() => [ticketId, second.id].every(id => !runtime.repo.tickets.get(id)!.ended), 'both tickets resumed')
    await until(() => made!.errors.some(line => line.includes('reached 2 tickets')), 'the stop refused as reaching two tickets')
    // A notice that named only the first ticket to wake would have queued a stop job for it; give such a job time to run.
    await new Promise(resolve => setTimeout(resolve, 300))
    expect([ticketId, second.id].map(id => runtime.repo.tickets.get(id)!.ended)).toEqual([undefined, undefined])
    expect(decisions(made).filter(decision => decision.kind === 'stop')).toEqual([])
  })
})

describe('the model-backed Router on a ticket\'s own thread', () => {
  let made: Harness | undefined
  afterEach(async () => { await made?.close(); made = undefined })

  it('hears of a person\'s follow-up through a follow_up notice, and stops the ticket when it routes stop on one', async () => {
    const place = checkout()
    const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])
    const gh = new FakeGitHub('acme/widgets', 'widget-bot')
    const seen: Item[] = []
    let ids = 0
    // A model that accepts the request, stops on a follow-up that says stop, and does nothing for any other follow-up.
    const call: ModelCall = async (params: Params) => {
      const last = params.messages.at(-1)!
      const items = (last.content as { type: string; text?: string }[]).flatMap(block => block.type === 'text' && block.text?.startsWith('{')
        ? [JSON.parse(block.text) as Item] : [])
      seen.push(...items)
      const blocks: Block[] = []
      for (const item of items) {
        if (item.type === 'candidate') blocks.push({ type: 'tool_use', id: `toolu_${++ids}`, name: 'orchestrator_route', input: { decisions: [{ kind: 'accept',
          trigger_id: item.trigger_id, title: 'Fix the README heading', worktree_name: 'fix-readme-heading', acknowledgement: 'Fixing the heading.' }] } })
        if (item.type === 'follow_up' && /\bstop\b/.test(item.text ?? '')) blocks.push({ type: 'tool_use', id: `toolu_${++ids}`, name: 'orchestrator_route',
          input: { decisions: [{ kind: 'stop', trigger_id: item.trigger_id, ticket_id: item.delivered_to![0]!.ticket_id, reason: 'Asked to stop.' }] } })
      }
      return { id: `msg_${ids}`, type: 'message', role: 'assistant', model: params.model, content: blocks.length ? blocks : [{ type: 'text', text: 'Nothing.' }],
        stop_reason: blocks.length ? 'tool_use' : 'end_turn', stop_sequence: null, stop_details: null,
        usage: { input_tokens: 1, output_tokens: 1 } } as unknown as Anthropic.Beta.Messages.BetaMessage
    }
    made = await harness(t3, place, ':memory:', { github,
      router: { kind: 'claude', model: 'claude-opus-5-5', effort: 'low', acceptMode: 'observe' } }, { gh: gh.gh, model: call })
    const { runtime } = made
    const { thread, ticketId } = await ticketOnIssue(made, t3, gh)

    const followup = await say(made, gh, 'alice', 'Also the second heading, please.')
    const notice = await until(() => seen.find(item => item.type === 'follow_up' && item.trigger_id === followup), 'the follow_up notice')
    expect(notice).toMatchObject({ from: 'alice', thread: 'github:12', delivered_to: [expect.objectContaining({ ticket_id: ticketId })] })
    expect(notice.note).toContain('orchestrator_route kind stop')
    await until(() => thread.messages.some(message => message.text.includes('second heading')), 'the follow-up in the worker thread')
    // It reached the worker and the Router heard of it; no Eval, no candidate.
    expect(seen.filter(item => item.type === 'candidate')).toHaveLength(1)
    expect(runtime.repo.tickets.get(ticketId)!.ended).toBeUndefined()

    const stop = await say(made, gh, 'alice', '@widget-bot stop please, we will do it in the redesign')
    expect(await until(() => runtime.repo.tickets.get(ticketId)!.ended, 'the stop')).toMatchObject({ outcome: 'stopped', by: 'human' })
    expect(decisions(made!).find(decision => decision.kind === 'stop')).toMatchObject({ ticketId, triggerIds: [stop] })
    expect(seen.filter(item => item.type === 'candidate')).toHaveLength(1)
  })
})
