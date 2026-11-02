/**
 * The `console` Source: requests and answers the operator types in the Superagent console thread in t3code (point 2).
 * GitHub and chat Sources arrive in phase 2 and follow the same shape (prototype docs/008-cookbook.md).
 */
import { randomUUID } from 'node:crypto'
import { threadKey, type ChannelRef, type ThreadRef, type Trigger } from '../../vendor/dsh/src/core/index.ts'

export const CONSOLE = 'console'

export function consoleThread(id: string): ThreadRef { return { source: CONSOLE, id } }
export function consoleChannel(thread: ThreadRef): ChannelRef { return { source: CONSOLE, thread: threadKey(thread), address: {} } }

/** An operator's message in the console, addressed to the agent: an explicit request when the operator is on the allowed list. */
export function consoleTrigger(operator: string, text: string, thread: ThreadRef = consoleThread(`request-${randomUUID()}`)): Trigger {
  return { id: `console:${randomUUID()}`, source: CONSOLE, threads: [thread], actor: { source: CONSOLE, id: operator }, human: true,
    addressed: 'direct', at: new Date().toISOString(), text, channel: consoleChannel(thread), meta: { scope: 'console' } }
}
