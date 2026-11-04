/**
 * The model-backed Router with a scripted model in place of Claude: the request it sends, routing through its tools,
 * batching of what arrives while the model works, relaying a worker's question, and recovery of a turn a restart cut off.
 * Then phase 3a of docs/multi-project-plan.md with the Router: console requests that name their project, the project on
 * candidate cards and in console acknowledgements, the attach guard, and what `superagent_request` returns.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { afterEach, describe, expect, it } from 'vitest'
import { threadKey } from '../vendor/dsh/src/core/index.ts'
import { consoleTrigger } from '../src/app/console-source.ts'
import type { ModelCall } from '../src/router/claude-router.ts'
import { routerInstructions } from '../src/router/prompt.ts'
import { FakeGitHub } from './fake-github.ts'
import { FakeT3 } from './fake-t3.ts'
import { checkout, data, harness, mcp, until, type Harness } from './harness.ts'
import { setup, type Setup } from './two-projects.ts'

type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming
type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }

/** A model that answers each request with the blocks `script` returns; no blocks with a tool call means it ends its turn. */
function scripted(script: (params: Params, call: number) => Block[] | Promise<Block[]>): { call: ModelCall; requests: Params[] } {
  const requests: Params[] = []
  let ids = 0
  const call: ModelCall = async params => {
    requests.push(structuredClone(params))
    const blocks = (await script(params, requests.length)).map(block => block.type === 'tool_use' ? { ...block, id: block.id || `toolu_${++ids}` } : block)
    const usesTool = blocks.some(block => block.type === 'tool_use')
    return { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: params.model, content: blocks,
      stop_reason: usesTool ? 'tool_use' : 'end_turn', stop_sequence: null, stop_details: null,
      usage: { input_tokens: 1, output_tokens: 1 } } as unknown as Anthropic.Beta.Messages.BetaMessage
  }
  return { call, requests }
}
/** The JSON items of the last user message: candidate cards, worker reports. */
function items(params: Params): { type: string; trigger_id?: string; ticket?: { id: string }; attention?: { question: string } }[] {
  const last = params.messages.at(-1)!
  return (last.content as { type: string; text?: string }[]).flatMap(block => {
    if (block.type !== 'text' || !block.text?.startsWith('{')) return []
    return [JSON.parse(block.text) as { type: string }]
  })
}
const routerConfig = { router: { kind: 'claude' as const, model: 'claude-opus-5-5', effort: 'low' as const, acceptMode: 'observe' as const } }

describe('the model-backed Router', () => {
  let made: Harness | undefined
  afterEach(async () => { await made?.close(); made = undefined })

  it('routes an explicit request through orchestrator_route, with the documented request shape', async () => {
    const place = checkout()
    const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])
    const model = scripted(params => {
      const card = items(params).find(item => item.type === 'candidate')
      return card ? [{ type: 'tool_use', id: '', name: 'orchestrator_route', input: { decisions: [{ kind: 'accept', trigger_id: card.trigger_id,
        title: 'Fix the README heading', worktree_name: 'fix-readme-heading', acknowledgement: 'I will fix the README heading.' }] } }]
        : [{ type: 'text', text: 'Routed.' }]
    })
    made = await harness(t3, place, ':memory:', routerConfig, { model: model.call })
    made.runtime.engine.receive(consoleTrigger('hector', 'Please fix the README heading'))

    const thread = await until(() => t3.workerThreads()[0], 'the worker thread')
    expect(thread.title).toMatch(/\] Fix the README heading$/)
    expect(thread.branch).toMatch(/^agent\/fix-readme-heading-/)
    const first = model.requests[0]!
    expect(first).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default', thinking: { type: 'adaptive' }, output_config: { effort: 'low' },
      context_management: { edits: [{ type: 'compact_20260112' }] } })
    expect(first.betas).toEqual(expect.arrayContaining(['server-side-fallback-2026-07-01', 'compact-2026-01-12']))
    expect(first.tool_choice).toBeUndefined()
    expect(first.tools!.map(tool => (tool as { name: string }).name)).toContain('orchestrator_eval_decide')
    expect(JSON.stringify(first.system)).toContain('Accept mode: observe')
    // The acknowledgement goes to the requester, with the thread link.
    await until(() => made!.runtime.outbox.list(record => record.message.kind === 'acknowledgement')[0], 'the acknowledgement')
    // The second request carries the tool result and ends the turn.
    await until(() => model.requests.length >= 2, 'the second request')
    const results = (model.requests[1]!.messages.at(-1)!.content as { type: string; content?: string }[]).filter(block => block.type === 'tool_result')
    expect(JSON.parse(results[0]!.content!).results[0]).toMatchObject({ decision: 'accept' })
  })

  it('batches candidates that arrive while the model works into its next request', async () => {
    const place = checkout()
    const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const model = scripted(async (params, call) => {
      if (call === 1) await gate
      const cards = items(params).filter(item => item.type === 'candidate')
      return cards.length ? [{ type: 'tool_use', id: '', name: 'orchestrator_route', input: { decisions: cards.map(card => ({ kind: 'ignore',
        trigger_id: card.trigger_id, reason: 'test' })) } }] : [{ type: 'text', text: 'Done.' }]
    })
    made = await harness(t3, place, ':memory:', routerConfig, { model: model.call })
    made.runtime.engine.receive(consoleTrigger('hector', 'First request'))
    await until(() => model.requests.length === 1, 'the first request')
    made.runtime.engine.receive(consoleTrigger('hector', 'Second request'))
    made.runtime.engine.receive(consoleTrigger('hector', 'Third request'))
    await new Promise(resolve => setTimeout(resolve, 1500))
    release()
    await until(() => model.requests.length >= 2, 'the next request')
    // The two that waited arrive together, beside the first step's tool result.
    const second = model.requests[1]!
    expect(items(second).filter(item => item.type === 'candidate')).toHaveLength(2)
    expect((second.messages.at(-1)!.content as { type: string }[])[0]!.type).toBe('tool_result')
    await until(() => made!.runtime.repo.threads.list().every(thread => !thread.evaluating && !thread.pending.length), 'every Eval decided')
  })

  it('relays a worker\'s question, which it asks the requester with orchestrator_reply', async () => {
    const place = checkout()
    const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])
    const model = scripted(params => {
      const all = items(params)
      const card = all.find(item => item.type === 'candidate')
      if (card) return [{ type: 'tool_use', id: '', name: 'orchestrator_route', input: { decisions: [{ kind: 'accept', trigger_id: card.trigger_id,
        title: 'Rename the module', worktree_name: 'rename-module', acknowledgement: 'Renaming the module.' }] } }]
      const attention = all.find(item => item.type === 'worker_attention')
      if (attention) return [{ type: 'tool_use', id: '', name: 'orchestrator_reply', input: { purpose: 'attention', ticket_id: attention.ticket!.id,
        human_action: attention.attention!.question, text: `Question: ${attention.attention!.question}` } }]
      return [{ type: 'text', text: 'Nothing to do.' }]
    })
    made = await harness(t3, place, ':memory:', routerConfig, { model: model.call })
    made.runtime.engine.receive(consoleTrigger('hector', 'Rename the widget module'))
    await until(() => t3.workerThreads()[0], 'the worker thread')
    const ticket = made.runtime.repo.tickets.list()[0]!
    const report = { state: 'progress' as const, summary: 'Two modules match.', question: 'Rename widgets.ts or widget-core.ts?' }
    made.runtime.router.reported(made.runtime.engine.report(ticket.id, report), report)
    const sent = await until(() => made!.runtime.outbox.list(record => record.message.text.startsWith('Question:'))[0], 'the attention message')
    expect(sent.message.text).toContain('Rename widgets.ts or widget-core.ts?')
  })

  it('answers tool calls a restart cut off, so the conversation stays valid', async () => {
    const place = checkout()
    const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])
    const database = join(place.dir, 'state.sqlite')
    let stall = true
    const first = scripted(() => stall ? new Promise<Block[]>(() => {}) : [{ type: 'text', text: 'ok' }])
    made = await harness(t3, place, database, routerConfig, { model: first.call })
    // A turn that asked for a tool, then the process stopped before running it.
    made.runtime.repo.kv.set('router:messages', [{ role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_cut', name: 'orchestrator_read', input: { resource: 'tickets' } }] }])
    stall = false
    const second = scripted(() => [{ type: 'text', text: 'Checked.' }])
    await made.close()
    made = await harness(t3, place, database, routerConfig, { model: second.call })
    made.runtime.engine.receive(consoleTrigger('hector', 'Anything'))
    await until(() => second.requests.length >= 1, 'the next request')
    const resumed = second.requests[0]!.messages.at(-1)!.content as { type: string; tool_use_id?: string; is_error?: boolean }[]
    expect(resumed[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_cut', is_error: true })
  })
})

/** A candidate card as the Router reads it. */
interface Card { type: 'candidate'; trigger_id: string; project_hint?: { key: string; title: string; by: string }; project_refused?: string
  related_tickets: { id: string; title: string; project?: { id: string; key: string } }[]; triggers: { trigger_id: string; text: string }[] }
/**
 * A Router model that routes each candidate as `route` says (undefined: nothing, the Eval stays open), keeps every card it
 * saw, and every tool result it got back.
 */
function routing(route: (card: Card) => Record<string, unknown>[] | undefined) {
  const cards: Card[] = []
  const results: { kind: string; refused?: string; ticket_id?: string; decision?: string }[] = []
  const model = scripted(params => {
    const last = params.messages.at(-1)!.content as { type: string; content?: string }[]
    for (const block of last) if (block.type === 'tool_result' && block.content?.startsWith('{"results"')) results.push(...JSON.parse(block.content).results)
    const found = items(params).filter(item => item.type === 'candidate') as unknown as Card[]
    cards.push(...found)
    const decisions = found.flatMap(card => route(card) ?? [])
    return decisions.length ? [{ type: 'tool_use', id: '', name: 'orchestrator_route', input: { decisions } }] : [{ type: 'text', text: 'Done.' }]
  })
  return { ...model, cards, results }
}
const accept = (card: Card, title: string) => [{ kind: 'accept', trigger_id: card.trigger_id, title, worktree_name: 'work', acknowledgement: `I will ${title.toLowerCase()}.` }]

describe('the Router across projects (phase 3a)', () => {
  let env: Setup | undefined
  let console: Client | undefined
  afterEach(async () => { await console?.close(); console = undefined; await env?.made.close(); env = undefined })
  const open = async (options: Parameters<typeof setup>[0]) => {
    env = await setup({ config: routerConfig, ...options })
    console = await mcp(`${env.made.base}/mcp/console/console-secret`)
    return { env, call: async (name: string, args: Record<string, unknown>) => console!.callTool({ name, arguments: args }) }
  }

  it('files a request in the project it names, shows it on the card and in the acknowledgement, and returns the accept', async () => {
    const model = routing(card => accept(card, 'Fix the gadget count'))
    const { env, call } = await open({ model: model.call })
    const result = data(await call('superagent_request', { text: 'Fix the gadget count', project: 'Gadgets', wait_seconds: 10 }))
    const ticket = env.made.runtime.repo.tickets.list()[0]!
    const thread = await until(() => env.t3.workerThreads()[0], 'the worker thread')
    expect(result).toMatchObject({ status: 'accepted', filed_in: 'Gadgets', project: 'Gadgets', ticket_id: ticket.id, link: thread.link,
      result: `accepted ${result.short} in Gadgets (from main), ${thread.link}` })
    expect(thread.projectId).toBe('p-gadgets')
    expect(env.made.runtime.binding(ticket.id)).toMatchObject({ projectId: 'p-gadgets', by: 'operator' })
    expect(env.made.runtime.repo.triggers.get(ticket.origin.triggerId)!.meta).toMatchObject({ project: 'p-gadgets', projectBy: 'operator' })
    // The card says where an accept goes; the acknowledgement in the console starts with the project's key.
    expect(model.cards[0]!.project_hint).toEqual({ key: 'Gadgets', title: 'Gadgets', by: 'operator' })
    const ack = await until(() => env.made.runtime.outbox.list(record => record.message.kind === 'acknowledgement')[0], 'the acknowledgement')
    expect(ack.message.text).toMatch(/^\[Gadgets\] I will fix the gadget count\./)
    // The ticket's view, also as the Router reads it among a card's related tickets, names its project.
    expect(env.made.runtime.view(ticket).project).toEqual({ id: 'p-gadgets', key: 'Gadgets', title: 'Gadgets' })
    expect(data(await call('superagent_ticket', { ticket_id: result.trigger_id as string }))).toMatchObject({ trigger_id: result.trigger_id, id: ticket.id,
      project: { key: 'Gadgets' } })
    // A message its worker hands back comes as a new card, with the ticket and its project among the related tickets.
    const again = consoleTrigger('hector', 'More on the count', env.made.runtime.repo.triggers.get(ticket.origin.triggerId)!.threads[0]!)
    env.made.runtime.engine.receive(again)
    env.made.runtime.engine.handback(ticket.id, again.id, 'Not this ticket\'s work.')
    await until(() => model.cards.length === 2, 'the card of the handed-back message')
    expect(model.cards[1]!.related_tickets).toEqual([expect.objectContaining({ id: ticket.id, project: { id: 'p-gadgets', key: 'Gadgets', title: 'Gadgets' } })])
  })

  it('refuses an unknown or unready project before anything is stored, and reads the projects again first', async () => {
    const model = routing(card => accept(card, 'Work'))
    const { env, call } = await open({ model: model.call })
    const unknown = await call('superagent_request', { text: 'Fix it', project: 'gadget' })
    expect(unknown.isError).toBe(true)
    expect(JSON.stringify(unknown.content)).toContain('No project gadget in T3 Code; did you mean Gadgets?')
    // A folder without git, registered in T3 Code after the start: the refresh finds it, and it is refused with its status.
    mkdirSync(join(env.dir, 'notes'))
    env.t3.addProject({ id: 'p-notes', workspaceRoot: join(env.dir, 'notes'), title: 'Notes' })
    const lists = env.t3.calls.filter(item => item.tool === 't3_project_list').length
    const unready = await call('superagent_request', { text: 'Fix it', project: 'Notes' })
    expect(env.t3.calls.filter(item => item.tool === 't3_project_list').length).toBe(lists + 1)
    expect(unready.isError).toBe(true)
    expect(JSON.stringify(unready.content)).toContain('Project Notes is no-git')
    expect(env.made.runtime.repo.threads.list()).toEqual([])
    expect(model.requests).toEqual([])
  })

  it('files an unnamed request in the legacy project and says so, or refuses it when unnamed requests are refused', async () => {
    const model = routing(card => accept(card, 'Tidy the list'))
    const first = await open({ model: model.call })
    const result = data(await first.call('superagent_request', { text: 'Tidy the list', wait_seconds: 10 }))
    expect(result).toMatchObject({ status: 'accepted', filed_in: 'Widgets, the default for requests that name no project', project: 'Widgets' })
    expect(model.cards[0]!.project_hint).toEqual({ key: 'Widgets', title: 'Widgets', by: 'legacy' })
    await console!.close(); await env!.made.close(); env = undefined

    const refusing = await open({ model: routing(card => accept(card, 'Tidy the list')).call, config: { ...routerConfig, unnamedRequests: 'refuse' } })
    const refused = await refusing.call('superagent_request', { text: 'Tidy the list' })
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('Name the project: superagent_request with project=<key>')
    expect(refusing.env.made.runtime.repo.threads.list()).toEqual([])
    // A named one still goes through.
    expect(data(await refusing.call('superagent_request', { text: 'Tidy the list', project: 'Widgets', wait_seconds: 10 }))).toMatchObject({ status: 'accepted' })
  })

  it('keeps the first project when the same trigger is accepted again after that project was denied', async () => {
    let first: string | undefined
    const again = (triggerId: string) => ({ kind: 'accept', trigger_id: triggerId, title: 'Fix the count again', worktree_name: 'work',
      acknowledgement: 'I will fix the count again.' })
    const model = routing(card => card.triggers[0]!.text === 'Fix the gadgets' ? [...accept(card, 'Fix the gadgets'), again(first!)]
      : accept(card, 'Fix the count'))
    const { env, call } = await open({ model: model.call })
    const result = data(await call('superagent_request', { text: 'Fix the count', wait_seconds: 10 }))
    first = result.trigger_id as string
    expect(env.made.runtime.binding(result.ticket_id as string)).toMatchObject({ projectId: 'p-widgets', by: 'legacy' })
    // Now an unnamed accept would be refused: the legacy project is denied. Accepting the first request again returns its
    // ticket, and does not bind it again, which would roll the accept back.
    mkdirSync(join(env.dir, 'state'), { recursive: true })
    writeFileSync(join(env.dir, 'state', 'projects.json'), JSON.stringify({ 'p-widgets': { access: 'deny' } }))
    await env.made.runtime.projects.refresh()
    expect(env.made.runtime.projectPreview([env.made.runtime.repo.triggers.get(first)!])).toMatchObject({ refused: expect.stringContaining('denied') })
    await call('superagent_request', { text: 'Fix the gadgets', project: 'Gadgets', wait_seconds: 10 })
    await until(() => model.results.length === 3, 'all three results')
    expect(model.results.map(item => item.refused ?? item.decision)).toEqual(['accept', 'accept', 'accept'])
    expect(model.results[2]!.ticket_id).toBe(result.ticket_id)
    expect(env.made.runtime.repo.tickets.list()).toHaveLength(2)
    expect(env.made.runtime.binding(result.ticket_id as string)).toMatchObject({ projectId: 'p-widgets', by: 'legacy' })
    expect(env.made.runtime.repo.kv.list('ticket-project:')).toHaveLength(2)
  })

  it('refuses to attach a request that names gadgets to a widgets ticket, and attaches a follow-up that only inherited its project', async () => {
    let target: { kind: string; ticket?: string } = { kind: 'accept' }
    const model = routing(card => target.kind === 'accept' ? accept(card, card.triggers[0]!.text)
      : target.kind === 'attach' ? [{ kind: 'attach', trigger_id: card.trigger_id, ticket_id: target.ticket }] : undefined)
    const { env, call } = await open({ model: model.call })
    const widgets = data(await call('superagent_request', { text: 'Fix the widget list', project: 'Widgets', wait_seconds: 10 }))
    const gadgets = data(await call('superagent_request', { text: 'Fix the gadget list', project: 'Gadgets', wait_seconds: 10 }))
    await until(() => env.t3.workerThreads().length === 2, 'both worker threads')

    target = { kind: 'attach', ticket: widgets.ticket_id as string }
    const named = data(await call('superagent_request', { text: 'Add a gadget filter', project: 'Gadgets', wait_seconds: 1 }))
    expect(named).toMatchObject({ status: 'pending' })
    const refused = await until(() => model.results.find(item => item.kind === 'attach'), 'the attach result')
    expect(refused.refused).toMatch(/^The request names project Gadgets, and ticket .+ is in Widgets: a request is never attached to a ticket in another project/)
    expect(env.made.runtime.repo.tickets.get(widgets.ticket_id as string)!.inputs.some(input => input.kind === 'trigger'
      && input.triggerId === named.trigger_id)).toBe(false)

    // The operator answers on the widgets ticket: the message inherits widgets as its project. Its worker hands it back, and the
    // Router attaches it to the gadgets ticket, which an inherited hint does not block.
    target = { kind: 'attach', ticket: gadgets.ticket_id as string }
    const answered = data(await call('superagent_answer', { ticket_id: widgets.ticket_id as string, text: 'Also the gadget list needs a filter.' }))
    const followup = env.made.runtime.repo.triggers.get(answered.trigger_id as string)!
    expect(followup.meta).toMatchObject({ project: 'p-widgets', projectBy: 'inherited' })
    env.made.runtime.engine.handback(widgets.ticket_id as string, followup.id, 'This is about the gadgets ticket.')
    await until(() => model.results.filter(item => item.kind === 'attach').length === 2, 'the second attach')
    expect(model.results.filter(item => item.kind === 'attach')[1]).toMatchObject({ ticket_id: gadgets.ticket_id })
    expect(env.made.runtime.repo.tickets.get(gadgets.ticket_id as string)!.inputs.some(input => input.kind === 'trigger'
      && input.triggerId === followup.id)).toBe(true)
  }, 15_000)

  it('shows project_refused on a card whose accept would roll back, and refuses to attach a request naming a project that cannot take work', async () => {
    let target: { kind: string; ticket?: string } = { kind: 'accept' }
    const model = routing(card => target.kind === 'accept' ? accept(card, card.triggers[0]!.text)
      : target.kind === 'attach' ? [{ kind: 'attach', trigger_id: card.trigger_id, ticket_id: target.ticket }] : undefined)
    // No legacy project and two ready ones: a request that names none has no default.
    const { env, call } = await open({ model: model.call, legacy: false })
    const widgets = data(await call('superagent_request', { text: 'Fix the widget list', project: 'Widgets', wait_seconds: 10 }))
    expect(widgets).toMatchObject({ status: 'accepted', project: 'Widgets' })

    target = { kind: 'none' }
    const unnamed = consoleTrigger('hector', 'Fix the list')
    env.made.runtime.engine.receive(unnamed)
    const card = await until(() => model.cards.find(item => item.trigger_id === unnamed.id), 'the unnamed card')
    expect(card.project_hint).toBeUndefined()
    expect(card.project_refused).toMatch(/^Name the project: superagent_request with project=<key>/)

    // A request that reached the Engine naming a project T3 Code does not have is not attached to the widgets ticket either.
    target = { kind: 'attach', ticket: widgets.ticket_id as string }
    const gizmos = { ...consoleTrigger('hector', 'Fix the gizmo list'), meta: { scope: 'console', project: 'p-gizmos', projectBy: 'operator' } }
    env.made.runtime.engine.receive(gizmos)
    const refused = await until(() => model.results.find(item => item.kind === 'attach'), 'the attach result')
    expect(refused.refused).toMatch(/^The request names project p-gizmos, which cannot take work: No project p-gizmos in T3 Code/)
    expect(env.made.runtime.repo.tickets.get(widgets.ticket_id as string)!.inputs.some(input => input.kind === 'trigger'
      && input.triggerId === gizmos.id)).toBe(false)
  }, 15_000)

  it('refuses to attach a message to a rerouted ticket, which would resume it in the project it left', async () => {
    let target: { kind: string; ticket?: string } = { kind: 'accept' }
    const model = routing(card => target.kind === 'accept' ? accept(card, card.triggers[0]!.text)
      : target.kind === 'attach' ? [{ kind: 'attach', trigger_id: card.trigger_id, ticket_id: target.ticket }] : undefined)
    const { env, call } = await open({ model: model.call })
    const widgets = data(await call('superagent_request', { text: 'Count the gadgets', wait_seconds: 10 }))
    expect(widgets).toMatchObject({ status: 'accepted', project: 'Widgets' })
    await until(() => env.t3.workerThreads()[0], 'the worker thread')
    env.made.runtime.engine.report(widgets.ticket_id as string, { state: 'ready', summary: 'Counted.' })
    const moved = data(await call('superagent_reroute', { ticket_id: widgets.ticket_id as string, project: 'Gadgets', wait_seconds: 10 }))
    expect(moved).toMatchObject({ stopped: { outcome: 'completed' }, filed: { status: 'accepted', project: 'Gadgets' } })

    target = { kind: 'attach', ticket: widgets.ticket_id as string }
    const more = consoleTrigger('hector', 'Also count the blue ones')
    env.made.runtime.engine.receive(more)
    const refused = await until(() => model.results.find(item => item.kind === 'attach'), 'the attach result')
    expect(refused.refused).toMatch(/was rerouted to Gadgets, and its work goes on there in ticket T-/)
    const old = env.made.runtime.repo.tickets.get(widgets.ticket_id as string)!
    expect(old.ended).toMatchObject({ outcome: 'completed' })
    expect(old.inputs.some(input => input.kind === 'trigger' && input.triggerId === more.id)).toBe(false)
  }, 15_000)

  it('returns ignored with the reason, or pending while the Router is slow; superagent_ticket and the attention list tell the rest', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let slow = false
    const model = routing(card => [{ kind: 'ignore', trigger_id: card.trigger_id, reason: `Not work: ${card.triggers[0]!.text}` }])
    const call: ModelCall = async params => { if (slow) await gate; return model.call(params) }
    const { env, call: tool } = await open({ model: call })
    const ignored = data(await tool('superagent_request', { text: 'Just saying hello', project: 'Gadgets', wait_seconds: 10 }))
    expect(ignored).toMatchObject({ status: 'ignored', result: 'ignored: Not work: Just saying hello', filed_in: 'Gadgets' })

    slow = true
    const pending = data(await tool('superagent_request', { text: 'Another hello', project: 'Gadgets', wait_seconds: 1 }))
    expect(pending).toMatchObject({ status: 'pending', result: `pending: ${pending.trigger_id}` })
    expect(data(await tool('superagent_ticket', { ticket_id: pending.trigger_id as string }))).toMatchObject({ status: 'pending', text: 'Another hello' })
    release()
    const trigger = env.made.runtime.repo.triggers.get(pending.trigger_id as string)!
    await until(() => env.made.runtime.repo.decisions.byThread(threadKey(trigger.threads[0]!))[0], 'the late decision')
    expect(data(await tool('superagent_ticket', { ticket_id: pending.trigger_id as string }))).toMatchObject({ status: 'ignored',
      result: 'ignored: Not work: Another hello' })
    const attention = data(await tool('superagent_attention', {}))
    expect(attention.ignored).toEqual([
      expect.objectContaining({ trigger_id: pending.trigger_id, text: 'Another hello', reason: 'Not work: Another hello', project: 'Gadgets' }),
      expect.objectContaining({ trigger_id: ignored.trigger_id, reason: 'Not work: Just saying hello' })])
    // A day later they are no longer listed.
    expect(env.made.runtime.ignoredRequests(Date.now() + 25 * 60 * 60_000)).toEqual([])
  }, 15_000)

  it('prefixes console acknowledgements with the project, not GitHub ones, and binds a GitHub request to the repository\'s project', async () => {
    const github = new FakeGitHub('acme/widgets', 'widget-bot')
    const model = routing(card => [{ kind: 'accept', trigger_id: card.trigger_id, title: 'Fix it', worktree_name: 'fix-it', acknowledgement: 'On it.' }])
    const { env, call } = await open({ model: model.call, gh: github.gh, legacy: { repository: 'acme/widgets' },
      config: { ...routerConfig, github: { login: 'widget-bot', allowed: ['alice'], gh: 'gh', pollMs: 3_600_000 } } })
    await env.made.runtime.github!.poll()
    github.open(12, 'alice', 'Heading', '@widget-bot please fix the README heading')
    await env.made.runtime.github!.poll()
    await until(() => github.posts.length === 1, 'the acknowledgement on GitHub')
    expect(github.posts[0]!.body).toMatch(/^On it\./)
    const ticket = env.made.runtime.repo.tickets.list()[0]!
    expect(env.made.runtime.repo.triggers.get(ticket.origin.triggerId)!.meta).toMatchObject({ project: 'p-widgets', projectBy: 'source' })
    expect(env.made.runtime.binding(ticket.id)).toMatchObject({ projectId: 'p-widgets', by: 'github', delivery: 'pr' })
    expect(model.cards[0]!.project_hint).toEqual({ key: 'Widgets', title: 'Widgets', by: 'github' })

    await call('superagent_request', { text: 'Fix the count', project: 'Gadgets', wait_seconds: 10 })
    const ack = await until(() => env.made.runtime.outbox.list(record => record.message.kind === 'acknowledgement' && record.message.channel.source === 'console')[0],
      'the console acknowledgement')
    expect(ack.message.text).toMatch(/^\[Gadgets\] On it\./)
  })

  it('prefixes the acknowledgement of an orchestrator_eval_decide accept too, and does not add the prefix twice', async () => {
    let settings!: Setup['made']['runtime']['settings']
    const acks = ['Fixing the gadget label.', '[Gadgets] Fixing the gadget title.']
    const model = scripted(params => {
      const card = items(params).find(item => item.type === 'candidate')
      if (!card) return [{ type: 'text', text: 'Done.' }]
      const text = acks.shift()!
      return [{ type: 'tool_use', id: '', name: 'orchestrator_eval_decide', input: { trigger_id: card.trigger_id, decision: 'accept',
        rule_assessments: settings.policy.rules.filter(rule => rule.enabled).map(rule => ({ rule_id: rule.id, matched: rule.id === 'copy',
          reason: rule.id === 'copy' ? 'A wording fix.' : 'Not visual.' })),
        direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'Says what to write.' },
        title: 'Fix the gadget wording', scope: 'The gadget wording.', reason: 'A wording fix.', intent_evidence: 'Asks for the fix.',
        acknowledgement: text, worktree_name: 'gadget-wording' } }]
    })
    const { env, call } = await open({ model: model.call })
    settings = env.made.runtime.settings
    for (const text of ['Fix the gadget label wording', 'Fix the gadget title wording']) {
      expect(data(await call('superagent_request', { text, project: 'Gadgets', wait_seconds: 10 }))).toMatchObject({ status: 'accepted', project: 'Gadgets' })
    }
    const sent = await until(() => {
      const found = env.made.runtime.outbox.list(record => record.message.kind === 'acknowledgement').map(record => record.message.text)
      return found.length === 2 ? found : undefined
    }, 'both acknowledgements')
    expect(sent.sort()).toEqual(['[Gadgets] Fixing the gadget label.', '[Gadgets] Fixing the gadget title.'])
  })

  it('hints a GitHub request with the repository project\'s current T3 Code id, after the folder was added again under a new one', async () => {
    const github = new FakeGitHub('acme/widgets', 'widget-bot')
    const model = routing(card => [{ kind: 'accept', trigger_id: card.trigger_id, title: 'Fix it', worktree_name: 'fix-it', acknowledgement: 'On it.' }])
    const { env } = await open({ model: model.call, gh: github.gh, legacy: { repository: 'acme/widgets' },
      config: { ...routerConfig, github: { login: 'widget-bot', allowed: ['alice'], gh: 'gh', pollMs: 3_600_000 } } })
    await env.made.runtime.github!.poll()
    // Removed and added again in T3 Code: the same folder under a new id. The registry finds the legacy project by its root.
    env.t3.projects[0]!.id = 'p-widgets-2'
    await env.made.runtime.projects.refresh()
    github.open(12, 'alice', 'Heading', '@widget-bot please fix the README heading')
    await env.made.runtime.github!.poll()
    const ticket = await until(() => env.made.runtime.repo.tickets.list()[0], 'the GitHub ticket')
    expect(env.made.runtime.repo.triggers.get(ticket.origin.triggerId)!.meta).toMatchObject({ project: 'p-widgets-2', projectBy: 'source' })
    expect(env.made.runtime.binding(ticket.id)).toMatchObject({ projectId: 'p-widgets-2', by: 'github' })
    expect(model.results.map(item => item.refused)).toEqual([undefined])
  })

  it('tells the Router what the project means in the vendored instructions, and that it never attaches across projects', () => {
    const text = routerInstructions()
    expect(text).toContain('Where the instructions above say "the deployment\'s repository" or "this project", read the project a candidate card shows in project_hint')
    expect(text).toContain('Never attach a request to a ticket in another project')
    expect(text).toContain('A message a worker hands back as belonging to another project must not be accepted')
  })
})
