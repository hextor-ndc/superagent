/**
 * An in-memory GitHub repository behind a fake `gh`, for the GitHub Source tests and the Phase 4 workload: Issues, pull
 * requests, conversation comments, reviews, inline review comments, bot accounts, comment edits, merges and closes.
 */
import { GhError, type Gh } from '../src/sources/github.ts'

type User = { login: string; type: string }
export interface Comment { id: number; number: number; body: string; user: User; created_at: string; updated_at: string
  html_url: string; issue_url: string }
interface ReviewComment { id: number; number: number; body: string; user: User; created_at: string; updated_at: string; html_url: string
  pull_request_url: string; path: string; line: number; diff_hunk: string; in_reply_to_id?: number }
interface Review { id: number; body: string; state: string; user: User; submitted_at: string; html_url: string; commit_id: string }
interface Issue { id: number; number: number; title: string; body: string; user: User; state: string; created_at: string
  updated_at: string; html_url: string; pull_request?: { url: string }; merged_at?: string | null; closed_at?: string | null }

export class FakeGitHub {
  readonly issues = new Map<number, Issue>()
  readonly comments: Comment[] = []
  /** Inline comments on pull request diffs (`pulls/comments`). */
  readonly reviewComments: ReviewComment[] = []
  readonly reviews = new Map<number, Review[]>()
  readonly posts: { path: string; body: string }[] = []
  private id = 1000
  private last = 0
  constructor(readonly repository: string, readonly agent: string) {}

  /** Strictly increasing timestamps, so an edit made in the same millisecond as its comment still changes `updated_at`. */
  private now(): string {
    this.last = Math.max(Date.now(), this.last + 1)
    return new Date(this.last).toISOString()
  }
  private user(login: string): User { return { login, type: login.endsWith('[bot]') ? 'Bot' : 'User' } }
  private pull(number: number): Issue {
    const pull = this.issues.get(number)
    if (!pull?.pull_request) throw new Error(`#${number} is not a pull request`)
    return pull
  }

  open(number: number, login: string, title: string, body = '', pr = false): void {
    const kind = pr ? 'pull' : 'issues'
    const at = this.now()
    // GitHub gives an Issue an `id` of its own beside its number; the Source's schema needs it.
    this.issues.set(number, { id: ++this.id, number, title, body, user: this.user(login), state: 'open', created_at: at, updated_at: at,
      html_url: `https://github.com/${this.repository}/${kind}/${number}`,
      ...pr ? { pull_request: { url: `https://api.github.com/repos/${this.repository}/pulls/${number}` }, merged_at: null } : {} })
  }
  /** Moves an Issue's or pull request's creation `ms` into the past, as if it had been opened that much earlier. */
  backdate(number: number, ms: number): void {
    const issue = this.issues.get(number)
    if (!issue) throw new Error(`No issue #${number}`)
    const at = new Date(Date.parse(issue.created_at) - ms).toISOString()
    Object.assign(issue, { created_at: at, updated_at: at })
  }
  /** Moves a conversation or inline comment `ms` into the past, as if it had been written that much earlier. */
  backdateComment(commentId: number, ms: number): void {
    const comment = this.comments.find(item => item.id === commentId) ?? this.reviewComments.find(item => item.id === commentId)
    if (!comment) throw new Error(`No comment ${commentId}`)
    const at = new Date(Date.parse(comment.created_at) - ms).toISOString()
    Object.assign(comment, { created_at: at, updated_at: at })
  }
  comment(number: number, login: string, body: string): Comment {
    const issue = this.issues.get(number)
    if (!issue) throw new Error(`No issue #${number}`)
    const id = ++this.id
    const at = this.now()
    const comment: Comment = { id, number, body, user: this.user(login), created_at: at, updated_at: at,
      html_url: `${issue.html_url}#issuecomment-${id}`, issue_url: `https://api.github.com/repos/${this.repository}/issues/${number}` }
    this.comments.push(comment)
    return comment
  }
  /** A submitted review of a pull request, such as `CHANGES_REQUESTED` or `APPROVED`. */
  review(number: number, login: string, state: string, body: string): Review {
    const pull = this.pull(number)
    const id = ++this.id
    const review: Review = { id, body, state, user: this.user(login), submitted_at: this.now(), html_url: `${pull.html_url}#pullrequestreview-${id}`,
      commit_id: `c0ffee${id}` }
    this.reviews.set(number, [...this.reviews.get(number) ?? [], review])
    return review
  }
  /** An inline comment on a pull request's diff. */
  reviewComment(number: number, login: string, body: string, path = 'README.md', line = 1): ReviewComment {
    const pull = this.pull(number)
    const id = ++this.id
    const at = this.now()
    const comment: ReviewComment = { id, number, body, user: this.user(login), created_at: at, updated_at: at, html_url: `${pull.html_url}#discussion_r${id}`,
      pull_request_url: `https://api.github.com/repos/${this.repository}/pulls/${number}`, path, line, diff_hunk: `@@ -1 +1 @@\n-# widgets\n+# Widgets` }
    this.reviewComments.push(comment)
    return comment
  }
  /** Edits a conversation or inline comment; GitHub moves its `updated_at`. */
  edit(commentId: number, body: string): void {
    const comment = this.comments.find(item => item.id === commentId) ?? this.reviewComments.find(item => item.id === commentId)
    if (!comment) throw new Error(`No comment ${commentId}`)
    Object.assign(comment, { body, updated_at: this.now() })
  }
  merge(number: number): void {
    const pull = this.issues.get(number)!
    const at = this.now()
    Object.assign(pull, { state: 'closed', merged_at: at, closed_at: at, updated_at: at })
  }
  /** Closes an Issue or a pull request without merging it. */
  close(number: number): void {
    const issue = this.issues.get(number)!
    const at = this.now()
    Object.assign(issue, { state: 'closed', closed_at: at, updated_at: at, ...issue.pull_request ? { merged_at: null } : {} })
  }

  readonly gh: Gh = async args => {
    if (args[0] !== 'api') throw new Error(`unexpected gh ${args.join(' ')}`)
    const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET'
    const path = args.find(arg => arg.startsWith('repos/'))!
    const [route = '', query = ''] = path.replace(`repos/${this.repository}/`, '').split('?')
    const since = new URLSearchParams(query).get('since') ?? ''
    const slurp = (items: unknown[]) => JSON.stringify([items])
    let match: RegExpExecArray | null
    if (method === 'POST') {
      const body = args[args.indexOf('-f') + 1]!.replace(/^body=/, '')
      this.posts.push({ path: route, body })
      if ((match = /^issues\/(\d+)\/comments$/.exec(route))) this.comment(Number(match[1]), this.agent, body)
      else if ((match = /^pulls\/(\d+)\/comments\/(\d+)\/replies$/.exec(route))) {
        const reply = this.reviewComment(Number(match[1]), this.agent, body)
        reply.in_reply_to_id = Number(match[2])
      }
      return '{}'
    }
    if (route === 'issues/comments') return slurp(this.comments.filter(comment => comment.updated_at >= since))
    if (route === 'pulls/comments') return slurp(this.reviewComments.filter(comment => comment.updated_at >= since))
    if (route === 'issues') return slurp([...this.issues.values()].filter(issue => issue.updated_at >= since))
    if ((match = /^issues\/(\d+)\/comments$/.exec(route))) return slurp(this.comments.filter(comment => comment.number === Number(match![1])))
    if ((match = /^pulls\/comments\/(\d+)$/.exec(route))) {
      const comment = this.reviewComments.find(item => item.id === Number(match![1]))
      if (!comment) throw new GhError(`gh: HTTP 404 ${route}`, 404)
      return JSON.stringify(comment)
    }
    if ((match = /^pulls\/(\d+)\/comments$/.exec(route))) return slurp(this.reviewComments.filter(comment => comment.number === Number(match![1])))
    if ((match = /^pulls\/(\d+)\/reviews$/.exec(route))) return slurp(this.reviews.get(Number(match[1])) ?? [])
    if ((match = /^pulls\/(\d+)$/.exec(route)) && this.issues.get(Number(match[1]))?.pull_request) return JSON.stringify(this.issues.get(Number(match[1])))
    throw new GhError(`gh: HTTP 404 ${route}`, 404)
  }
}
