/**
 * The Router's system prompt: the prototype's built-in orchestrator instructions and team sections (vendor/dsh/prompts), in
 * its assembly order (prototype docs/004-prompts.md), with a short note on this deployment and the Policy section last, so
 * a Policy change leaves the cached prefix before it unchanged.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { policyVersion, type Settings } from '../../vendor/dsh/src/policy.ts'

const PROMPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'vendor', 'dsh', 'prompts')
const part = (name: string) => readFileSync(join(PROMPTS, `${name}.md`), 'utf8').trim()

const DEPLOYMENT = [
  '## This deployment',
  'You are the Router of a super agent whose workers run as T3 Code threads, one per ticket. You never do ticket work yourself.',
  'Messages reach you in batches: each user turn may hold several candidate cards, worker reports and notices at once. Decide every '
    + 'item in the batch, preferably with one orchestrator_route call for all routing decisions.',
  'Your tools are orchestrator_read, orchestrator_route, orchestrator_reply, orchestrator_eval, orchestrator_eval_read, '
    + 'orchestrator_eval_decide, orchestrator_ticket_note, orchestrator_ticket_retry, orchestrator_ticket_request_status, '
    + 'orchestrator_trigger_requeue and orchestrator_thread_unsubscribe. There is no shell, no skill tool and no settings tool here: '
    + 'where the instructions below mention one, the operator does that from the T3 Code console instead.',
  'The console Source is the operator typing in T3 Code; its replies stay in T3 Code.',
  'A worker report or question that says delivery "branch" is from a ticket in a project without pull requests: its worker commits on the '
    + 'ticket branch and does not push or open a pull request, and the operator reviews and merges the branch locally. For such a ticket, a '
    + 'ready report that names the branch and its last commit SHA is a complete result: deliver it, and do not ask for a pull request or '
    + 'for evidence in one.',
  'When a batch needs nothing from you, end your turn with one short line and no tool call.',
].join('\n')

/** The stable part, which prompt caching keeps across requests. */
export function routerInstructions(): string {
  return [
    part('shared'), part('orchestrator'),
    `## Communication\n${part('team/communication')}`, `## Ticket scope\n${part('team/scope')}`, `## Delivery requirements\n${part('team/delivery')}`,
    part('subscriptions'), part('replies'), part('dispatch'), part('admission'), part('handoff-orchestrator'),
    DEPLOYMENT,
  ].join('\n\n')
}

/** The Policy section, regenerated from the current settings. */
export function policySection(settings: Settings): string {
  const rules = settings.policy.rules.filter(rule => rule.enabled)
  return [
    '## Policy',
    `Policy version: ${policyVersion(settings)}. Accept mode: ${settings.eval.mode}.`,
    'Explicit requests from allowed people need no rule. Proactive (inferred) candidates are accepted only on an enabled rule below.',
    ...rules.length ? ['Enabled rules:', ...rules.map(rule => `- ${rule.name} (${rule.id}): ${rule.instruction}`)] : ['No rule is enabled.'],
  ].join('\n')
}
