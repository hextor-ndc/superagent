/** An in-memory t3code for tests: threads, runs and the calls the super agent made. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LaunchInput, LaunchResult, ProjectSummary, ScratchLaunchInput, SendResult, T3Client, T3Status, ThreadRead, WaitResult }
  from '../src/t3/client.ts'

interface FakeThread {
  id: string; title: string; link: string; worktreePath: string | null; branch: string | null; pinned: boolean
  runs: { id: string; status: T3Status }[]
  messages: { id: string; text: string; clientRequestId: string }[]
  pullRequests: string[]
}

export class FakeT3 implements T3Client {
  readonly threads = new Map<string, FakeThread>()
  readonly calls: { tool: string; args: unknown }[] = []
  private readonly requests = new Map<string, unknown>()
  private seq = 0
  constructor(readonly projects: ProjectSummary[]) {}

  private id(prefix: string) { return `${prefix}-${++this.seq}` }
  private once<T>(key: string, make: () => T): T {
    if (!this.requests.has(key)) this.requests.set(key, make())
    return this.requests.get(key) as T
  }
  private thread(id: string): FakeThread {
    const thread = this.threads.get(id)
    if (!thread) throw new Error(`thread_not_found ${id}`)
    return thread
  }

  async listProjects() { this.calls.push({ tool: 't3_project_list', args: {} }); return this.projects }
  async launch(input: LaunchInput): Promise<LaunchResult> {
    this.calls.push({ tool: 't3_thread_launch', args: input })
    return this.once(input.clientRequestId, () => this.create(input.title, input.worktreePath, input.branch ?? null, input.message, input.clientRequestId))
  }
  async launchScratch(input: ScratchLaunchInput): Promise<LaunchResult> {
    this.calls.push({ tool: 't3_thread_launch', args: { scratch: true, ...input } })
    return this.once(input.clientRequestId, () => this.create(input.title, mkdtempSync(join(tmpdir(), 'scratch-')), null, input.message, input.clientRequestId))
  }
  private create(title: string, worktreePath: string | null, branch: string | null, message: string | undefined, requestId: string): LaunchResult {
    const thread: FakeThread = { id: this.id('thread'), title, link: '', worktreePath, branch, pinned: false, runs: [], messages: [], pullRequests: [] }
    thread.link = `https://app.t3.codes/thread/${thread.id}`
    this.threads.set(thread.id, thread)
    let runId: string | null = null
    if (message) {
      runId = this.id('run')
      thread.runs.push({ id: runId, status: 'running' })
      thread.messages.push({ id: this.id('message'), text: message, clientRequestId: requestId })
    }
    return { threadId: thread.id, link: thread.link, runId, status: runId ? 'running' : null }
  }
  async send(threadId: string, message: string, clientRequestId: string, mode = 'auto'): Promise<SendResult> {
    this.calls.push({ tool: 't3_thread_send', args: { threadId, message, clientRequestId, mode } })
    return this.once(`send:${clientRequestId}`, () => {
      const thread = this.thread(threadId)
      const active = thread.runs.at(-1)?.status === 'running' ? thread.runs.at(-1)! : undefined
      const run = active ?? { id: this.id('run'), status: 'running' as T3Status }
      if (!active) thread.runs.push(run)
      const id = this.id('message')
      thread.messages.push({ id, text: message, clientRequestId })
      return { messageId: id, runId: run.id, delivery: active ? 'steered' : 'started', status: 'running' } satisfies SendResult
    })
  }
  async wait(threadId: string, timeoutMs: number): Promise<WaitResult> {
    const run = this.thread(threadId).runs.at(-1)
    if (!run) return { runId: null, status: 'idle', timedOut: false }
    if (run.status !== 'running') return { runId: run.id, status: run.status, timedOut: false }
    await new Promise(resolve => setTimeout(resolve, Math.min(timeoutMs, 10)))
    return { runId: run.id, status: run.status, timedOut: run.status === 'running' }
  }
  async read(threadId: string): Promise<ThreadRead> {
    const thread = this.thread(threadId)
    const latest = thread.runs.at(-1)
    return {
      thread: { threadId, title: thread.title, link: thread.link, status: latest?.status ?? 'idle', activeRunId: latest?.status === 'running' ? latest.id : null,
        latestRunId: latest?.id ?? null, worktreePath: thread.worktreePath, branch: thread.branch, settled: false, archived: false },
      items: thread.messages.map((message, position) => ({ position, itemId: message.id, runId: null, messageId: message.id, type: 'user_message',
        text: message.text, createdBy: null })),
      nextPosition: null,
    }
  }
  async interrupt(threadId: string, options: { stop?: boolean; reason?: string; clientRequestId: string }) {
    this.calls.push({ tool: 't3_thread_interrupt', args: { threadId, ...options } })
    const run = this.thread(threadId).runs.at(-1)
    if (run?.status === 'running') run.status = 'interrupted'
  }
  async organize(threadId: string, action: string) {
    this.calls.push({ tool: 't3_thread_organize', args: { threadId, action } })
    if (action === 'pin') this.thread(threadId).pinned = true
  }
  async linkPullRequests(threadId: string, urls: string[]) {
    this.calls.push({ tool: 'link_pull_requests', args: { threadId, urls } })
    this.thread(threadId).pullRequests.push(...urls)
  }
  async close() {}

  /** The agent of a thread finishes its turn. */
  finishRun(threadId: string, status: T3Status = 'completed'): void {
    const run = this.thread(threadId).runs.at(-1)
    if (run) run.status = status
  }
  workerThreads(): FakeThread[] { return [...this.threads.values()].filter(thread => thread.title.startsWith('[T-')) }
}
