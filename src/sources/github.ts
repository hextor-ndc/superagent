/**
 * The GitHub Source and Channel for one repository, through the agent account's `gh` CLI. Triggers are built by the
 * prototype's `github-trigger.ts` (vendored unchanged); polling is this project's own, since the prototype's is harness-bound.
 *
 * What it listens to, as the domain asks a Source to decide (prototype docs/001-domain.md):
 * - a comment, inline review comment, new Issue or new pull request that mentions the agent account;
 * - anything on a Thread a Ticket subscribes to written since the Ticket followed it, so later discussion reaches the worker
 *   without a new mention;
 * - reviews, and merges or closes, of the pull requests Tickets follow;
 * - with `observe`, every new Issue, new pull request or comment of the rows it names, for the Policy's admission table.
 * The agent account's own messages never enter.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { threadKey, type EngineForSources, type OutboundMessage, type ScopeResult, type Thread, type Trigger } from '../../vendor/dsh/src/core/index.ts'
import { CommentSchema, IssueSchema, SOURCE, commentTrigger, githubAddress, issueTrigger, pullTrigger }
  from '../../vendor/dsh/src/sources/github-trigger.ts'
import { sameName } from '../../vendor/dsh/src/infra/text.ts'
import type { Health } from '../app/health.ts'
import type { GithubRow } from '../config.ts'
import type { Store } from '../app/store.ts'

export { SOURCE as GITHUB }
const run = promisify(execFile)

/** Runs `gh` with arguments and returns its standard output. */
export type Gh = (args: string[]) => Promise<string>
export class GhError extends Error {
  constructor(message: string, readonly status?: number) { super(message) }
}
export function ghCli(bin = 'gh'): Gh {
  return async args => {
    try { return (await run(bin, args, { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 })).stdout }
    catch (error) {
      const text = `${(error as { stderr?: string }).stderr ?? ''} ${error instanceof Error ? error.message : ''}`
      const status = /HTTP (\d{3})/.exec(text)?.[1]
      throw new GhError(text.trim().slice(0, 500), status ? Number(status) : undefined)
    }
  }
}

export interface GithubOptions {
  gh: Gh
  /** `owner/name`. */
  repository: string
  /**
   * The T3 Code project id the repository maps to now (the legacy project, D20). Every Trigger carries it as an explicit hint,
   * `meta.project` with `meta.projectBy: 'source'`, so its ticket is bound there whatever else the request's thread holds.
   * Read for each Trigger, since the id changes when the folder is removed and added again in T3 Code; undefined adds no hint,
   * and the accept then takes the legacy project's default, which says what is wrong with it.
   */
  project?: () => string | undefined
  /** The agent account's login: mentions of it address the agent, and its own messages are dropped. */
  login: string
  engine: () => Pick<EngineForSources, 'receive' | 'bindThread' | 'threadClosed'>
  store: Pick<Store, 'kv' | 'threads' | 'tickets' | 'triggers'>
  pollMs?: number
  /** The rows whose unaddressed messages it reads across the repository, from when each was switched on; none by default. */
  observe?: readonly GithubRow[]
  log?: (message: string, error?: unknown) => void
  health?: Health
}

const ReviewCommentSchema = CommentSchema.extend({ pull_request_url: z.string().nullish() })
const PullSchema = z.looseObject({ number: z.number(), state: z.string(), merged_at: z.string().nullish(), closed_at: z.string().nullish() })
const PostedSchema = z.looseObject({ id: z.number(), body: z.string().nullish(), user: z.looseObject({ login: z.string() }).nullish(),
  in_reply_to_id: z.number().nullish() })
const SINCE = 'github:since'
const CLOSED = 'github:closed:'
/** Per subscribed Issue or pull request number, the start of the poll before the one that first saw it subscribed. */
const FOLLOWING = 'github:following'
/** Per observed row, when the Source began observing it. */
const OBSERVING = 'github:observing'
/** Polls overlap by this much, so an item GitHub indexed late is not missed; duplicates are dropped by Trigger id. */
const OVERLAP_MS = 60_000

export class GithubSource {
  private timer?: NodeJS.Timeout
  private polling?: Promise<void>
  constructor(private readonly options: GithubOptions) {}

  start(): void {
    this.timer = setInterval(() => { void this.poll() }, this.options.pollMs ?? 30_000)
    void this.poll()
  }
  stop(): void { clearInterval(this.timer) }

  /**
   * What the Policy's gate sees of this Source: it listens to every Trigger it lets in, and receives every message of the rows
   * it observes, only mentions of the others.
   */
  scope(meta: Record<string, unknown>): ScopeResult {
    const row = rowOf(meta)
    return { listened: true, observed: this.options.observe?.includes(row) ?? false, row }
  }

  /** One poll; overlapping calls share it. */
  poll(): Promise<void> {
    this.polling ??= this.pollOnce().then(() => this.options.health?.ok('github'), error => {
      this.options.log?.('polling GitHub failed', error)
      this.options.health?.fail('github', error)
    }).finally(() => { this.polling = undefined })
    return this.polling
  }

  private async pollOnce(): Promise<void> {
    const { store } = this.options
    const started = new Date()
    // The first poll starts now: history from before the agent existed is not work for it.
    const since = store.kv.get<string>(SINCE) ?? started.toISOString()
    const from = new Date(Date.parse(since) - OVERLAP_MS).toISOString()
    const repo = `repos/${this.options.repository}`
    const subscribed: Taking = { following: this.following(since, from), observing: this.observing(started.toISOString()) }

    for (const comment of await this.pages(CommentSchema.extend({ issue_url: z.string().nullish() }), `${repo}/issues/comments?since=${from}&sort=updated&direction=asc`)) {
      const number = Number(/\/issues\/(\d+)$/.exec(comment.issue_url ?? '')?.[1])
      if (!number) continue
      const isPr = /\/pull\/\d+/.test(comment.html_url ?? '')
      this.take(commentTrigger(comment, { number, isPr, url: comment.html_url ?? undefined }, 'conversation', this.options.login), subscribed)
    }
    for (const comment of await this.pages(ReviewCommentSchema, `${repo}/pulls/comments?since=${from}&sort=updated&direction=asc`)) {
      const number = Number(/\/pulls\/(\d+)$/.exec(comment.pull_request_url ?? '')?.[1])
      if (number) this.take(withBody(commentTrigger(comment, { number, isPr: true, url: comment.html_url ?? undefined }, 'inline', this.options.login), comment), subscribed)
    }
    for (const issue of await this.pages(IssueSchema, `${repo}/issues?since=${from}&state=all&sort=created&direction=asc`)) {
      if (issue.created_at < from) continue
      this.take(issue.pull_request ? pullTrigger(issue, this.options.login) : issueTrigger(issue, this.options.login), subscribed)
    }
    await this.pollFollowedPulls(repo, from, subscribed)
    store.kv.set(SINCE, started.toISOString())
  }

  /** Reviews of followed pull requests, and their merge or close, which ends the Tickets done with them. */
  private async pollFollowedPulls(repo: string, from: string, subscribed: Taking): Promise<void> {
    const followed = new Set<number>()
    for (const ticket of this.options.store.tickets.open()) {
      for (const follow of ticket.follows ?? []) if (follow.thread.startsWith(`${SOURCE}:`) && !follow.closed) followed.add(Number(follow.thread.slice(SOURCE.length + 1)))
    }
    for (const number of followed) {
      try {
        for (const review of await this.pages(CommentSchema, `${repo}/pulls/${number}/reviews`)) {
          if ((review.submitted_at ?? '') >= from) {
            this.take(withBody(commentTrigger(review, { number, isPr: true, url: review.html_url ?? undefined }, 'review', this.options.login), review), subscribed)
          }
        }
        const pull = PullSchema.parse(JSON.parse(await this.options.gh(['api', `${repo}/pulls/${number}`])))
        if (pull.state === 'closed' && !this.options.store.kv.get(CLOSED + number)) {
          const outcome = pull.merged_at ? 'merged' : 'closed'
          this.options.engine().threadClosed({ source: SOURCE, id: String(number) }, outcome, pull.merged_at ?? pull.closed_at ?? new Date().toISOString())
          this.options.store.kv.set(CLOSED + number, outcome)
        } else if (pull.state === 'open') this.options.store.kv.delete(CLOSED + number)
      } catch (error) { this.options.log?.(`reading pull request #${number} failed`, error) }
    }
  }

  /**
   * Lets a Trigger in when it addresses the agent, or was written on a Thread a Ticket subscribes to since it followed the
   * Thread, or in a row the Source observes since it began observing it; the agent's own never.
   */
  private take(trigger: Trigger, { following, observing }: Taking): void {
    if (sameName(trigger.actor.id, this.options.login)) return
    if (!trigger.text.trim()) return
    const at = Date.parse(trigger.at)
    const since = (from: number | undefined) => from !== undefined && at >= from
    if (!trigger.addressed && !since(following.get(Number(trigger.meta.number))) && !since(observing.get(rowOf(trigger.meta)))) return
    const project = this.options.project?.()
    const hinted = project ? { ...trigger, meta: { ...trigger.meta, project, projectBy: 'source' } } : trigger
    try { this.options.engine().receive(hinted) } catch (error) { this.options.log?.(`taking in ${trigger.id} failed`, error) }
  }

  /**
   * For each Issue or pull request a Ticket subscribes to, the time from which its unaddressed messages are let in. Polls
   * re-read the last minute, so a message the Source skipped because no Ticket followed the Thread yet would otherwise come back
   * as new once one does, such as the opening post of the Issue a request was made on. For a Ticket with messages of its own on
   * the Thread (the request that started it, or one that reached it as an Input), the time is the earliest of them, so a reply
   * written after the request but before the Ticket existed still reaches the worker; these are GitHub's own times, like the
   * messages compared with them. For a Thread followed without one, such as for context, it is the start of the poll before
   * the one that first saw the Thread followed. A pull request a Ticket opened has no such time: all of it is for the worker.
   * The first sighting is recorded, and dropped once nothing subscribes; a Thread followed since before the overlap lets in all
   * the poll reads, without reading its Tickets.
   */
  private following(since: string, from: string): Map<number, number> {
    const { kv, threads } = this.options.store
    const stored = kv.get<Record<string, string>>(FOLLOWING) ?? {}
    const kept: Record<string, string> = {}
    const following = new Map<number, number>()
    for (const thread of threads.list()) {
      if (thread.ref.source !== SOURCE || !thread.subscriptions.length || !/^\d+$/.test(thread.ref.id)) continue
      const noticed = kept[thread.ref.id] = stored[thread.ref.id] ?? since
      following.set(Number(thread.ref.id), noticed < from ? -Infinity : this.followedFrom(thread, Date.parse(noticed)))
    }
    if (JSON.stringify(kept) !== JSON.stringify(stored)) kv.set(FOLLOWING, kept)
    return following
  }

  private followedFrom(thread: Thread, noticed: number): number {
    const { tickets, triggers } = this.options.store
    let earliest = Infinity
    for (const id of thread.subscriptions) {
      const ticket = tickets.get(id)
      if (ticket?.follows?.some(follow => follow.thread === thread.key && follow.own)) return -Infinity
      const triggerIds = ticket ? [...ticket.origin.triggerIds, ...ticket.inputs.flatMap(input => input.kind === 'trigger' ? [input.triggerId] : [])] : []
      let own = Infinity
      for (const triggerId of new Set(triggerIds)) {
        const trigger = triggers.get(triggerId)
        if (trigger?.threads.some(ref => threadKey(ref) === thread.key)) own = Math.min(own, Date.parse(trigger.at))
      }
      earliest = Math.min(earliest, own === Infinity ? noticed : own)
    }
    return earliest === Infinity ? noticed : earliest
  }

  /**
   * When the Source began observing each row it observes: a row switched on reads nothing written before. The start is this
   * machine's poll time, compared with GitHub's times, as the prototype does; a comment's time is its last edit, so an older
   * comment edited after the start is read as a new message.
   */
  private observing(started: string): Map<GithubRow, number> {
    const { kv } = this.options.store
    const stored = kv.get<Partial<Record<GithubRow, string>>>(OBSERVING) ?? {}
    const kept = Object.fromEntries((this.options.observe ?? []).map(row => [row, stored[row] ?? started]))
    if (JSON.stringify(kept) !== JSON.stringify(stored)) kv.set(OBSERVING, kept)
    return new Map(Object.entries(kept).map(([row, at]) => [row as GithubRow, Date.parse(at)]))
  }

  /**
   * A worker reported its pull request: the Ticket follows its Thread, so review comments reach the worker and its merge or
   * close ends the Ticket. Returns whether the URL is a pull request of this repository.
   */
  bindPull(ticketId: string, url: string): boolean {
    const address = githubAddress(url, this.options.repository)
    if (!address?.pr) return false
    this.options.engine().bindThread(ticketId, { source: SOURCE, id: String(address.number) }, true)
    return true
  }

  /**
   * The Channel: a comment on the Issue or pull request, or a reply in a review thread. A hidden marker keeps a retried send
   * from posting twice. `gone` for a deleted or locked conversation.
   */
  async send(message: OutboundMessage): Promise<'sent' | 'gone'> {
    const number = Number(message.channel.address.number)
    if (!number) throw new Error('Missing GitHub reply target')
    const repo = `repos/${this.options.repository}`
    try {
      const address = githubAddress(message.channel.address.url ?? '', this.options.repository)
      let root: number | undefined
      if (address?.pr && address.discussion && address.number === number) {
        const source = await this.options.gh(['api', `${repo}/pulls/comments/${address.discussion}`])
          .then(text => PostedSchema.parse(JSON.parse(text)), (error: unknown) => { if (error instanceof GhError && error.status === 404) return undefined; throw error })
        root = source ? source.in_reply_to_id ?? source.id : undefined
      }
      const path = root === undefined ? `${repo}/issues/${number}/comments` : `${repo}/pulls/${number}/comments`
      const marker = `<!-- superagent:${message.id} -->`
      const posted = await this.pages(PostedSchema, path)
      if (posted.some(comment => sameName(comment.user?.login ?? '', this.options.login) && (comment.body ?? '').includes(marker))) return 'sent'
      await this.options.gh(['api', root === undefined ? path : `${path}/${root}/replies`, '--method', 'POST', '-f', `body=${message.text}\n\n${marker}`])
      return 'sent'
    } catch (error) {
      if (error instanceof GhError && (error.status === 410 || (error.status === 403 && /locked/i.test(error.message)))) return 'gone'
      throw error
    }
  }

  /** Every page of a list endpoint. */
  private async pages<S extends z.ZodType>(schema: S, path: string): Promise<z.infer<S>[]> {
    const text = await this.options.gh(['api', '--paginate', '--slurp', path])
    const pages = JSON.parse(text || '[]') as unknown[][]
    return pages.flat().flatMap(item => {
      const parsed = schema.safeParse(item)
      return parsed.success ? [parsed.data] : []
    })
  }
}

/** What a poll lets in beyond mentions: per subscribed number and per observed row, the time from which it takes messages. */
interface Taking { following: Map<number, number>; observing: Map<GithubRow, number> }

/** The admission table's row of a Trigger: a new Issue, a new pull request, or a comment of any kind. */
const rowOf = (meta: Record<string, unknown>): GithubRow => meta.kind === 'issue' ? 'issues' : meta.kind === 'pull' ? 'pulls' : 'comments'
/**
 * A review's or an inline comment's Trigger with the comment's own words in `meta.body`: its text starts with the review's
 * decision or the file and diff it is on, and the rules router reads a stop only from what the person wrote.
 */
const withBody = (trigger: Trigger, comment: { body?: string | null }): Trigger => ({ ...trigger, meta: { ...trigger.meta, body: comment.body ?? '' } })
