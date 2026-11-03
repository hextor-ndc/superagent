/**
 * Phase 4: the scripted worker (tests/workload/worker-plan.mjs) on its own, as the live ACP agent drives it: one call per
 * turn, no state passed in, every step done in the turn. Its tools are recorded by a plain function, not a worker server.
 */
import { describe, expect, it } from 'vitest'
import { cardsOf, labelsOf, planOf, runWorkerTurn } from './worker-plan.mjs'

const card = (value: Record<string, unknown>) => `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``
const assignment = (ticket: string, text: string) => [`# Superagent ticket T-${ticket.slice(0, 8)}: Fix it`, '', '## Execution variables',
  `- DSH_SUPERAGENT_TICKET=${ticket}`, '', '## Source request', card({ trigger_id: `trigger-${ticket}`, from: 'alice', text })].join('\n')
const message = (id: string, from: string, text: string) => `New message on this ticket's threads:\n${card({ trigger_id: id, from, text })}`

function tools(ticket: string) {
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const callTool = async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args })
    return name === 'orchestrator_read' ? { text: JSON.stringify({ id: ticket }) } : { ok: true }
  }
  return { calls, callTool, names: () => calls.map(call => call.name) }
}

describe('the scripted worker', () => {
  it('reads labels, plans and message cards', () => {
    expect(labelsOf('@bot [R07] fix it {plan: pr=107 ask minutes=9} [R07-f2e] [C114] [B012]')).toEqual(['R07', 'R07-f2e', 'C114', 'B012'])
    expect(planOf('[R07] fix it {plan: pr=107 ask minutes=9}')).toEqual({ label: 'R07', pr: 107, ask: true, drop: false, ack: false, minutes: 9 })
    expect(planOf('[worker] do it')).toMatchObject({ label: undefined, ask: false, minutes: 10 })
    expect(cardsOf(message('t1', 'bob', 'hello'))).toEqual([{ trigger_id: 't1', from: 'bob', text: 'hello' }])
  })

  it('acknowledges, reports progress and reports ready in one turn when nothing is asked', async () => {
    const worker = tools('ticket-plain-0001')
    const result = await runWorkerTurn({ prompt: assignment('ticket-plain-0001', '[R01] fix the heading'), callTool: worker.callTool })
    expect(result).toEqual({ label: 'R01', did: ['ack', 'progress', 'ready'], holding: false })
    expect(worker.calls[0]).toEqual({ name: 'orchestrator_ack', args: { trigger_id: 'trigger-ticket-plain-0001', text: 'Working on R01.' } })
    expect(worker.calls.at(-1)).toEqual({ name: 'orchestrator_report', args: { state: 'ready', summary: 'R01 done.' } })
  })

  it('asks, waits through other messages, and reports ready once the answer comes, keeping its state between turns', async () => {
    const worker = tools('ticket-asks-0002')
    await runWorkerTurn({ prompt: assignment('ticket-asks-0002', '[R03] rename it {plan: ask}'), callTool: worker.callTool })
    expect(worker.calls.at(-1)!.args).toMatchObject({ state: 'progress', human_action: 'Should R03 keep the old name as an alias? [R03-q]',
      question_for_trigger_id: 'trigger-ticket-asks-0002' })
    const waiting = await runWorkerTurn({ prompt: message('t2', 'github-actions[bot]', '[B001] CI passed'), callTool: worker.callTool })
    expect(waiting.did).toEqual([])
    const answered = await runWorkerTurn({ prompt: message('t3', 'alice', '[R03-a] Yes, keep it.'), callTool: worker.callTool })
    expect(answered.did).toEqual(['answered', 'ready'])
    expect(worker.calls.at(-1)!.args).toEqual({ state: 'ready', summary: 'R03 done.', human_action: null })
    // Turns after the first find their ticket through orchestrator_read, as the live agent keeps no state of its own.
    expect(worker.names().filter(name => name === 'orchestrator_read')).toHaveLength(2)
  })

  it('holds while the work goes on, acknowledges a follow-up within the ticket and hands back another request', async () => {
    const worker = tools('ticket-hold-0003')
    const first = await runWorkerTurn({ prompt: assignment('ticket-hold-0003', '[R05] fix the save button'), callTool: worker.callTool, finish: false,
      openPull: async () => 'unused' })
    expect(first).toEqual({ label: 'R05', did: ['ack', 'progress'], holding: true })
    const next = await runWorkerTurn({ prompt: [message('f1', 'alice', '@bot [R05-f1] also the overview page {plan: ack}'),
      message('r20', 'alice', '@bot [R20] separately, update the docs'), message('s', 'alice', '@bot stop [R05-s]')].join('\n\n'),
      callTool: worker.callTool, finish: false })
    expect(next.did).toEqual(['ack:R05-f1', 'handback:R20', 'saw-stop'])
    expect(worker.calls.find(call => call.name === 'orchestrator_trigger_handback')!.args).toMatchObject({ trigger_id: 'r20' })
  })
})
