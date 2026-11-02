/**
 * The Engine's `Outbox` port: messages for Channels, sent once per id, in order per Ticket and conversation. Phase 2 makes it
 * durable as the prototype's SQLite outbox is. Point 4 lives here: every message about a Ticket ends with a link that opens
 * the Ticket's t3code thread.
 */
import type { OutboundMessage, Outbox, ReplyStatus } from '../../vendor/dsh/src/core/index.ts'
import { withThreadLink } from '../t3/links.ts'
import { Jobs } from './jobs.ts'

/** Sends a message on one Source's Channels; `gone` when the conversation can never receive it. */
export type ChannelSender = (message: OutboundMessage) => Promise<'sent' | 'gone'>

export interface SentRecord { message: OutboundMessage; status: ReplyStatus; at: string; error?: string }

export class MemoryOutbox implements Outbox {
  private readonly records = new Map<string, SentRecord>()
  private readonly senders = new Map<string, ChannelSender>()
  constructor(private readonly jobs: Jobs, private readonly threadLink: (ticketId: string) => string | undefined) {}

  register(source: string, sender: ChannelSender): void { this.senders.set(source, sender) }

  send(message: OutboundMessage): void {
    if (this.records.has(message.id)) return
    const text = message.ticketId ? withThreadLink(message.text, this.threadLink(message.ticketId)) : message.text
    const record: SentRecord = { message: { ...message, text }, status: 'pending', at: new Date().toISOString() }
    this.records.set(message.id, record)
    // One queue per Ticket and conversation keeps an acknowledgement ahead of the result that follows it.
    const lane = `reply:${message.ticketId ?? message.id}:${message.channel.source}:${message.channel.thread}`
    this.jobs.enqueue(`${lane}:${message.id}`, async () => {
      if (record.status !== 'pending') return
      const sender = this.senders.get(message.channel.source)
      if (!sender) throw new Error(`No Channel is registered for ${message.channel.source}`)
      try { record.status = await sender(record.message) === 'gone' ? 'dropped' : 'sent'; delete record.error }
      catch (error) { record.error = error instanceof Error ? error.message : String(error); throw error }
    }, { retries: 5, firstDelayMs: 5000, maxDelayMs: 300_000 })
  }
  status(id: string): ReplyStatus | undefined { return this.records.get(id)?.status }
  withdraw(id: string): void {
    const record = this.records.get(id)
    if (record?.status === 'pending') record.status = 'dropped'
  }
  /** Messages, newest first, for the console. */
  list(filter: (record: SentRecord) => boolean = () => true): SentRecord[] {
    return [...this.records.values()].filter(filter).reverse()
  }
}
