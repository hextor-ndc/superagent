/**
 * The Engine's `Outbox` port: messages for Channels, sent once per id, in order per Ticket and conversation. Receipts are
 * stored with the command that queued them, so a message goes out after a restart and never twice. Point 4 lives here:
 * every message about a Ticket ends with a link that opens the Ticket's t3code thread.
 */
import type { OutboundMessage, Outbox, ReplyStatus } from '../../vendor/dsh/src/core/index.ts'
import { withThreadLink } from '../t3/links.ts'
import type { Jobs } from './jobs.ts'

/** Sends a message on one Source's Channels; `gone` when the conversation can never receive it. */
export type ChannelSender = (message: OutboundMessage) => Promise<'sent' | 'gone'>

export interface SentRecord { message: OutboundMessage; status: ReplyStatus; at: string; error?: string; seq: number }
/** Where receipts live: the Store's key-value table, or a Map in tests. */
export interface ReceiptStore {
  get<T>(key: string): T | undefined
  set(key: string, value: unknown): void
  list<T>(prefix: string): T[]
}
const KEY = 'outbox:'

export class StoredOutbox implements Outbox {
  private readonly senders = new Map<string, ChannelSender>()
  private seq = 0
  constructor(private readonly store: ReceiptStore, private readonly jobs: Jobs, private readonly threadLink: (ticketId: string) => string | undefined) {
    this.seq = Math.max(0, ...store.list<SentRecord>(KEY).map(record => record.seq ?? 0))
  }

  register(source: string, sender: ChannelSender): void { this.senders.set(source, sender) }

  send(message: OutboundMessage): void {
    if (this.store.get(KEY + message.id)) return
    const text = message.ticketId ? withThreadLink(message.text, this.threadLink(message.ticketId)) : message.text
    const record: SentRecord = { message: { ...message, text }, status: 'pending', at: new Date().toISOString(), seq: ++this.seq }
    this.store.set(KEY + message.id, record)
    this.queue(record)
  }
  status(id: string): ReplyStatus | undefined { return this.store.get<SentRecord>(KEY + id)?.status }
  withdraw(id: string): void {
    const record = this.store.get<SentRecord>(KEY + id)
    if (record?.status === 'pending') this.store.set(KEY + id, { ...record, status: 'dropped' })
  }
  /** After a restart: queue every message that has not gone out. */
  resume(): void {
    for (const record of this.list(item => item.status === 'pending').reverse()) this.queue(record)
  }
  /** Messages, newest first, for the console. */
  list(filter: (record: SentRecord) => boolean = () => true): SentRecord[] {
    return this.store.list<SentRecord>(KEY).filter(filter).sort((a, b) => b.seq - a.seq)
  }

  private queue(record: SentRecord): void {
    const { message } = record
    // One queue per Ticket and conversation keeps an acknowledgement ahead of the result that follows it.
    const lane = `reply:${message.ticketId ?? message.id}:${message.channel.source}:${message.channel.thread}`
    this.jobs.enqueue(`${lane}:${String(record.seq).padStart(8, '0')}`, async () => {
      const current = this.store.get<SentRecord>(KEY + message.id)
      if (current?.status !== 'pending') return
      const earlier = this.list(item => item.status === 'pending' && item.seq < current.seq && item.message.ticketId === message.ticketId
        && item.message.channel.thread === message.channel.thread && item.message.channel.source === message.channel.source)
      if (earlier.length) throw new Error('An earlier message to this conversation has not gone out yet')
      const sender = this.senders.get(message.channel.source)
      if (!sender) throw new Error(`No Channel is registered for ${message.channel.source}`)
      try {
        const status = await sender(current.message) === 'gone' ? 'dropped' : 'sent'
        this.store.set(KEY + message.id, { ...current, status, error: undefined })
      } catch (error) {
        this.store.set(KEY + message.id, { ...current, error: error instanceof Error ? error.message : String(error) })
        throw error
      }
    }, { retries: 5, firstDelayMs: 5000, maxDelayMs: 300_000 })
  }
}
