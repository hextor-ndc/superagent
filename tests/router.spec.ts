/**
 * The model-backed Router with a scripted model in place of Claude: the request it sends, routing through its tools,
 * batching of what arrives while the model works, relaying a worker's question, and recovery of a turn a restart cut off.
 */
import { join } from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { consoleTrigger } from '../src/app/console-source.ts'
import type { ModelCall } from '../src/router/claude-router.ts'
import { FakeT3 } from './fake-t3.ts'
import { checkout, harness, until, type Harness } from './harness.ts'

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
