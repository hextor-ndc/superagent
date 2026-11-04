/**
 * Phase 4: a scripted model in place of Claude for the model-backed Router, which routes the workload by its labels
 * (tests/workload/workload.ts). It reads the JSON items of the last user message, as the real Router reads its batch:
 * - an explicit candidate whose message carries a request label (`[R07]`) that no ticket on its thread has: accept, with
 *   the label as the title's start and the worktree name;
 * - a follow_up notice (a person's message an open ticket's worker has) whose message carries a stop label (`[R09-s]`):
 *   orchestrator_route stop with the ticket titled `[R09]` among those it reached, as the prototype's notice asks; any other
 *   follow_up: nothing, its worker decides it;
 * - an explicit candidate whose message carries a stop label: orchestrator_route stop, with the ticket titled `[R09]` among
 *   the card's related tickets (research/workload.md, section 7.2); ignore when there is none;
 * - any other explicit candidate (discussion on a stopped ticket's Issue, say): ignore;
 * - a proactive (inferred) candidate with a `P` label: orchestrator_eval, then orchestrator_eval_decide with an accept on the
 *   `copy` rule, which observe mode records as would-accept; any other proactive candidate: ignore from its card;
 * - a worker's question: orchestrator_reply attention; a ready report: orchestrator_reply result `Done: <summary>`.
 * It records, per request, the simulated time and how many candidates it held, for the paper's batching metric.
 */
import type Anthropic from '@anthropic-ai/sdk'
import type { ModelCall } from '../../src/router/claude-router.ts'
import { labelsOf, requestLabel } from './worker-plan.mjs'

type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming
type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }
interface CardTrigger { trigger_id: string; text: string; from: string }
interface Item {
  type: string; trigger_id?: string; strength?: 'explicit' | 'inferred'; triggers?: CardTrigger[]; related_tickets?: { id: string; title: string }[]
  ticket?: { id: string }; attention?: { question: string }; state?: string; summary?: string
  text?: string; delivered_to?: { ticket_id: string; title: string }[]
}

/** One request the Router sent: when, in simulated ms, and the candidates and other items in its batch. */
export interface RouterCall { at: number; candidates: number; items: number }

/** The JSON items of the last user message: candidate cards, worker reports. */
export function routerItems(params: Params): Item[] {
  const last = params.messages.at(-1)
  if (!last || !Array.isArray(last.content)) return []
  return (last.content as { type: string; text?: string }[]).flatMap(block => {
    if (block.type !== 'text' || !block.text?.startsWith('{')) return []
    try { return [JSON.parse(block.text) as Item] } catch { return [] }
  })
}

export function workloadRouter(clock: () => number, rules: readonly string[]): { call: ModelCall; calls: RouterCall[] } {
  const calls: RouterCall[] = []
  let ids = 0
  const use = (name: string, input: unknown): Block => ({ type: 'tool_use', id: `toolu_${++ids}`, name, input })
  const call: ModelCall = async params => {
    const items = routerItems(params)
    const cards = items.filter(item => item.type === 'candidate')
    calls.push({ at: clock(), candidates: cards.length, items: items.length })
    const blocks: Block[] = []
    const routes: Record<string, unknown>[] = []
    for (const card of cards) {
      // A batch holds every message its thread got meanwhile; the card's trigger_id decides them all.
      const primary = card.triggers?.find(trigger => trigger.trigger_id === card.trigger_id) ?? card.triggers?.at(-1)
      const text = primary?.text ?? ''
      const all = (card.triggers ?? []).map(trigger => trigger.text).join('\n')
      const label = requestLabel(text) ?? requestLabel(all)
      if (card.strength === 'explicit') {
        const stop = labelsOf(all).find(item => /^R\d{2}-s$/.test(item))
        if (stop) {
          const target = (card.related_tickets ?? []).find(ticket => ticket.title.startsWith(`[${stop.slice(0, -2)}]`))
          routes.push(target ? { kind: 'stop', trigger_id: card.trigger_id, ticket_id: target.id, reason: `${stop} asks to stop.` }
            : { kind: 'ignore', trigger_id: card.trigger_id, reason: `${stop}: no ticket of its request on this thread.` })
          continue
        }
        const taken = !!label && (card.related_tickets ?? []).some(ticket => ticket.title.startsWith(`[${label}]`))
        if (label && !taken) {
          routes.push({ kind: 'accept', trigger_id: card.trigger_id, title: `[${label}] ${firstLine(requestLabel(text) ? text : all)}`,
            worktree_name: label.toLowerCase(), acknowledgement: `On it: ${label}.` })
        } else routes.push({ kind: 'ignore', trigger_id: card.trigger_id, reason: taken ? `${label} already has its ticket.` : 'Discussion; no new work.' })
        continue
      }
      const proactive = labelsOf(all).find(item => /^P\d{2}$/.test(item))
      if (!proactive) { routes.push({ kind: 'ignore', trigger_id: card.trigger_id, reason: 'Touches no enabled rule.' }); continue }
      blocks.push(use('orchestrator_eval', { trigger_id: card.trigger_id }))
      blocks.push(use('orchestrator_eval_decide', { trigger_id: card.trigger_id, decision: 'accept',
        rule_assessments: rules.map(rule_id => ({ rule_id, matched: rule_id === 'copy',
          reason: rule_id === 'copy' ? 'A typo in existing copy.' : 'Not a visual change.' })),
        direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'Asks to fix a named typo.' },
        title: `[${proactive}] Fix a typo`, scope: 'Fix the named typo only.', reason: 'A copy fix the copy rule covers.',
        intent_evidence: 'The message asks to fix the typo.', acknowledgement: `Fixing the typo (${proactive}).`, worktree_name: proactive.toLowerCase() }))
    }
    for (const notice of items.filter(item => item.type === 'follow_up')) {
      const stop = labelsOf(notice.text ?? '').find(item => /^R\d{2}-s$/.test(item))
      const target = stop && (notice.delivered_to ?? []).find(ticket => ticket.title.startsWith(`[${stop.slice(0, -2)}]`))
      if (target) routes.push({ kind: 'stop', trigger_id: notice.trigger_id, ticket_id: target.ticket_id, reason: `${stop} asks to stop.` })
    }
    for (let i = 0; i < routes.length; i += 20) blocks.unshift(use('orchestrator_route', { decisions: routes.slice(i, i + 20) }))
    for (const item of items) {
      if (item.type === 'worker_attention' && item.ticket && item.attention) {
        blocks.push(use('orchestrator_reply', { purpose: 'attention', ticket_id: item.ticket.id, human_action: item.attention.question,
          text: `Question: ${item.attention.question}` }))
      } else if (item.type === 'worker_report' && item.state === 'ready' && item.ticket) {
        blocks.push(use('orchestrator_reply', { purpose: 'result', ticket_id: item.ticket.id, text: `Done: ${item.summary}` }))
      }
    }
    const content = blocks.length ? blocks : [{ type: 'text', text: 'Nothing to do.' }]
    return { id: `msg_${calls.length}`, type: 'message', role: 'assistant', model: params.model, content,
      stop_reason: blocks.length ? 'tool_use' : 'end_turn', stop_sequence: null, stop_details: null,
      usage: { input_tokens: 1, output_tokens: 1 } } as unknown as Anthropic.Beta.Messages.BetaMessage
  }
  return { call, calls }
}

const firstLine = (text: string): string => text.split('\n').find(line => line.trim())?.replace(/\[[^\]]*\]/g, '').replace(/\{plan:[^}]*\}/, '')
  .replace(/@\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Request'
