/** An in-memory GitHub repository behind a fake `gh`, for the GitHub Source tests. */
import type { Gh } from '../src/sources/github.ts'

interface Comment { id: number; number: number; body: string; user: { login: string; type: string }; created_at: string; updated_at: string
  html_url: string; issue_url: string }
interface Issue { number: number; title: string; body: string; user: { login: string; type: string }; state: string; created_at: string
  updated_at: string; html_url: string; pull_request?: { url: string }; merged_at?: string | null; closed_at?: string | null }

export class FakeGitHub {
  readonly issues = new Map<number, Issue>()
  readonly comments: Comment[] = []
  readonly reviews = new Map<number, { id: number; body: string; state: string; user: { login: string; type: string }; submitted_at: string
    html_url: string; commit_id: string }[]>()
  readonly posts: { path: string; body: string }[] = []
  private id = 1000
  constructor(readonly repository: string, readonly agent: string) {}

  private now(): string { return new Date().toISOString() }
  private user(login: string) { return { login, type: login.endsWith('[bot]') ? 'Bot' : 'User' } }

  open(number: number, login: string, title: string, body = '', pr = false): void {
    const kind = pr ? 'pull' : 'issues'
    this.issues.set(number, { number, title, body, user: this.user(login), state: 'open', created_at: this.now(), updated_at: this.now(),
      html_url: `https://github.com/${this.repository}/${kind}/${number}`,
      ...pr ? { pull_request: { url: `https://api.github.com/repos/${this.repository}/pulls/${number}` }, merged_at: null } : {} })
  }
  comment(number: number, login: string, body: string): Comment {
    const issue = this.issues.get(number)!
    const id = ++this.id
    const comment: Comment = { id, number, body, user: this.user(login), created_at: this.now(), updated_at: this.now(),
      html_url: `${issue.html_url}#issuecomment-${id}`, issue_url: `https://api.github.com/repos/${this.repository}/issues/${number}` }
    this.comments.push(comment)
    return comment
  }
  merge(number: number): void {
    const pull = this.issues.get(number)!
    Object.assign(pull, { state: 'closed', merged_at: this.now(), closed_at: this.now() })
  }

  readonly gh: Gh = async args => {
    if (args[0] !== 'api') throw new Error(`unexpected gh ${args.join(' ')}`)
    const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET'
    const path = args.find(arg => arg.startsWith('repos/'))!
    const [route, query = ''] = path.replace(`repos/${this.repository}/`, '').split('?')
    const since = new URLSearchParams(query).get('since') ?? ''
    const slurp = (items: unknown[]) => JSON.stringify([items])
    if (method === 'POST') {
      const body = args[args.indexOf('-f') + 1]!.replace(/^body=/, '')
      this.posts.push({ path: route!, body })
      const number = Number(/issues\/(\d+)\/comments/.exec(route!)?.[1])
      if (number) this.comment(number, this.agent, body)
      return '{}'
    }
    let match: RegExpExecArray | null
    if (route === 'issues/comments') return slurp(this.comments.filter(comment => comment.updated_at >= since))
    if (route === 'pulls/comments') return slurp([])
    if (route === 'issues') return slurp([...this.issues.values()].filter(issue => issue.updated_at >= since))
    if ((match = /^issues\/(\d+)\/comments$/.exec(route!))) return slurp(this.comments.filter(comment => comment.number === Number(match![1])))
    if ((match = /^pulls\/(\d+)\/reviews$/.exec(route!))) return slurp(this.reviews.get(Number(match[1])) ?? [])
    if ((match = /^pulls\/(\d+)$/.exec(route!))) return JSON.stringify(this.issues.get(Number(match[1])))
    throw new Error(`gh: HTTP 404 ${route}`)
  }
}
