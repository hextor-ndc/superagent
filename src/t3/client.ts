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
export interface LaunchResult { threadId: string; link?: string; runId: string | null; status: T3Status | null }
export interface ScratchLaunchInput { title: string; message?: string; clientRequestId: string }
export interface SendResult { messageId: string; runId: string; delivery: 'started' | 'queued' | 'steered' | 'restarted'; status: T3Status }
export interface WaitResult { runId: string | null; status: T3Status; timedOut: boolean }
export interface TimelineItem {
  position: number; itemId: string; runId: string | null; messageId: string | null; type: string; text: string | null
  createdBy: unknown
}
export interface ThreadRead {
  thread: { threadId: string; title: string; link?: string; status: T3Status; activeRunId: string | null; latestRunId: string | null
    worktreePath: string | null; branch: string | null; settled: boolean; archived: boolean }
  items: TimelineItem[]
  nextPosition: number | null
}
export interface ProjectSummary { id: string; title?: string; workspaceRoot: string }

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
    try { result = await (await this.connect()).callTool({ name: tool, arguments: args }) as ToolResult & { isError?: unknown } }
    catch (error) {
      this.client = undefined
      throw new T3Error(tool, 'network', error instanceof Error ? error.message : String(error))
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
  async linkPullRequests(threadId: string, urls: string[]): Promise<void> {
    await this.call('link_pull_requests', { threadId, urls })
  }
  async close(): Promise<void> {
    const client = await this.client?.catch(() => undefined)
    this.client = undefined
    await client?.close()
  }
}

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
