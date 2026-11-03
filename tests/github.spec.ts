/**
 * The GitHub Source and Channel against an in-memory repository behind a fake `gh`, and the GitHub settings that let observe mode
 * reach it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import type { ModelCall } from '../src/router/claude-router.ts'
import { FakeGitHub, type Comment } from './fake-github.ts'
import { FakeT3 } from './fake-t3.ts'
import { checkout, harness, until, type Harness } from './harness.ts'
import { commentTrigger } from '../vendor/dsh/src/sources/github-trigger.ts'

describe('GitHub', () => {
  let made: Harness | undefined
  afterEach(async () => { await made?.close(); made = undefined })

  it('takes an allowed mention as a Ticket, replies on GitHub, follows its pull request to the merge', async () => {
    const place = checkout()
    const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])
    const github = new FakeGitHub('acme/widgets', 'widget-bot')
    made = await harness(t3, place, ':memory:', { github: { login: 'widget-bot', allowed: ['alice'], gh: 'gh', pollMs: 3_600_000 } }, { gh: github.gh })
    const { runtime } = made
    await runtime.github!.poll()

    // carol opened the Issue well before alice's request, outside the Source's one-minute poll overlap.
    github.open(12, 'carol', 'README heading is wrong')
    github.backdate(12, 5 * 60_000)
    github.comment(12, 'alice', '@widget-bot please fix the README heading')
    github.open(13, 'mallory', 'Do something')
    github.comment(13, 'mallory', '@widget-bot delete the repository')
    github.comment(13, 'renovate[bot]', '@widget-bot update everything')
    await runtime.github!.poll()

    // Only the allowed person's request becomes work.
    const thread = await until(() => t3.workerThreads()[0], 'the worker thread')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(t3.workerThreads()).toHaveLength(1)
    expect(thread.messages[0]!.text).toContain('please fix the README heading')
    expect(thread.messages[0]!.text).toContain('DSH_SUPERAGENT_GITHUB_ACCOUNT=widget-bot')
    const ticket = runtime.repo.tickets.list()[0]!
    expect(ticket.mandate.strength).toBe('explicit')

    // The worker acknowledges; it posts on the Issue, once, with the link to its thread.
    const url = (JSON.parse(readFileSync(join(thread.worktreePath!, '.mcp.json'), 'utf8')) as { mcpServers: { superagent: { url: string } } }).mcpServers.superagent.url
    const worker = new Client({ name: 'worker', version: '0' })
    await worker.connect(new StreamableHTTPClientTransport(new URL(url)))
    await worker.callTool({ name: 'orchestrator_ack', arguments: { trigger_id: ticket.origin.triggerId, text: 'On it.' } })
    await until(() => github.posts.length === 1, 'the acknowledgement on GitHub')
    expect(github.posts[0]).toMatchObject({ path: 'issues/12/comments' })
    expect(github.posts[0]!.body).toContain(`[Open in T3 Code](${thread.link})`)
    expect(github.posts[0]!.body).toMatch(/<!-- superagent:.+ -->/)

    // Its own comment does not come back in as a Trigger.
    const before = runtime.repo.tickets.get(ticket.id)!.inputs.length
    await runtime.github!.poll()
    expect(runtime.repo.tickets.get(ticket.id)!.inputs.length).toBe(before)

    // It opens a pull request and reports it: the Ticket follows it.
    github.open(20, 'widget-bot', 'Fix README heading', 'Fixes #12', true)
    // A comment on it before the worker reports it, polled while no Ticket followed it and inside the next poll's overlap:
    // everything on a pull request the Ticket opened is for its worker.
    github.backdateComment(github.comment(20, 'bob', 'An early note on the PR.').id, 10_000)
    await runtime.github!.poll()
    await worker.callTool({ name: 'orchestrator_report', arguments: { state: 'progress', summary: 'Opened the PR.',
      pr_url: 'https://github.com/acme/widgets/pull/20' } })
    expect(runtime.repo.tickets.get(ticket.id)!.follows).toEqual([{ thread: 'github:20', own: true }])
    expect(thread.pullRequests).toEqual(['https://github.com/acme/widgets/pull/20'])

    // A reviewer's comment on the PR reaches the worker without a mention.
    t3.finishRun(thread.id)
    await until(() => runtime.repo.tickets.get(ticket.id)!.assignments.at(-1)!.idleAt, 'the turn end')
    github.comment(20, 'bob', 'Please also fix the second heading.')
    await runtime.github!.poll()
    await until(() => thread.messages.find(message => message.text.includes('Please also fix the second heading.')), 'the review comment in the thread')
    expect(thread.messages.some(message => message.text.includes('An early note on the PR.'))).toBe(true)

    // Ready waits for the PR; the merge ends the Ticket as merged.
    await worker.callTool({ name: 'orchestrator_report', arguments: { state: 'ready', summary: 'Both headings fixed.' } })
    expect(runtime.view(runtime.repo.tickets.get(ticket.id)!).stage).toBe('person/review')
    github.merge(20)
    await runtime.github!.poll()
    expect(runtime.repo.tickets.get(ticket.id)!.ended?.outcome).toBe('merged')
    await worker.close()
  })

  // Polls re-read the last minute. An Issue opened less than a minute before the request on it comes back on the poll after
  // the Ticket began following the Issue; the Source must not take it as new, or the worker gets it as a message and, once the
  // Ticket ends, the rules router accepts it as a second Ticket.
  it('does not hand a worker the opening post of its Issue, written before the request, as a new message', async () => {
    const place = checkout()
    const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])
    const github = new FakeGitHub('acme/widgets', 'widget-bot')
    made = await harness(t3, place, ':memory:', { github: { login: 'widget-bot', allowed: ['alice'], gh: 'gh', pollMs: 3_600_000 } }, { gh: github.gh })
    const { runtime } = made
    await runtime.github!.poll()
    github.open(12, 'carol', 'README heading is wrong')
    github.comment(12, 'alice', '@widget-bot please fix the README heading')
    await runtime.github!.poll()
    const thread = await until(() => t3.workerThreads()[0], 'the worker thread')
    const ticket = runtime.repo.tickets.list()[0]!
    await until(() => runtime.repo.tickets.get(ticket.id)!.assignments.at(-1)?.state === 'running', 'the launch')
    await runtime.github!.poll()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(runtime.repo.tickets.get(ticket.id)!.inputs).toEqual([])
    expect(thread.messages.filter(message => message.text.includes('README heading is wrong'))).toEqual([])
  })

  it('hands a worker a reply written after the request but before its Ticket existed, once', async () => {
    const place = checkout()
    const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])
    const github = new FakeGitHub('acme/widgets', 'widget-bot')
    made = await harness(t3, place, ':memory:', { github: { login: 'widget-bot', allowed: ['alice'], gh: 'gh', pollMs: 3_600_000 } }, { gh: github.gh })
    const { runtime } = made
    await runtime.github!.poll()
    github.open(12, 'carol', 'README heading is wrong')
    github.comment(12, 'carol', 'It says widget instead of Widgets.')
    github.comment(12, 'alice', '@widget-bot please fix the README heading')
    // Read by the same poll as the request, before any Ticket followed the Issue, so that poll skips it.
    github.comment(12, 'carol', 'The footer has the same mistake.')
    await runtime.github!.poll()
    const thread = await until(() => t3.workerThreads()[0], 'the worker thread')
    const ticket = runtime.repo.tickets.list()[0]!
    await until(() => runtime.repo.tickets.get(ticket.id)!.assignments.at(-1)?.state === 'running', 'the launch')
    await runtime.github!.poll()
    await runtime.github!.poll()
    const texts = () => runtime.repo.tickets.get(ticket.id)!.inputs.flatMap(input => input.kind === 'trigger' ? [runtime.repo.triggers.get(input.triggerId)!.text] : [])
    expect(texts()).toEqual(['The footer has the same mistake.'])
    t3.finishRun(thread.id)
    await until(() => thread.messages.find(message => message.text.includes('The footer has the same mistake.')), 'the reply in the thread')
    expect(thread.messages.filter(message => message.text.includes('widget instead of Widgets'))).toEqual([])

    // A comment written after the Ticket followed the Issue reaches it as before.
    github.comment(12, 'carol', 'And the badge.')
    await runtime.github!.poll()
    await until(() => texts().includes('And the badge.'), 'the later comment as an Input')
    expect(texts()).toHaveLength(2)
  })
})

/** The id the Source gives the Trigger of a conversation comment, so a test can tell whether it was read. */
const triggerId = (comment: Comment) => commentTrigger({ ...comment }, { number: comment.number, isPr: false }, 'conversation', 'widget-bot').id

/** A model that only reads: it ends each turn without a decision, and keeps the candidate cards it was shown. */
function reader(): { call: ModelCall; cards: () => { thread: string; strength: string; triggers: { from: string; text: string }[] }[] } {
  const requests: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming[] = []
  const call: ModelCall = async params => {
    requests.push(structuredClone(params))
    return { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: params.model, content: [{ type: 'text', text: 'Read.' }],
      stop_reason: 'end_turn', stop_sequence: null, stop_details: null, usage: { input_tokens: 1, output_tokens: 1 } } as unknown as Anthropic.Beta.Messages.BetaMessage
  }
  const cards = () => requests.flatMap(params => params.messages.filter(message => message.role === 'user').flatMap(message =>
    typeof message.content === 'string' ? [] : message.content.flatMap(block => block.type === 'text' && block.text.startsWith('{') ? [JSON.parse(block.text) as { type: string }] : [])))
    .filter((item): item is ReturnType<ReturnType<typeof reader>['cards']>[number] & { type: string } => item.type === 'candidate')
  return { call, cards }
}

describe('GitHub in observe mode', () => {
  let made: Harness | undefined
  afterEach(async () => { await made?.close(); made = undefined })
  const env = { SUPERAGENT_PROJECT_ROOT: '/tmp/widgets', SUPERAGENT_STATE_DIR: '/tmp/superagent-state', SUPERAGENT_GITHUB_LOGIN: 'widget-bot' }

  it('reads the observed rows and the admission table from the environment, and keeps today\'s defaults without them', () => {
    expect(loadConfig(env).github).toEqual({ login: 'widget-bot', allowed: [], gh: 'gh', pollMs: 30_000 })
    expect(loadConfig({ ...env, SUPERAGENT_GITHUB_OBSERVE: 'comments, issues' }).github!.observe).toEqual(['comments', 'issues'])
    expect(loadConfig({ ...env, SUPERAGENT_GITHUB_OBSERVE: 'all' }).github!.observe).toEqual(['issues', 'pulls', 'comments'])
    expect(loadConfig({ ...env, SUPERAGENT_GITHUB_OBSERVE: 'none' }).github!.observe).toEqual([])
    expect(() => loadConfig({ ...env, SUPERAGENT_GITHUB_OBSERVE: 'commits' })).toThrow(/SUPERAGENT_GITHUB_OBSERVE/)
    const admission = { comments: { unlistedAddressed: 'inferred', listedUnaddressed: 'ignore' }, issues: { unlistedAddressed: 'explicit' } }
    expect(loadConfig({ ...env, SUPERAGENT_GITHUB_ADMISSION: JSON.stringify(admission) }).github!.admission).toEqual(admission)
    expect(() => loadConfig({ ...env, SUPERAGENT_GITHUB_ADMISSION: '{comments' })).toThrow(/SUPERAGENT_GITHUB_ADMISSION/)
    // An unaddressed message is never an explicit request, and the rows are GitHub's own.
    expect(() => loadConfig({ ...env, SUPERAGENT_GITHUB_ADMISSION: '{"comments":{"listedUnaddressed":"explicit"}}' })).toThrow(/comments\.listedUnaddressed/)
    expect(() => loadConfig({ ...env, SUPERAGENT_GITHUB_ADMISSION: '{"comment":{"unlistedAddressed":"inferred"}}' })).toThrow(/unknown rows comment/)
  })

  it('makes proactive candidates of observed unaddressed comments and of mentions the admission table admits', async () => {
    const place = checkout()
    const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])
    const github = new FakeGitHub('acme/widgets', 'widget-bot')
    const model = reader()
    github.open(30, 'erin', 'Typos in the docs')
    // Written before the Source began observing comments; it is not read, though it falls within the poll overlap.
    const early = github.comment(30, 'bob', 'The install page says "recieve".')
    github.backdateComment(early.id, 5_000)
    made = await harness(t3, place, ':memory:', {
      router: { kind: 'claude', model: 'claude-opus-5-5', effort: 'low', acceptMode: 'observe' },
      github: { login: 'widget-bot', allowed: ['alice', 'bob'], gh: 'gh', pollMs: 3_600_000, observe: ['comments'],
        admission: { comments: { unlistedAddressed: 'inferred' } } },
    }, { gh: github.gh, model: model.call })
    const { runtime } = made
    await runtime.github!.poll()
    github.comment(30, 'bob', 'The FAQ says "seperate".')
    github.comment(30, 'dave', '@widget-bot the changelog says "occured".')
    // erin is not on the list and does not address the agent: the default table ignores her, so her Issue has no candidate.
    github.open(31, 'carol', 'Spelling')
    github.comment(31, 'erin', 'The README says "definately".')
    // No mention on this Issue: bob's comment is a candidate only because the Source observes the comments row.
    github.open(32, 'erin', 'More typos')
    github.comment(32, 'bob', 'The glossary says "accomodate".')
    await runtime.github!.poll()

    const card = await until(() => model.cards().find(item => item.thread === 'github:30'), 'the candidate card')
    const observed = await until(() => model.cards().find(item => item.thread === 'github:32'), 'the observed candidate card')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(card.strength).toBe('inferred')
    expect(card.triggers.map(trigger => [trigger.from, trigger.text])).toEqual([['bob', 'The FAQ says "seperate".'],
      ['dave', '@widget-bot the changelog says "occured".']])
    expect(observed.strength).toBe('inferred')
    expect(observed.triggers.map(trigger => [trigger.from, trigger.text])).toEqual([['bob', 'The glossary says "accomodate".']])
    expect(model.cards().filter(item => item.thread !== 'github:30' && item.thread !== 'github:32')).toEqual([])
    expect(runtime.repo.triggers.get(triggerId(early))).toBeUndefined()
    expect(runtime.repo.tickets.list()).toEqual([])
    expect(t3.workerThreads()).toEqual([])
  })

  it('reads nothing unaddressed without the settings, or while proactive work is off', async () => {
    for (const settings of [{ router: 'claude' as const, observe: undefined }, { router: 'rules' as const, observe: ['comments' as const] }]) {
      const place = checkout()
      const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])
      const github = new FakeGitHub('acme/widgets', 'widget-bot')
      const model = reader()
      made = await harness(t3, place, ':memory:', {
        router: { kind: settings.router, model: 'claude-opus-5-5', effort: 'low', acceptMode: 'observe' },
        github: { login: 'widget-bot', allowed: ['bob'], gh: 'gh', pollMs: 3_600_000, ...settings.observe ? { observe: settings.observe } : {} },
      }, { gh: github.gh, model: model.call })
      await made.runtime.github!.poll()
      github.open(30, 'erin', 'Typos in the docs')
      const unaddressed = github.comment(30, 'bob', 'The FAQ says "seperate".')
      const mention = github.comment(30, 'dave', '@widget-bot the changelog says "occured".')
      await made.runtime.github!.poll()
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(model.cards(), settings.router).toEqual([])
      // dave's mention reached the gate, which ignores an unlisted person by default; bob's unaddressed comment was not read.
      const stored = (comment: Comment) => made!.runtime.repo.triggers.get(triggerId(comment))
      expect(stored(mention), settings.router).toBeDefined()
      expect(stored(unaddressed), settings.router).toBeUndefined()
      expect(made.runtime.github!.scope({ kind: 'conversation' })).toEqual({ listened: true, observed: false, row: 'comments' })
      await made.close(); made = undefined
    }
  })
})
