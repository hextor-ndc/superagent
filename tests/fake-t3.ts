/** An in-memory t3code for tests: threads, runs and the calls the super agent made. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'
import { T3Error, type LaunchInput, type LaunchResult, type PendingRequest, type ProjectSummary, type ScratchLaunchInput, type SendResult, type T3Client,
  type T3Status, type ThreadRead, type WaitResult } from '../src/t3/client.ts'

interface FakeThread {
  id: string; title: string; link: string
  /** The project the thread was launched in; for a scratch thread, the scratch project (`SCRATCH_PROJECT`). */
  projectId: string | null
  worktreePath: string | null; branch: string | null; pinned: boolean
  runs: { id: string; status: T3Status }[]
  messages: { id: string; text: string; clientRequestId: string }[]
  pullRequests: string[]
  pending: PendingRequest[]
}

/**
 * The scratch folders of every FakeT3 in this module, removed after the spec file (and, failing that, when the process
 * exits), so a test that never closes its FakeT3 leaves nothing behind. The Runtime writes the console's and the
 * Watchdog's MCP configuration into a scratch thread's folder, so the folder has to exist while the test runs.
 */
const scratchRoots = new Set<string>()
/** Removes the scratch folders of every FakeT3 made by this module, closed or not. */
export function removeAllScratch(): void { for (const dir of scratchRoots) removeScratch(dir) }
afterAll(removeAllScratch)
process.once('exit', removeAllScratch)
function removeScratch(dir: string): void {
  scratchRoots.delete(dir)
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) } catch { /* left for the OS to clear */ }
}

/**
 * The id of t3code's scratch project. t3code 0.1.6 makes it, titled "No project", at its first scratch launch, with the
 * folder that holds the scratch threads' folders as its root, and lists it in `t3_project_list` from then on.
 */
export const SCRATCH_PROJECT = 'p-scratch'

export interface FakeT3Options {
  /**
   * Refuse launches the way t3code 0.1.6 does (tests/live/contract.spec.ts, "t3code with several projects"): an unknown
   * project id, and a worktree path that is not in `git worktree list` of the project's root after resolving symlinks, with
   * `T3Error('t3_thread_launch', 'invalid_request')`. A worktree of another repository is refused by the same rule; one of
   * the same repository is accepted, as t3code accepts it. Left unset, launches take any project and path, as before;
   * `harness()` turns it on for a FakeT3 that does not set it.
   */
  checkWorktrees?: boolean
}

export class FakeT3 implements T3Client {
  readonly threads = new Map<string, FakeThread>()
  readonly calls: { tool: string; args: unknown }[] = []
  /** Threads whose pending requests were read, in order: the executor and the Runtime look at them on timers. */
  readonly pendingReads: string[] = []
  /** The next this many pending-request reads fail, as when t3code is unreachable. */
  failPendingReads = 0
  private readonly requests = new Map<string, unknown>()
  private seq = 0
  /** One temporary folder per FakeT3, made on the first scratch launch, that holds a folder for each scratch thread. */
  private scratchRoot?: string
  /** See `FakeT3Options.checkWorktrees`; `harness()` sets it when it is undefined. */
  checkWorktrees: boolean | undefined
  constructor(readonly projects: ProjectSummary[], options: FakeT3Options = {}) { this.checkWorktrees = options.checkWorktrees }

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

  /** A copy, so a caller that keeps the list does not see later `addProject` and `removeProject` calls. */
  async listProjects() { this.calls.push({ tool: 't3_project_list', args: {} }); return this.projects.map(project => ({ ...project })) }
  /**
   * Registers a project, as Hector adding a folder in t3code would. A known id is refused, and so is a root already
   * registered, compared as t3code 0.1.6 compares it (contract.spec.ts, "refuses a registered root again"): trailing slashes
   * dropped, symlinks not followed. So a symlinked form of a registered root becomes a second project for the same folder.
   */
  addProject(project: ProjectSummary): void {
    if (this.projects.some(known => known.id === project.id)) throw new Error(`project ${project.id} exists`)
    const root = (path: string) => path.replace(/(?<=.)\/+$/, '')
    if (this.projects.some(known => root(known.workspaceRoot) === root(project.workspaceRoot))) {
      throw new Error('invalid_request The workspace is already registered to a project.')
    }
    this.projects.push({ ...project })
  }
  /** Removes a project from the list. Its threads stay and keep their projectId; with `checkWorktrees`, new launches in it are refused. */
  removeProject(id: string): void {
    const index = this.projects.findIndex(project => project.id === id)
    if (index < 0) throw new Error(`no project ${id}`)
    this.projects.splice(index, 1)
  }
  async launch(input: LaunchInput): Promise<LaunchResult> {
    this.calls.push({ tool: 't3_thread_launch', args: input })
    // A replay of an answered clientRequestId gets the stored thread whatever its path says, but t3code 0.1.6 still refuses it
    // when the project id is not listed (contract.spec.ts, probe 1).
    if (this.checkWorktrees && this.requests.has(input.clientRequestId) && !this.projects.some(known => known.id === input.projectId)) {
      throw new T3Error('t3_thread_launch', 'orchestration_error', 'The operation could not be completed.')
    }
    // A refusal stores nothing under the clientRequestId, so a retry is checked again.
    return this.once(input.clientRequestId, () => {
      if (this.checkWorktrees) this.checkLaunch(input)
      return this.create(input.projectId, input.title, input.worktreePath, input.branch ?? null, input.message, input.clientRequestId)
    })
  }
  /** What t3code checks before it accepts an `existing_worktree` launch; see `FakeT3Options.checkWorktrees`. */
  private checkLaunch(input: LaunchInput): void {
    const project = this.projects.find(known => known.id === input.projectId)
    if (!project) throw new T3Error('t3_thread_launch', 'invalid_request', 'The project was not found.')
    const refuse = () => new T3Error('t3_thread_launch', 'invalid_request', 'worktreePath must be one of the project\'s git worktrees. t3_worktree_list shows them.')
    let path: string, listed: string
    try {
      path = realpathSync(input.worktreePath)
      listed = execFileSync('git', ['-C', project.workspaceRoot, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    } catch { throw refuse() }
    const worktrees = listed.split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length))
    if (!worktrees.includes(path)) throw refuse()
  }
  async launchScratch(input: ScratchLaunchInput): Promise<LaunchResult> {
    this.calls.push({ tool: 't3_thread_launch', args: { scratch: true, ...input } })
    return this.once(input.clientRequestId, () => {
      const root = this.scratch()
      const known = this.projects.find(project => project.id === SCRATCH_PROJECT)
      if (!known) this.projects.push({ id: SCRATCH_PROJECT, title: 'No project', workspaceRoot: root })
      else known.workspaceRoot = root
      return this.create(SCRATCH_PROJECT, input.title, mkdtempSync(join(root, 'thread-')), null, input.message, input.clientRequestId)
    })
  }
  private scratch(): string {
    if (!this.scratchRoot) scratchRoots.add(this.scratchRoot = mkdtempSync(join(tmpdir(), 'fake-t3-scratch-')))
    return this.scratchRoot
  }
  private create(projectId: string | null, title: string, worktreePath: string | null, branch: string | null, message: string | undefined,
    requestId: string): LaunchResult {
    const thread: FakeThread = { id: this.id('thread'), title, link: '', projectId, worktreePath, branch, pinned: false, runs: [], messages: [], pullRequests: [],
      pending: [] }
    thread.link = `https://app.t3.codes/thread/${thread.id}`
    this.threads.set(thread.id, thread)
    let runId: string | null = null
    if (message) {
      runId = this.id('run')
      thread.runs.push({ id: runId, status: 'running' })
      thread.messages.push({ id: this.id('message'), text: message, clientRequestId: requestId })
    }
    return { threadId: thread.id, link: thread.link, ...projectId ? { projectId } : {}, runId, status: runId ? 'running' : null }
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
      thread: { threadId, projectId: thread.projectId, title: thread.title, link: thread.link, status: latest?.status ?? 'idle', activeRunId: latest?.status === 'running' ? latest.id : null,
        latestRunId: latest?.id ?? null, worktreePath: thread.worktreePath, branch: thread.branch, settled: false, archived: false,
        pendingRequestCount: thread.pending.length },
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
  async pendingRequests(threadId: string): Promise<PendingRequest[]> {
    this.pendingReads.push(threadId)
    if (this.failPendingReads > 0) { this.failPendingReads--; throw new T3Error('t3_thread_read', 'network', 'fetch failed') }
    return [...this.thread(threadId).pending]
  }
  async answerQuestion(threadId: string, requestId: string, answers: Record<string, string | string[]>) {
    this.calls.push({ tool: 't3_pending_request', args: { action: 'respond', threadId, requestId, answers } })
    const thread = this.thread(threadId)
    const index = thread.pending.findIndex(request => request.kind === 'question' && request.requestId === requestId)
    if (index < 0) throw new Error(`invalid_request The pending user-input request was not found.`)
    thread.pending.splice(index, 1)
  }
  /** Removes the scratch threads' folders. A scratch launch after this makes a new folder; the earlier threads keep their removed paths. */
  async close() {
    if (this.scratchRoot) removeScratch(this.scratchRoot)
    this.scratchRoot = undefined
  }

  /** The agent of a thread finishes its turn. */
  finishRun(threadId: string, status: T3Status = 'completed'): void {
    const run = this.thread(threadId).runs.at(-1)
    if (run) run.status = status
  }
  workerThreads(): FakeThread[] { return [...this.threads.values()].filter(thread => thread.title.startsWith('[T-')) }
}
