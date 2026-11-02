# superagent-t3: plan

A super agent in the style of DeepSeek's *Exploring Super-agent Design*. It runs its Workers as ordinary t3code threads, so to the people using it, it looks like part of t3code rather than a second app.

DeepSeek's prototype supplies the control plane: Source → Trigger → Thread → Eval → Mandate → Ticket → Assignment → Channel. Its pure core is vendored unchanged under `vendor/dsh/` (MIT; the upstream commit is in `vendor/dsh/UPSTREAM`). t3code provides execution only. We talk to it as an **outside agent** through its documented `/mcp` endpoint, and never modify or fork it.

## Ground rules: staying safe across t3code updates

1. **Use only t3code's documented outside-agent surface:** `/mcp` tools such as `t3_thread_launch`, `t3_thread_send`, `t3_thread_read`, `t3_thread_wait`, `t3_thread_interrupt`, `t3_thread_organize`, `link_pull_requests` and `t3_project_list`. Every call goes through one module, `src/t3/client.ts`.
2. **No internal RPC in phase 1.** Tags and the live event stream (`subscribeThread`) would need the WebSocket RPC, which is internal and changes with every release. If we ever use it, it goes behind the same `T3Client` interface.
3. **Turn off the features that overlap with ours** in the project settings of the project the super agent uses: PR watching and `continueThreadsAfterServerUpdate`. The super agent owns follow-ups and recovery. Linking a PR still makes t3code settle the thread when the PR merges, which is only a sidebar state and harmless.
4. **Pin t3code** to a stable release on worker machines. Before moving to a new release, run the contract tests (`tests/t3-contract.spec.ts`, against a live server) and the paper's synthetic workload.

## Corrections to the earlier design discussion

- t3code's MCP has **no tag tool and no custom metadata on threads**. A Ticket is identified by its thread title (`[T-<short id>] <title>`) and by our own Ticket ↔ thread mapping. Tags come later, through RPC, if they turn out to matter.
- `existing_worktree` launches must point at one of the project's own git worktrees. A plain `git worktree add` inside the project checkout qualifies, and it lets us write the per-ticket MCP configuration before the agent starts.
- `/mcp` accepts only `mcp-client` sessions: either the OAuth sign-in from point 5, or `t3 auth session issue --subject mcp-client`.

## Points 1–5

### 1. Each Ticket is a native t3code thread (`src/executor/`)
- **`T3Executor`** implements DeepSeek's `Executor` port (`start`, `deliver`, `stop`) and reports back to the Engine.
- **start:** reserve a worker slot.
  - Prepare the worktree: `git worktree add -b agent/<name>` in the project checkout, and write `.mcp.json` (Claude) and `.codex/config.toml` (Codex) pointing at this Ticket's own worker MCP URL. Both files are excluded through `.git/info/exclude`.
  - Call `t3_thread_launch` with `existing_worktree`, the assignment as its first message, and a `clientRequestId` equal to the assignment id, so a retried launch is idempotent.
  - Then call `assignmentStarted`.
- **deliver:** `t3_thread_send` with `mode: auto`, which steers a running turn or starts a new one, and `clientRequestId` equal to the input id, so delivery happens at most once. Then `inputsDelivered`; a failure calls `deliveryFailed`.
- **stop:** `t3_thread_interrupt` with `stop: true`.
- **Watching turns:** a loop of `t3_thread_wait`. When a run ends we call `inputsRead` for the inputs it carried, then `turnEnded`.
- **People in the thread:** a person can type into the worker thread in t3code. That simply becomes another turn.
- **Ticket's PR:** linked with `link_pull_requests`, so t3code shows its status.
- **Concurrency:** limited by `WorkerSlots`, ported from the prototype, including the extra slot reserved for a person's message.

### 2. A Superagent console thread (`src/mcp/console-tools.ts`)
- One t3code thread with no project ("Superagent"), launched once, whose agent has the **console MCP server**. Its tools are `superagent_status`, `superagent_attention`, `superagent_ticket`, `superagent_stop`, `superagent_retry`, `superagent_answer`, `superagent_pause`, and `superagent_note`.
- The operator manages the super agent by chatting in t3code. The Watchdog will run in a scheduled version of this thread (phase 3).

### 3. Dashboards rendered inside t3code (`src/mcp/attention-app.ts`, `src/http/panel.ts`)
- `superagent_attention` returns an **MCP App** (`ui://superagent/attention`): an interactive "needs a person" queue whose buttons call the console tools. Codex renders it; other providers fall back to a text list.
- `/panel` on our own HTTP server is the same view as a plain page, to open in t3code's browser tab.

### 4. Links between GitHub/chat and t3code (`src/t3/links.ts`)
- Every acknowledgement and result posted to a Channel ends with a link to the Ticket's thread, using the `link` that `t3_thread_launch` returns.
- PR comments use t3code's prompt links (`pr=owner/name/123`), which open the thread linked to that PR.

### 5. One sign-in (`src/t3/auth.ts`, `docs/auth.md`)
- Phase 1 takes a bearer token from config (`T3_MCP_TOKEN`), created with `t3 auth session issue --subject mcp-client --scopes orchestration:read,orchestration:operate`.
- Phase 2 adds `superagent connect`, an OAuth PKCE sign-in over loopback, which is t3code's documented outside-agent flow. The owner approves it once and grants a runtime-mode ceiling.

## Phases

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Vendored core; t3code client; T3Executor; worker and console MCP server; attention app; links; token auth; tests against a fake t3code | **in progress** |
| 2 | SQLite store and durable effects (ported from the prototype's `store.ts` and `effects.ts`); GitHub Source and Channel; the Router as a model-API session in the control plane, with batching; OAuth `connect` | next |
| 3 | Watchdog as a scheduled t3code thread; several machines (one `t3 serve` each, plus a cloud control plane); per-machine tokens and project allowlists | later |
| 4 | Acceptance test: the paper's synthetic workload (~300 messages, ~20 requests) using t3code's Replay test provider | later |

## Known approximations in phase 1

- **"Read" tracking.** DeepSeek's harness reports when a message enters the model's history. We count an input as read once a run that started after its delivery ends. This is conservative: a follow-up may be counted unread slightly longer than it truly was.
- **Turn ends are found by polling** `t3_thread_wait`, not from an event stream.
- **State is in memory** (`MemoryRepositories`) until phase 2.
