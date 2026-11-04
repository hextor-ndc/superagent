/**
 * The one module that talks to t3code. Only t3code's documented outside-agent surface is used: the `/mcp` tools, called
 * with an `mcp-client` bearer token. See PLAN.md, "Ground rules".
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

/** A run's status as t3code reports it (`OrchestrationV2RunStatus`), plus `idle` for a thread with no run. */
export type T3Status = 'idle' | 'preparing' | 'queued' | 'starting' | 'running' | 'waiting' | 'completed' | 'interrupted' | 'failed'
  | 'cancelled' | 'rolled_back'
/** Statuses after which a run does no more work. */
export const TERMINAL: ReadonlySet<T3Status> = new Set(['idle', 'completed', 'interrupted', 'failed', 'cancelled', 'rolled_back'])

export interface LaunchInput {
  projectId: string
  title: string
  message: string
  /** A worktree of the project's checkout, already prepared (`existing_worktree`). */
  worktreePath: string
  branch?: string
  runtimeMode?: string
  clientRequestId: string
}
/** `projectId` is the thread's project; for a scratch thread, t3code's scratch project ("No project"), which it lists from then on. */
export interface LaunchResult { threadId: string; link?: string; projectId?: string; runId: string | null; status: T3Status | null }
export interface ScratchLaunchInput { title: string; message?: string; clientRequestId: string }
export interface SendResult { messageId: string; runId: string; delivery: 'started' | 'queued' | 'steered' | 'restarted'; status: T3Status }
export interface WaitResult { runId: string | null; status: T3Status; timedOut: boolean }
export interface TimelineItem {
  position: number; itemId: string; runId: string | null; messageId: string | null; type: string; text: string | null
  createdBy: unknown
  /** For activity items such as `approval_request`: `waiting` while a person has not answered. */
  status?: string
}
export interface ThreadRead {
  thread: { threadId: string; projectId?: string | null; title: string; link?: string; status: T3Status; activeRunId: string | null; latestRunId: string | null
    worktreePath: string | null; branch: string | null; settled: boolean; archived: boolean
    /** Approvals and questions that wait for a person, of every kind. */
    pendingRequestCount?: number
    /** The provider instance, model and runtime mode the thread runs with. */
    providerInstanceId?: string; model?: string; runtimeMode?: string }
  items: TimelineItem[]
  /** The last item's position, to pass as `afterPosition`; t3code sets it on the last page too, so `hasMore` says whether to go on. */
  nextPosition: number | null
  hasMore?: boolean
}
export interface ProjectSummary { id: string; title?: string; workspaceRoot: string }
export interface PendingQuestion {
  id: string; header: string; question: string; options: { label: string; description: string; value?: string }[]
  multiSelect?: boolean; allowCustomAnswer?: boolean; required?: boolean
}
/**
 * Something a thread's agent waits on a person for. An approval can only be answered in t3code itself: `/mcp` has no tool
 * that grants one. A question can be answered with `answerQuestion`.
 */
export type PendingRequest =
  | { kind: 'approval'; requestId: string; text: string }
  | { kind: 'question'; requestId: string; questions: PendingQuestion[] }

/** What the super agent needs from t3code. Tests use an in-memory implementation; production uses `McpT3Client`. */
export interface T3Client {
  listProjects(): Promise<ProjectSummary[]>
  launch(input: LaunchInput): Promise<LaunchResult>
  /** A thread without a project, such as the Superagent console. */
  launchScratch(input: ScratchLaunchInput): Promise<LaunchResult>
  send(threadId: string, message: string, clientRequestId: string, mode?: 'auto' | 'queue' | 'steer' | 'restart'): Promise<SendResult>
  wait(threadId: string, timeoutMs: number, runId?: string): Promise<WaitResult>
  read(threadId: string, options?: { afterPosition?: number; limit?: number; view?: 'messages' | 'activity' }): Promise<ThreadRead>
  interrupt(threadId: string, options: { stop?: boolean; reason?: string; clientRequestId: string }): Promise<void>
  organize(threadId: string, action: 'pin' | 'unpin' | 'settle' | 'unsettle' | 'archive' | 'unarchive' | 'mark_unread'): Promise<void>
  linkPullRequests(threadId: string, urls: string[]): Promise<void>
  /** The thread's pending approvals and questions; empty when it waits for no one. */
  pendingRequests(threadId: string): Promise<PendingRequest[]>
  /** Answers a pending question, keyed by question id. */
  answerQuestion(threadId: string, requestId: string, answers: Record<string, string | string[]>): Promise<void>
  close(): Promise<void>
}

/** A failure t3code returned, with its `OrchestratorMcpFailure` code when it gave one. */
export class T3Error extends Error {
  constructor(readonly tool: string, readonly code: string, message: string) { super(`${tool}: ${code}: ${message}`) }
  /** Network and server failures worth retrying; refusals such as `invalid_request` are not. */
  get transient(): boolean { return this.code === 'network' || this.code === 'orchestration_error' || this.code === 'provider_unavailable' }
}

export interface McpT3ClientOptions {
  /** The environment's MCP endpoint, such as `http://127.0.0.1:3773/mcp`. */
  url: string
  /** An `mcp-client` bearer token (PLAN.md, point 5). */
  token: string
  /** Sent with every launch; t3code refuses a launch without one when the project has no default model. */
  modelSelection?: { instanceId: string; model: string }
  fetch?: typeof fetch
}

export class McpT3Client implements T3Client {
  private client?: Promise<Client>
  constructor(private readonly options: McpT3ClientOptions) {}

  private connect(): Promise<Client> {
    this.client ??= (async () => {
      const client = new Client({ name: 'superagent-t3', version: '0.1.0' })
      const transport = new StreamableHTTPClientTransport(new URL(this.options.url), {
        requestInit: { headers: { authorization: `Bearer ${this.options.token}` } },
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      })
      await client.connect(transport)
      return client
    })().catch(error => { this.client = undefined; throw error })
    return this.client
  }

  /** Calls one tool and returns its structured result; a returned failure becomes a `T3Error`. */
  async call<T>(tool: string, args: Record<string, unknown>): Promise<T> {
    let result: ToolResult & { isError?: unknown }
    for (let attempt = 0; ; attempt++) {
      const connection = this.connect()
      try { result = await (await connection).callTool({ name: tool, arguments: args }) as ToolResult & { isError?: unknown }; break }
      catch (error) {
        // A concurrent call may have reconnected already; only drop the connection this call used.
        if (this.client === connection) this.client = undefined
        const message = error instanceof Error ? error.message : String(error)
        // t3code keeps MCP sessions in memory, so after it restarts it answers the old session id with HTTP 404. The request did
        // nothing then, so it goes once more on a new session, and a second 404 is still worth retrying later. A 404 to the
        // session's start means the URL is wrong.
        if (httpStatus(error) === 404) {
          if (!await connection.then(() => true, () => false)) throw new T3Error(tool, 'http_404', message)
          if (attempt === 0) continue
          throw new T3Error(tool, 'network', message)
        }
        throw new T3Error(tool, refusal(error) ?? 'network', message)
      }
    }
    const payload = structured(result)
    if (result.isError) {
      const failure = payload as { code?: string; message?: string } | undefined
      throw new T3Error(tool, failure?.code ?? 'error', failure?.message ?? textOf(result) ?? 'failed')
    }
    return payload as T
  }

  /** Reads every page: t3code returns at most 20 projects per call, with `nextCursor` for the rest. */
  async listProjects(): Promise<ProjectSummary[]> {
    const projects: ProjectSummary[] = []
    let cursor: number | null | undefined
    do {
      const result = await this.call<{ projects: { id: string; title?: string; workspaceRoot: string }[]; nextCursor?: number | null }>(
        't3_project_list', cursor == null ? {} : { cursor })
      projects.push(...result.projects.map(project => ({ id: project.id, title: project.title, workspaceRoot: project.workspaceRoot })))
      cursor = result.nextCursor
    } while (cursor != null)
    return projects
  }
  launch(input: LaunchInput): Promise<LaunchResult> {
    return this.call('t3_thread_launch', {
      projectId: input.projectId, title: input.title, message: input.message, clientRequestId: input.clientRequestId,
      workspaceStrategy: { type: 'existing_worktree', worktreePath: input.worktreePath, ...(input.branch ? { branch: input.branch } : {}) },
      ...(input.runtimeMode ? { runtimeMode: input.runtimeMode } : {}),
      ...this.model(),
    })
  }
  launchScratch(input: ScratchLaunchInput): Promise<LaunchResult> {
    return this.call('t3_thread_launch', { scratch: true, title: input.title, clientRequestId: input.clientRequestId,
      ...(input.message ? { message: input.message } : {}), ...this.model() })
  }
  private model(): { modelSelection?: { instanceId: string; model: string } } {
    return this.options.modelSelection ? { modelSelection: this.options.modelSelection } : {}
  }
  send(threadId: string, message: string, clientRequestId: string, mode: 'auto' | 'queue' | 'steer' | 'restart' = 'auto'): Promise<SendResult> {
    return this.call('t3_thread_send', { threadId, message, clientRequestId, mode })
  }
  wait(threadId: string, timeoutMs: number, runId?: string): Promise<WaitResult> {
    return this.call('t3_thread_wait', { threadId, timeoutMs, ...(runId ? { runId } : {}) })
  }
  read(threadId: string, options: { afterPosition?: number; limit?: number; view?: 'messages' | 'activity' } = {}): Promise<ThreadRead> {
    return this.call('t3_thread_read', { threadId, maxCharsPerItem: 4000, ...options })
  }
  async interrupt(threadId: string, options: { stop?: boolean; reason?: string; clientRequestId: string }): Promise<void> {
    await this.call('t3_thread_interrupt', { threadId, ...options })
  }
  async organize(threadId: string, action: 'pin' | 'unpin' | 'settle' | 'unsettle' | 'archive' | 'unarchive' | 'mark_unread'): Promise<void> {
    await this.call('t3_thread_organize', { threadId, action })
  }
  /** t3code 0.1.6 has `link_pull_request`, one URL per call; there is no `link_pull_requests`. */
  async linkPullRequests(threadId: string, urls: string[]): Promise<void> {
    for (const url of urls) await this.call('link_pull_request', { threadId, url })
  }
  /**
   * `t3_pending_request` lists only questions, so approvals are found in the activity view: an `approval_request` item that
   * is still `waiting`, whose request id is the end of its item id.
   */
  async pendingRequests(threadId: string): Promise<PendingRequest[]> {
    const count = (await this.read(threadId, { limit: 1 })).thread.pendingRequestCount ?? 0
    if (count === 0) return []
    const { requestIds } = await this.call<{ requestIds: string[] }>('t3_pending_request', { action: 'list', threadId })
    const pending: PendingRequest[] = []
    for (const requestId of requestIds) {
      const read = await this.call<{ questions: PendingQuestion[] }>('t3_pending_request', { action: 'read', threadId, requestId })
      pending.push({ kind: 'question', requestId, questions: read.questions })
    }
    if (pending.length >= count) return pending
    // t3_thread_read pages only forward from the oldest item, so the scan starts where the last one found a waiting approval,
    // and goes back to the start only when that finds too few.
    const from = this.approvalScanFrom.get(threadId)
    let approvals = await this.waitingApprovals(threadId, from, count - pending.length)
    if (approvals.length < count - pending.length && from !== undefined) approvals = await this.waitingApprovals(threadId, undefined, count - pending.length)
    const oldest = approvals[0]?.position
    if (oldest === undefined || oldest === 0) this.approvalScanFrom.delete(threadId)
    else this.approvalScanFrom.set(threadId, oldest - 1)
    return [...pending, ...approvals.map(({ position: _, ...approval }) => approval)]
  }
  /** Where to resume looking for a thread's waiting approvals: the `afterPosition` before the oldest one last found. */
  private readonly approvalScanFrom = new Map<string, number>()
  /** Waiting `approval_request` items after `afterPosition`, read page by page until `wanted` are found or the thread ends. */
  private async waitingApprovals(threadId: string, afterPosition: number | undefined, wanted: number) {
    const found: (PendingRequest & { kind: 'approval'; position: number })[] = []
    for (;;) {
      const read = await this.read(threadId, { view: 'activity', limit: 100, ...afterPosition === undefined ? {} : { afterPosition } })
      for (const item of read.items) {
        if (item.type !== 'approval_request' || item.status !== 'waiting' || !item.itemId.startsWith(APPROVAL_ITEM)) continue
        found.push({ kind: 'approval', requestId: decodeURIComponent(item.itemId.slice(APPROVAL_ITEM.length)), text: item.text ?? 'approval',
          position: item.position })
      }
      // A page that does not move forward would loop for ever.
      if (found.length >= wanted || read.hasMore === false || read.nextPosition == null || read.nextPosition === afterPosition) return found
      afterPosition = read.nextPosition
    }
  }
  async answerQuestion(threadId: string, requestId: string, answers: Record<string, string | string[]>): Promise<void> {
    await this.call('t3_pending_request', { action: 'respond', threadId, requestId, answers })
  }
  async close(): Promise<void> {
    const client = await this.client?.catch(() => undefined)
    this.client = undefined
    await client?.close()
  }
}

/**
 * The code of an HTTP refusal that retrying cannot help, such as `invalid_mcp_credential` for a bad or expired token (HTTP 401)
 * or a JSON-RPC error for a malformed request (HTTP 400). Undefined for failures worth retrying, which become `network`: no
 * HTTP answer, 5xx, 408 and 429. `call` handles 404 itself.
 */
function refusal(error: unknown): string | undefined {
  const status = httpStatus(error)
  if (status === undefined || status < 400 || status >= 500 || status === 408 || status === 429) return undefined
  const body = /\{.*\}/s.exec(error instanceof Error ? error.message : '')?.[0]
  // t3code's OAuth refusals carry a string `error`; its JSON-RPC refusals carry an object there, whose text is in the message.
  try { const code = (JSON.parse(body ?? '') as { error?: unknown }).error; if (typeof code === 'string' && code) return code } catch { /* not JSON */ }
  return `http_${status}`
}
/** The HTTP status of a failed MCP transport request (`StreamableHTTPError.code`), when there was an answer. */
function httpStatus(error: unknown): number | undefined {
  const status = (error as { code?: unknown } | undefined)?.code
  return typeof status === 'number' && status > 0 ? status : undefined
}

/** t3code's item id for a runtime request is this prefix and the URI-encoded request id. */
const APPROVAL_ITEM = 'turn-item:runtime-request:'

type ToolResult = { structuredContent?: unknown; content?: unknown }
/** The tool's structured result, or its first text block parsed as JSON. */
function structured(result: ToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent
  const text = textOf(result)
  if (text === undefined) return undefined
  try { return JSON.parse(text) } catch { return { message: text } }
}
function textOf(result: ToolResult): string | undefined {
  const content = Array.isArray(result.content) ? result.content as { type?: string; text?: string }[] : []
  return content.find(block => block.type === 'text')?.text
}
