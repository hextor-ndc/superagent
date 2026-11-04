# superagent-t3: plan

A super agent in the style of DeepSeek's *Exploring Super-agent Design*. It runs its Workers as ordinary t3code threads, so to the people using it, it looks like part of t3code rather than a second app.

DeepSeek's prototype supplies the control plane: Source → Trigger → Thread → Eval → Mandate → Ticket → Assignment → Channel. Its pure core is vendored unchanged under `vendor/dsh/` (MIT; the upstream commit is in `vendor/dsh/UPSTREAM`). t3code provides execution only. We talk to it as an **outside agent** through its documented `/mcp` endpoint, and never modify or fork it.

## Ground rules: staying safe across t3code updates

1. **Use only t3code's documented outside-agent surface:** `/mcp` tools such as `t3_thread_launch`, `t3_thread_send`, `t3_thread_read`, `t3_thread_wait`, `t3_thread_interrupt`, `t3_thread_organize`, `t3_pending_request`, `link_pull_request` and `t3_project_list`. Every call goes through one module, `src/t3/client.ts`.
2. **No internal RPC in phase 1.** Tags and the live event stream (`subscribeThread`) would need the WebSocket RPC, which is internal and changes with every release. If we ever use it, it goes behind the same `T3Client` interface.
3. **Turn off the features that overlap with ours** in the project settings of every T3 Code project the super agent works in: PR watching and `continueThreadsAfterServerUpdate`. The super agent owns follow-ups and recovery. Linking a PR still makes t3code settle the thread when the PR merges, which is only a sidebar state and harmless.
4. **Pin t3code** to a stable release on worker machines. Before moving to a new release, run the live contract tests (`npm run test:live`, which starts its own isolated `t3 serve`; the contract is `tests/live/contract.spec.ts`) and the paper's synthetic workload against it (`npm run acceptance:live`).

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
- **deliver:** `t3_thread_send` with `mode: auto`, which steers a running turn or starts a new one, and `clientRequestId` equal to the input id, so delivery happens at most once. Then `inputsDelivered`, and `inputsRead` when the send says the message went into a run (see "Read tracking"); a failure calls `deliveryFailed`.
- **stop:** `t3_thread_interrupt` with `stop: true`.
- **Watching turns:** a loop of `t3_thread_wait`. When a run ends we report anything read in it that was not yet reported, then `turnEnded`.
- **Waiting on a person:** while a run is going, the executor checks every 15 s for t3code approvals and questions (`t3_thread_read`, `t3_pending_request`). The ticket's stage becomes `person/approve` or `person/question` and it shows in the attention queue. `superagent_answer` answers questions. Approvals can only be answered in t3code's own UI, so the queue links to the thread, and the Watchdog alerts after a minute.
- **People in the thread:** a person can type into the worker thread in t3code. That simply becomes another turn.
- **Ticket's PR:** linked with `link_pull_request` (one call per URL), so t3code shows its status.
- **Concurrency:** limited by `WorkerSlots`, ported from the prototype, including the extra slot reserved for a person's message.

### 2. A Superagent console thread (`src/mcp/console-tools.ts`)
- One t3code thread with no project ("Superagent"), launched once, whose agent has the **console MCP server**. Its tools are `superagent_status`, `superagent_attention`, `superagent_dismiss_alert`, `superagent_ticket`, `superagent_projects`, `superagent_request`, `superagent_reroute`, `superagent_answer`, `superagent_stop`, `superagent_retry`, `superagent_note`, `superagent_pause`, and `superagent_messages`. Requests name the T3 Code project they go to (docs/multi-project-plan.md).
- The operator manages the super agent by chatting in t3code. The Watchdog will run in a scheduled version of this thread (phase 3).

### 3. Dashboards rendered inside t3code (`src/mcp/attention-app.ts`, `src/http/panel.ts`)
- `superagent_attention` returns an **MCP App** (`ui://superagent/attention`): an interactive "needs a person" queue whose buttons call the console tools. Codex renders it; other providers fall back to a text list.
- `/panel` on our own HTTP server is the same view as a plain page, to open in t3code's browser tab.

### 4. Links between GitHub/chat and t3code (`src/t3/links.ts`)
- Every acknowledgement and result posted to a Channel ends with a link to the Ticket's thread, using the `link` that `t3_thread_launch` returns.
- PR comments use t3code's prompt links (`pr=owner/name/123`), which open the thread linked to that PR.

### 5. One sign-in (`src/t3/auth.ts`, `docs/auth.md`)
- Phase 1 takes a bearer token from config (`T3_MCP_TOKEN`), created with `t3 auth session issue --subject mcp-client --scope orchestration:read --scope orchestration:operate`. Such a token is capped at the `approval-required` runtime mode.
- Phase 2 adds `superagent connect`, an OAuth PKCE sign-in over loopback, which is t3code's documented outside-agent flow. The owner approves it once and grants a runtime-mode ceiling.

## Phases

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Vendored core; t3code client; T3Executor; worker and console MCP server; attention app; links; token auth; tests against a fake t3code | done |
| 2 | SQLite store and restart recovery; GitHub Source and Channel; the Router as a Claude session in the control plane, with batching; OAuth `connect` | done |
| 3 | Watchdog as a scheduled t3code thread (done); several machines (one `t3 serve` each, plus a cloud control plane); per-machine tokens and project allowlists | in progress |
| 4 | Acceptance test: the paper's synthetic workload (~300 messages, ~20 requests), in memory and against an isolated t3code with a scripted ACP agent | done |
| Multi-project | One instance, one console, many T3 Code projects: each ticket bound to its project; see [docs/multi-project-plan.md](docs/multi-project-plan.md) | phases 0 to 3a done |

## Phase 2 notes

- **Store** (`src/app/store.ts`): the core's repositories on `node:sqlite`, with savepoint transactions. Jobs are queued only after the Engine's transaction commits. Each Ticket's thread record, the outbox receipts, the pause state and the console thread live in its key-value table.
- **Recovery is the super agent's** (ground rule 3):
  - A super-agent restart re-attaches to running workers.
  - A run t3code interrupted restarts its Assignment with the prototype's recovery note, in the same thread.
  - A failed turn is told to continue three times, then the Ticket fails and waits for a person. The handling is saved with the failure it counts (`TicketThread.failing`), so a restart in the pause before "go on", or while that message is out, takes it up again without counting the failure twice. The message goes under `continue:<assignment>:<hash of the failed run>`, which t3code dedupes if the first send landed.
  - A retry's stop never lands on its relaunch: a live Ticket's thread is only interrupted, not stopped, and the launch waits for the interrupt until it succeeds or gives up after its last retry.
  - A stop that comes while a launch is out: the launch checks again after preparing the worktree and when its t3code call comes back. A stop before the call leaves the call out. A stop after it keeps the thread for later Assignments and interrupts the run the launch started, under its own request id (`stop-launch:<assignment>`), fully stopping the thread when the Ticket ended. The worker slot stays free and the Engine is not told the Assignment started.
- **GitHub** (`src/sources/github.ts`): polling through the agent account's `gh`. It takes in mentions, anything on subscribed threads, and reviews and merge or close of followed PRs. The prototype's trigger builders are vendored unchanged; its notification-based polling was tied to the harness and is not used.
- **Router** (`src/router/`): the prototype's main-Session tools under the same names, so its prompts apply unchanged. One append-only conversation, persisted, with compaction. A batch is whatever waited while the model worked. Proactive acceptance still goes through the vendored `assessmentOutcome`, so the model can never accept outside the Policy.
- **Sign-in** (`src/t3/connect.ts`): t3code's outside-agent OAuth. The session lasts 30 days with no refresh, so the service warns before expiry.

## Phase 4 notes

- **Workload** (`tests/workload/workload.ts`): generated from a seed. The paper does not publish its per-category counts, so the mix is ours: with seed 1, 294 messages and 20 requests, covering new requests, follow-ups, stops, questions, handbacks, reviews and merges.
- **Three tiers, the same checks** (`tests/workload/properties.ts`):
  - **A:** in memory, with the Claude Router driven by a scripted model.
  - **B:** in memory, with the rules router.
  - **C** (`tests/live/workload.spec.ts`): against an isolated t3code 0.1.6. The scripted ACP agent (`tests/live/scripted-agent.mjs`) plays the workers with `worker-plan.mjs`; GitHub stays FakeGitHub, and PR links are recorded, not sent. It takes about 45 s. A worker turn counts as quiet only once the agent has taken in the message cards of every launch and every send to it that was not queued.
- **Live harness** (`tests/live/t3-server.ts`): each isolated `t3 serve` runs in its own process group with the agents it starts and is stopped as a group. `tests/live/reaper.mjs`, started detached, stops the group the server currently runs in (`processes.json` lists only that one) and removes the server's folder if the test worker goes away without closing it (Ctrl-C, a killed worker).
- **Also covered live:**
  - An agent process that crashes mid-turn (`[crash once]`): the worker is told to go on and reaches its ready report.
  - An approval answered the way t3code's web app does: a bearer session from `t3 auth session issue`, a WebSocket ticket from `POST /api/auth/websocket-ticket/rpc`, then `orchestration.dispatchCommand` with `runtime-request.respond` on `/ws?orchestrationProtocol=2`. Only the tests do this; the super agent still does not answer approvals.
  - `link_pull_request` on a server with no credentials: the t3 runtime runs with a temporary HOME, no GitHub tokens, no git config, and a proxy that refuses every request, on a `.invalid` URL in a project without a remote. The check that nothing went through the proxy waits past t3code's first 10 s telemetry flush.
- Every isolated server runs with `T3CODE_TELEMETRY_ENABLED=false`, so throwaway test servers send no usage events, and with `TMPDIR` set to its own folder, so the `t3-token-*` socket folders t3 leaves behind go when the folder does.
- The in-memory FakeT3 keeps its scratch folders (console and Watchdog threads) under one `fake-t3-scratch-*` folder and removes it, so `npx vitest run` leaves nothing in the temp directory.
- **Not covered live:** the super agent's own PR link path (a worker's report with `pr_url` reaching `link_pull_request`) is covered at the contract level only.

## t3code 0.1.6 behaviour found by the live tests

- `t3_thread_launch` returns status `preparing`. A send in mode `auto` steers while the active run is `running`, even with a message queued; while the run is `starting`, for example just after a steer, it is queued.
- t3code steers an ACP agent by cancelling its turn (`session/cancel`) and prompting the same session again with only the new message. The turn in flight is lost (generation, tool calls), but the session history is kept.
- An interrupt with `stop: true` also holds the runs queued before it. An archived thread refuses sends (`thread_not_sendable`).
- `t3_thread_wait` does not return on a pending approval or question; the run stays `running`.
- `t3_thread_read` pages: `nextPosition` is never null on a non-empty page, so the client uses `hasMore`.
- After a t3code restart an MCP session id gets 404; the client opens a new session and retries once. A bad token gets 401 `invalid_mcp_credential`.
- An ACP agent process that exits mid-turn ends its run `failed` ("Provider turn failed."), not `interrupted`. t3code takes the next sends at once but does not start a new agent for them: for an agent without `loadSession`, the next two runs fail before they start ("The provider could not start this turn"). The third starts a new agent process with a new session, and its first prompt carries the thread's history. So the super agent's three "go on" messages cover a crash with nothing to spare: the third is the first to reach a new agent.
- That first prompt is a history handoff with a size limit. Every item in it has a header with its ids, and a message's id includes its `clientRequestId`, escaped again at each level. Long request ids push older items out: with the full run id in the "go on" id, the Assignment's first message was dropped and the new agent never saw its task. Request ids are kept short for this reason (`continueRequestId`, `deliverRequestId`).
- `link_pull_request` returns `{host, repository, number, url, alreadyLinked}`. Any https URL of the form `/owner/repo/pull/N` is taken as a pull request on that URL's host; linking the same one twice gives `alreadyLinked: true`; an issue URL is refused. After a link, t3code syncs the pull request's state through the project's host, and skips a project without a remote.
- Approvals cannot be answered over `/mcp`, and an `mcp-client` token gets 401 for a WebSocket ticket. `decline` reaches an ACP agent as a rejection; a second answer is refused.

## Known approximations

- **"Read" tracking.** DeepSeek's harness reports when a message enters the model's history. t3code's `t3_thread_send` says where a message went instead.
  - `steered` into the running turn, or `started` a run: its Inputs count as read when t3code accepts it.
  - `queued`: read once that run is seen running or completed.
  - A queued run that ends cancelled or interrupted without being seen running leaves its Inputs unread; the Engine gives them to the next Assignment or lets them go when the ticket ends. When a queued run fails and the wait names it, its messages are sent again with the message that tells the worker to go on.
  - A steered message that the model never reads, because the turn then fails, still counts as read.
  - A turn end is reported in a later millisecond than the reads recorded with it, because the core's comparison is strict. A delivery that starts a run while a turn end is being reported waits for that end. The exception is a failed turn whose "continue" send itself fails: a delivery during that backoff is not held.
- **Turn ends are found by polling** `t3_thread_wait`, not from an event stream. Approvals and questions are found by polling too, every 15 s.
- **Approvals are answered only in t3code's UI.** `/mcp` has no tool for them. The UI's path (above) needs a bearer session of the web app's kind, which the super agent's `mcp-client` token is not.
- **A transient launch failure after t3code made the thread.** If `t3_thread_launch` fails with a transient error after t3code created the thread, and the Ticket is stopped before the retry, the thread id is never learned and that thread is not interrupted.
- **Stops and deliveries.** When a ticket ends, its worker slot is freed as the stop is sent, and t3code takes a moment to end the run, so a launch can overlap that run's last moments. A delivery whose send t3code refuses because the ticket ended while the send was out ("is stopping and cannot be steered") is treated as moot: it is not a failed delivery and does not count against `jobs:deliver`. A delivery whose send comes back after a stop, or a failed turn whose worker is stopped during the pause before it is told to go on, marks nothing running again and sends no "go on" to the stopped thread. A kind of job counts as failing after three failures in a row, and its next success clears it.
- **The rules router** (router kind `rules`) accepts a new request when an allowed person addressed the agent, and any message a worker handed back as beyond its ticket, addressed or not. It ignores proactive candidates, unaddressed comments (such as one on a stopped ticket's Issue), follow-ups a ticket let go when it ended, and requests no project can take (an unnamed one with no default project, or one naming a project that is not ready), with the reason. It reads a stop on a ticket's own thread only when the message is addressed, starts (after mentions of the agent) with "stop" or "cancel" plus at most punctuation and a short reason (not a joined word such as "stop-gap" or "cancel_order"), mentions no one else, does not go on with but/actually/instead/keep/continue/resume, reaches exactly one ticket (counting ended tickets the message resumes), and that ticket is not waiting on an answer. While a worker waits on an answer, even "stop" goes to it as the answer; the operator uses `superagent_stop`. The stop is kept in the database until the Engine decides it, so it is retried after a failure or a restart. For a review or an inline review comment, the words read are its body, without the review decision or the file and diff it is on. A stop that waited during a pause behind another message on an ended ticket is still read once the ticket resumes.
- **GitHub times.** The GitHub Source compares this machine's poll time with GitHub's own times in two places: for a Thread followed without a message of the Ticket's own on it (such as for context), and for the start of an observed row (`SUPERAGENT_GITHUB_OBSERVE`). Clock skew can drop, or let in, messages written within the skew of that moment. An edit gives a comment a new Trigger id, so an older comment edited after a row was switched on is read as new. The prototype behaves the same way.
- **The Router has no tool for settings or prompts.** The operator changes those in config and restarts.
- **No Feishu or other chat Source yet.** The console is the only non-GitHub Source.
