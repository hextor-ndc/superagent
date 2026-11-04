# Plan: multi-project routing for superagent-t3

Status: phases 0 and 1 done (2026-11-04, branch feat/multi-project); phases 2 and later not started. The phase 0 probe results are in the phase 0 section and in README "Live tests against a real t3code"; how phase 1 was built is at the end of the phase 1 section.
Base design: "Per-ticket project binding (one instance, one console, many t3code projects)", the winner of both judges, with the grafts they recommended, the errors they found corrected, and a reviewer's corrections applied.

Line numbers are from the current tree at /Users/hextor/coding/COMMON/superagent. Anything not verified in code or tests is marked "to check".

---

## 1. Goal and what changes for the operator

Today one superagent-t3 instance serves one T3 Code project. `SUPERAGENT_PROJECT_ROOT` is required (src/config.ts:57). src/main.ts:34-38 picks the one matching project from `t3_project_list` at startup and throws if there is none.

After this work, one instance serves every project Hector has registered in T3 Code. He talks to the one "Superagent" console thread. That thread is already a scratch thread outside any project (src/app/runtime.ts:175-188, `launchScratch`), so it does not change shape. GitHub stays optional. Console-only is the default for every project.

### Setup Hector does once per project

1. Add the folder as a project in T3 Code. The service cannot do this: the CLI-issued token gets `capability_denied` for `t3_project_create` (tests/live/contract.spec.ts:95-96).
2. In that T3 Code project, turn off PR watching and "continue threads after server update" (PLAN.md:11). The service cannot read or change these settings over `/mcp`, so this is a manual step, not a reminder.
3. Optional: add an entry to `<stateDir>/projects.json` (access, delivery, base ref).

### Walkthrough (after phase 3a)

1. Hector writes in the console: "Fix the invoice date bug in bardash, and update the SEO report template."
2. The console agent calls `superagent_projects({ query: "bardash" })` and `superagent_projects({ query: "seo" })`. It gets one ready project for each, with the catalogue purpose and recent tickets.
3. If a name matches two ready projects, the console agent asks Hector which one before filing anything.
4. It files two requests: `superagent_request({ project: "NDC/bardash", text: "..." })` and `superagent_request({ project: "NDC/seo", text: "..." })`, each mentioning the other.
5. Each call waits up to `wait_seconds` (default 20) and returns `accepted T-3f2a in NDC/bardash (from main), <thread link>`, `ignored: <reason>`, or `pending: <trigger id>`. With the Claude Router, `pending` is common and normal. The console agent checks `superagent_attention` or `superagent_ticket` later.
6. Two worker threads start, one in each T3 Code project, each in its own worktree. Each assignment says: commit on the ticket branch, do not push, do not open a PR.
7. When a worker reports ready, its ticket ends as `completed`. Hector's "what needs me?" (`superagent_attention`) lists open questions across all projects with a project label, recent ignored requests, and a "to review / merge" list of completed tickets whose branch is not yet in the project's default branch.
8. "What did we do in bardash last month?" `superagent_history({ project: "NDC/bardash" })` (phase 5) lists ended tickets with outcome, summary, branch, merged or not, and links.
9. If a ticket went to the wrong project, `superagent_reroute({ ticket_id, project })` stops it and files the same text for the right project. The leftover branch and worktree are listed for Hector to delete.
10. A folder in the catalogue but not in T3 Code shows as "not registered: add /Users/hextor/coding/<path> as a project in T3 Code, then ask again".

---

## 2. Decisions

| # | Decision | Reason |
|---|---|---|
| D1 | One instance, one state dir, one database, one T3Executor, one console, one Watchdog. | Worker tokens (src/http/server.ts:40), slots and resume are already global. Several instances collide on DB, port, console token and resume (src/executor/t3-executor.ts:155). |
| D2 | The project is a per-ticket binding in kv `ticket-project:<ticketId>`, written inside the Engine's `prepareTicket` hook. The value includes `ticketId`. | `prepareTicket` runs inside `engine.decide`'s atomic transaction (vendor/dsh/src/core/engine.ts:100, tickets.ts:49), before the ticket is saved (:51) and before `executor.start` (:54). kv shares the connection and savepoint (src/app/store.ts:41-56). `kv.list` returns values only (store.ts:110-111), so the value must carry its ticket id. |
| D3 | At launch time there is no default. Every launch, retry, restart and resume reads only the binding, and a missing binding fails the ticket. A default chosen at bind time (legacy or single project) is allowed, because it is persisted with the ticket and shown to Hector. | A launch-time default could put a pending ticket in another repo after a restart. A bind-time default is fixed once and visible. |
| D4 | No SQL schema change. New state lives in kv rows. | All tables hold whole JSON (store.ts:14-30) and Store has no migration mechanism. Ticket volumes are small, so in-memory filtering is enough. |
| D5 | Project precedence, in one function `bindProject` called from `prepareTicket`: explicit hint > Router choice (phase 3b only) > inherited hint > bind-time default (D21). | `prepareTicket` is the one point every accept path passes, including `eval_decide` and the rules router. |
| D6 | Hints are marked. `meta.projectBy: 'operator'` (set by `superagent_request`) or `'source'` (GitHub mapping) is explicit. `'inherited'` (copied by `superagent_answer`, or a pre-upgrade console trigger) is not. Only explicit hints override a Router choice. | A worker can hand back a follow-up that belongs to another project. An inherited hint must not block it from going elsewhere. |
| D7 | Access per project: `work`, `named` or `deny`. Default for a registered git project is `named`. The legacy project is `work`. `ARCHIVE/` is `deny`. `named` and `work` only constrain the Claude Router: a project named by the console agent counts as named. | Wrong-repo work is the main risk across 125 catalogued folders. The console agent's word is trusted for `named`, so the distinction only matters once the Router may pick (phase 3b). |
| D8 | Routable means: in `t3_project_list`, a git checkout, not denied. The catalogue only describes projects. | Workers need an existing_worktree launch in a registered project. t3code refuses a path that is not a git worktree and an unknown projectId (contract.spec.ts:128-131). The service does not create projects. |
| D9 | Join catalogue entries to T3 Code projects by exact realpath first. Longest prefix is a labelled fallback that names the parent and copies no purpose. | t3code stores `workspaceRoot` as given (contract.spec.ts:107). main.ts:37 uses `resolve()`, which does not follow symlinks. 9 catalogue entries are nested, and a nested uncatalogued project must not inherit its parent's description. |
| D10 | Catalogue `git-worktree` entries fold into their main checkout by `git rev-parse --git-common-dir`. | Seven bardash entries share one purpose string. |
| D11 | Delivery is `pr` only for the project mapped to `SUPERAGENT_REPOSITORY`. Every other project, including a legacy project with no repository, uses `branch`: commit on the ticket branch, no push, no PR. The rule is written into the assignment text. | The vendored brief says push and open a PR (vendor/dsh/prompts/work.md:29). Its exception is "unless the assignment explicitly requests a different deliverable" (work.md:35), so the rule belongs in `execution.assignment`. |
| D12 | Completed `branch` tickets appear in a "to review / merge" list until their branch is in the project's default branch. | A ready report on a ticket that follows no thread ends it at once as `completed` (vendor/dsh/src/core/assignments.ts:129-132). `ticketStage` then returns `ended` (vendor/dsh/src/core/stage.ts:10), so `attention()` (runtime.ts:271) never shows it. |
| D13 | Worktrees for new projects go under `<stateDir>/worktrees/<project-slug>/`. The phase 0 probe 2 showed t3code accepts a worktree anywhere on disk, as long as it is in the project's `git worktree list` (tests/live/contract.spec.ts:495). The legacy project keeps its current root. | Sibling folders land inside /Users/hextor/coding, where catalogue scans pick them up (COMMON/sa-testrepo-superagent exists on disk). |
| D14 | Base ref for new projects: the local default branch, named by what `refs/remotes/origin/HEAD` points to, else local `main`, else `master`. No `git fetch`. The legacy project keeps `SUPERAGENT_BASE_REF` or `HEAD`. Open question 6. | Hector's checkouts are often on feature branches. A remote-tracking ref can be stale, misses his unpushed local commits, and `-b` from it sets an upstream. |
| D15 | `SUPERAGENT_MODEL` and `SUPERAGENT_RUNTIME_MODE` stay global for all launches. Per-project overrides only if open question 9 says so (phase 4). | No behaviour change for the legacy project. |
| D16 | `Config` gets a `stateDir` field. The console token is read or created in `<stateDir>/console-token` (mode 0600) by a function main.ts calls after `loadConfig`. `loadConfig` writes nothing. | config.ts:70 randomizes the token on every start, so every restart makes a new console and Watchdog thread. Config has no `stateDir` today, only paths built from it (config.ts:62, 71). A writing `loadConfig` would write files during unit tests (tests/github.spec.ts:165). |
| D17 | main.ts takes a pid lock `<stateDir>/superagent.lock` before anything else, with a stale-pid check. | Two executors on one DB would both resume every active ticket. |
| D18 | `superagent_request` waits up to `wait_seconds` for the decision and returns it. Recent ignored console requests show in `superagent_attention`. | The core sends nothing for an ignore (vendor/dsh/src/core/replies.ts:43-44 only acknowledges accepts), and the console outbox only marks messages sent (runtime.ts:104). |
| D19 | `SourceScope` filters only a `meta.project` that names an explicitly denied project. A missing `meta.project` and an unavailable registry count as listened. Console triggers stored before the upgrade count as inherited hints for the legacy project. | A stale or empty registry must not make revalidate (vendor/dsh/src/policy.ts:218) refuse legacy tickets, and Evals open at upgrade must still be able to accept. |
| D20 | GitHub stays single-repository, mapped to one project, until a separate gated phase re-keys GitHub ids by repository. | Vendored GitHub trigger ids and thread keys carry no repository (vendor/dsh/src/sources/github-trigger.ts:9, 69, 84), so a second repo collides. |
| D21 | Bind-time default for an unnamed accept: the legacy project (`by: 'legacy'`) in phases 1-2. From phase 3a it stays the legacy project unless Hector chooses "refuse" (open question 1). With no legacy project and exactly one ready project, that one (`by: 'single'`). Otherwise refuse. | The console `project` argument and the Router's `project` field arrive only in phase 3. Without this default, phase 2 would refuse every accept as soon as T3 Code has two git projects. |
| D22 | vendor/dsh is not edited. A test hashes it against a manifest kept under tests/. | Requirement. |

---

## 3. Design

### 3.1 Project registry and descriptions

New module **src/app/projects.ts**, class `ProjectRegistry`.

All reads are synchronous from an in-memory cache. Two callers are synchronous: Router `tool.run` (src/router/claude-router.ts:181, no await) and `prepareTicket` (inside the transaction). Refreshes run outside transactions.

**Inputs**, joined in this order:

1. `t3_project_list` via `McpT3Client.listProjects` (src/t3/client.ts:141-151, already pages past 20). The only source of launchable projects.
2. The catalogue, `SUPERAGENT_CATALOGUE` (optional; for Hector `/Users/hextor/coding/repositories.json`). Fields used: `path`, `purpose`, `notes`, `kind`, `related[]`, `modules[].name`, `map`. Re-read when its mtime changes. Its git facts are historical (AGENTS.md); the registry re-checks git live.
3. Overrides, `<stateDir>/projects.json` (optional, operator-owned, validated with zod at load). `SUPERAGENT_PROJECTS_FILE` can move it. Keys: t3 project id, absolute path, catalogue path, or path prefix such as `ARCHIVE/`. Catalogue-relative keys and prefixes are resolved to absolute paths against the catalogue's `workspace`, so they also cover T3 Code projects that are not in the catalogue. Fields:
   - `access`: `work` | `named` | `deny`
   - `aliases[]`
   - `delivery`: `pr` | `branch` (`pr` takes effect only for the GitHub-mapped project until phase 6)
   - `baseRef`, `worktreeRoot`
   - `dirty`: `warn` | `refuse`
   - phase 4 only, if wanted: `runtimeMode` (lower only), `model`, `maxWorkers`
4. Git facts at refresh, with `execFile`: `git -C <root> rev-parse --show-toplevel` and `--git-common-dir`; the default branch name from `git symbolic-ref refs/remotes/origin/HEAD`, mapped to the local branch of that name, else local `main`, else `master`.

**Join rule.**
- Exact: `realpath(catalogue.workspace + "/" + entry.path) === realpath(t3.workspaceRoot)`. Paths may contain spaces (for example `SE/EHS regulations/codingharness`).
- Fallback: when no exact entry exists, the longest catalogue path that contains the root is recorded as `insideCatalogued: <path>`. No purpose or notes are copied.
- `git-worktree` entries fold into the main checkout their common dir names.
- T3 Code projects are deduplicated by realpath root before the join; see status `ambiguous`.
- Paths under any project's worktree root, and paths ending in `-superagent`, are excluded.

**Entry fields.** `{ id (t3), key (catalogue path, or t3 title if uncatalogued), title, aliases, root (realpath), commonDir, defaultBranch, worktreeRoot, baseRef, delivery, repository?, access, status, catalogue?: { path, kind, purpose, notes, related, map } | { insideCatalogued } }`.

**Legacy project.** When `SUPERAGENT_PROJECT_ROOT` or `SUPERAGENT_PROJECT_ID` is set, that project is the legacy project: access `work`; delivery `pr` only when `SUPERAGENT_REPOSITORY` is set, else `branch`; its `SUPERAGENT_WORKTREE_ROOT` or the old derived root (config.ts:65); `SUPERAGENT_BASE_REF` or `HEAD`.

**Status**, shown to the console and Router:
- `ready`: registered, git checkout, toplevel equals root, not denied.
- `not-registered`: catalogued only. Message: "add <abs path> as a project in T3 Code, then run superagent_projects with refresh".
- `no-git`: no git, or toplevel differs from root. Covers the 50 `project-folder` entries and the FMEA folder whose `.git` file points at a Windows path.
- `denied`: by override or the `ARCHIVE/` default.
- `missing-checkout`: root no longer exists.
- `ambiguous`: two or more registered projects have the same realpath root. t3code refuses a root that is already registered, also with a trailing slash, but takes a symlinked form of it as a new project (phase 0 probe 3), so one folder can be two T3 Code projects that both launch its worktrees. None of them is routable by default; only the one an override in projects.json names (by t3 id, with `access` not `deny`) is, and the others show as `ambiguous` with that one's key.

**Refresh.** At startup (in place of main.ts:34-38), on a 5-minute timer, on `superagent_projects({ refresh: true })`, when a name given to `superagent_request` does not resolve, and before a new-thread launch when the cache is older than 60 s. A failed refresh keeps the last good list and sets health key `projects` to failing. kv `projects:roster` stores the last good snapshot for display after a restart while t3code is down. It never authorises a launch.

**Resolve(hint).** In order: exact t3 id, exact key, alias, unique case-insensitive title, catalogue path, absolute path by realpath. Anything else returns `unknown` with up to 5 suggestions. Fuzzy matches are never auto-picked.

**Config** (src/config.ts):
- `SUPERAGENT_PROJECT_ROOT` and `SUPERAGENT_PROJECT_ID` become optional (config.ts:57).
- Scalar `projectRoot`, `worktreeRoot`, `baseRef`, `repository` (config.ts:17-22) move into `legacy?: { root, id?, worktreeRoot, baseRef, repository? }`.
- New field `stateDir` (from `stateDir(env)`, config.ts:133). Every new file (lock, console token, projects.json, worktrees) is built from it. Tests set it to a temp dir in tests/harness.ts, tests/e2e.spec.ts and tests/pending.spec.ts, so no test writes under the real ~/.superagent-t3.
- New: `SUPERAGENT_CATALOGUE`, `SUPERAGENT_PROJECTS_FILE`.
- `loadConfig` stays read-only.

**State files.** New module **src/app/state-files.ts**:
- `acquireLock(stateDir)`: writes `superagent.lock` with the pid using exclusive create. If the file exists, it checks the pid with `process.kill(pid, 0)`. A dead pid is replaced; a live one refuses start. Released on shutdown.
- `ensureConsoleToken(stateDir)`: returns `SUPERAGENT_CONSOLE_TOKEN` if set, else reads `console-token`, else creates it with mode 0600.

**main.ts order.** `loadConfig` → `acquireLock` → `ensureConsoleToken` → sign-in token → `McpT3Client` → `ProjectRegistry.load` → `new Runtime` → `await runtime.prepare()` (migration, 3.6) → `startHttp` (main.ts:41) → `runtime.start()` → `ensureConsole` → `ensureWatchdog`. Log a registry summary ("12 ready, 3 no-git, 108 not-registered, 2 denied") and the ready list. Fail startup only when GitHub is configured and the legacy project does not resolve, or when the migration needs a legacy project and none resolves.

**Descriptions.**
- To the console: `superagent_projects({ query?, status?, limit = 25, refresh? })`. Rows: key, title, status and why, purpose (≤200 chars), notes (≤300 chars), related, access, delivery, base ref, open tickets, last ticket date. It also states the per-project side effects (`agent/*` branches, worktree folder, `.git/info/exclude` lines) and the T3 Code setup step from section 1.
- To the Router: in phase 3a only `project_hint` on cards. A roster block comes only with phase 3b (3.2).
- The console agent runs on the model of its T3 Code thread, and the Router on the Anthropic API. Both receive catalogue text. Open question 2 decides which prefixes are sent as keys only.

### 3.2 Routing

#### Binding: `bindProject(ticket, outcome)`

Called from the Runtime's `prepareTicket` wrapper (runtime.ts:112) before `T3Executor.prepare`. The wrapper has `repo`, so it can read the origin triggers. A pure helper `resolveProject(trigger, choice?)` holds the rules so the rules router can call it before `decide`.

Inputs:
1. `explicit`: `meta.project` of `ticket.origin.triggerId` (vendor/dsh/src/core/model.ts:302) when `meta.projectBy` is `operator` or `source`. GitHub triggers get `source` from the repository mapping (3.5). If triggers in `origin.triggerIds` carry different explicit hints, throw.
2. `choice`: `outcome.audit?.project`, read with a local type guard. Before phase 3b no code path sets it; a value present anyway is refused.
3. `inherited`: `meta.project` with `projectBy: 'inherited'`, or a console trigger with no `meta.project` whose `at` is before `schema:projects.migratedAt` (D19). The second case maps to the legacy project.

Rules, in order:
- explicit and choice both set and different: throw "request named X, route chose Y".
- explicit: use it (`by: 'operator'` or `'github'`).
- choice: allowed only when that project's access is `work` (phase 3b). Use it (`by: 'router'`).
- inherited: use it (`by: 'inherited'`).
- none: the bind-time default from D21 (`by: 'legacy'` or `'single'`), else throw "accept needs a project".
- In every case, a project whose status is not `ready` or whose access is `deny` throws with the status reason.

Then write kv `ticket-project:<ticketId>` (3.6) and pass the binding to `executor.prepare`.

A throw rolls back the whole accept: no ticket, decision or subscription. `route()` already turns the error into `refused` (src/router/tools.ts:76-78).

#### Console intake (phase 3a; src/mcp/console-tools.ts, src/app/console-source.ts)

`superagent_request` (console-tools.ts:43, schema at :150-153) input becomes `{ text, project?, wait_seconds?: 0-30 (default 20) }`.

- Phases 1-2: `project` does not exist yet. When no legacy project is configured and more than one project is ready, the tool refuses with "multi-project routing is not enabled yet".
- `project` is resolved with `registry.resolve()` before `engine.receive`. Unknown, denied, `no-git` and `not-registered` are refused with the reason and suggestions. No trigger is stored.
- A missing `project`: follows open question 1. Recommended default: the legacy project, echoed in the result ("filed in <legacy key>, the default"). With "refuse", the tool refuses: "name the project".
- `consoleTrigger` (console-source.ts:14-17) takes an optional extra meta: `{ scope: 'console', project: <t3 id>, projectBy: 'operator' }`. Each request already gets its own `console:request-<uuid>` thread (console-source.ts:14), which matters because the core batches all pending triggers of one thread into one Eval and one ticket (vendor/dsh/src/core/evals.ts:104-108).
- The handler polls `store.decisions.byThread` for up to `wait_seconds` and returns `accepted <short> in <key> (from <base>), <link>`, `ignored: <reason>`, or `pending: <trigger_id>`.
- The panel calls the same actions over HTTP and awaits them (src/http/server.ts:56-63). If the panel calls `superagent_request`, it passes `wait_seconds: 0`, so the HTTP request does not hang (to check whether the panel uses this action).
- `superagent_ticket` also accepts a trigger id. When no ticket exists for it, it returns the trigger's decision and reason. This replaces a separate request-status tool.

`superagent_answer` (console-tools.ts:48, follow-up at :71) copies the origin trigger's `meta.project` with `projectBy: 'inherited'`.

`superagent_reroute({ ticket_id, project })`: stops the ticket (reason "rerouted to X"), files a new trigger with the original text and the new project as an explicit hint, and returns both links plus the leftover branch and worktree for Hector to delete. Accept is idempotent per trigger (evals.ts:136-146), so a reroute is always a new trigger. The service deletes nothing.

`CONSOLE_INTRO` (runtime.ts:313-321) v2 says: call `superagent_projects`; pass `project` on every request; ask Hector when two projects fit or none does; file one request per project when work spans projects, each mentioning the other; read the result of `superagent_request`; `pending` is normal with the Claude Router, so check `superagent_attention` or `superagent_ticket` later; use `superagent_reroute` for a wrong project.

#### Claude Router, phase 3a: carry and check (src/router/tools.ts, claude-router.ts, prompt.ts)

- `RouterToolHost` (tools.ts:12) gets `projectOf(ticketId)` and `projectHint(trigger)`.
- `candidateCard` (claude-router.ts:217-229) gets `project_hint: { key, title, by }` and `related_tickets` carry the project.
- No new field on `RouteItem` or `Assessment`. The project comes from the hint or the bind-time default.
- The acknowledgement of a console-origin ticket is prefixed `[<key>] ` by tools.ts. GitHub-origin acknowledgements get no prefix, so local catalogue paths never appear in a public comment.
- `route()` attach (tools.ts): refuse when the trigger's explicit hint differs from the target ticket's binding. `engine.attach` has no project check (engine.ts:109). An inherited hint does not block an attach.
- `DEPLOYMENT` (src/router/prompt.ts:14-25) gets plain sentences:
  - "the deployment's repository" and "this project" in the instructions above (orchestrator.md:1, :14; admission.md:17, :55) mean the project shown on the card;
  - never attach a request to a ticket in another project;
  - a handback that belongs to another project is ignored with that reason, so Hector can file it there.

#### Claude Router, phase 3b (optional): the Router picks among `work` projects

Built only if Hector wants the Router to choose (open question 3). With the default access `named`, nothing reaches this path unless he promotes a project to `work`.

- `superagent_request` accepts `project: "auto"`.
- `RouteItem` (tools.ts:28-37) and `Assessment` (tools.ts:42-54) get `project: z.string().nullish()`. `NEEDS.accept` (tools.ts:39) requires it only when the trigger has no explicit or inherited hint and more than one `work` project is ready.
- `route()` accept (tools.ts:162-166) validates `project` against the registry and passes `audit: { project, projectBy: 'router' }`. `eval_decide` (tools.ts:121-124) removes `project` before vendor `assessmentOutcome()` (which rebuilds audit, vendor/dsh/src/policy.ts:41-62) and merges it back into `named.audit`.
- Cards without a hint get `project_matches`: the top 3 `work` projects from a lexical match on key, aliases, purpose and module names, labelled "lexical, not a judgement".
- DEPLOYMENT adds: when two projects fit, ignore with a reason starting `needs_project:` and list them; when one request needs two projects, ignore with `needs_split:`. These show in the attention list of ignored requests.
- A third system block after `policySection` (claude-router.ts:196) holds only the `work` roster, one line per project (`key | title | purpose ≤100 chars`). The system prompt comes before the whole `router:messages` conversation, so any change to this block invalidates the cache for the entire conversation, not just from the block on. It holds only slow-changing data and is rebuilt only when its content hash changes. Anything that changes often goes through `orchestrator_read`.
- A one-time inbox item tells the Router that projects exist. `add()` only dedups against the current inbox (claude-router.ts:112-114), so it is gated by kv `router:deployment-v2`.

#### Rules router (src/app/interim-router.ts:41-60)

It cannot judge a project. Before `decide` it calls `resolveProject` with no choice. If no project resolves, it ignores with "Name the project: superagent_request with project=...". It must not let `prepareTicket` throw inside its job, since that would retry the job instead of answering.

#### Follow-ups and cross-project work

- A follow-up on a ticket's own thread reaches it through its subscription. It is never re-routed.
- One trigger makes at most one ticket. Cross-project work is one request per project.

### 3.3 Execution (src/executor/)

One `T3Executor` still serves all projects.

**Options** (t3-executor.ts:56-60): replace `project`, `worktreeRoot`, `baseRef` with `projects: ProjectRegistry` and `bindings: { of(ticketId): ProjectBinding | undefined }`. A test helper `singleProject({ id, root })` builds both, so the direct constructions (tests/failed-turn-restart.spec.ts:39, tests/read-tracking.spec.ts:86, tests/stop-races.spec.ts:78 and :170, tests/live/read-tracking.spec.ts:67) change by one line each.

**prepare()** (t3-executor.ts:171-182): receives the binding.
- Sets `execution.directory = join(binding.worktreeRoot, name)`. The `Execution` type keeps its exact shape.
- For `branch` delivery, appends to `execution.assignment` (built at t3-executor.ts:173-180): "Deliverable: commit your change on the ticket branch in this worktree. Do not push and do not open a pull request. Report ready with the branch name and the last commit SHA." The assignment is persisted with the ticket and rendered in the "## Assignment" section the brief refers to, which is what the work.md:35 exception needs.

**workspace.ts** (src/executor/workspace.ts:37-67):
- `prepareWorktree` takes the target directory (= `execution.directory`) instead of recomputing `join(worktreeRoot, name)` (workspace.ts:38).
- When the directory does not exist (first creation only):
  - `git -C root rev-parse --show-toplevel` equals the binding root.
  - `git rev-parse --verify <baseRef>^{commit}` resolves. Its SHA is recorded as `baseSha` on TicketThread.
  - Dirty check, only when the base is `HEAD` or the branch currently checked out: `git status --porcelain`. `dirty: warn` (default) puts "Base <sha> on <branch>; the checkout had N uncommitted changes that are not in this worktree" in the Execution variables. `dirty: refuse` fails before any git write. When the base is another local branch, the operator's uncommitted changes are not relevant and nothing is checked.
  - `git worktree add -b <branch> <dir> <baseRef>`, serialised per common dir with an in-process mutex.
- When the directory exists (retry, restart, resume): check only toplevel, that `git -C <dir> rev-parse --git-common-dir` equals the project's common dir, and that the directory is under the binding's worktree root. No base-ref or dirty check, so a later dirty checkout or a moved default branch cannot fail a retry. workspace.ts:41 checks only existence today.

**launch()** (t3-executor.ts:296-365):
- `binding = bindings.of(ticketId)`. Missing: fail with "no project recorded; stop and re-request".
- If TicketThread has a `projectId` that differs from the binding: fail.
- New thread only: refresh the registry if older than 60 s.
  - If t3code is unreachable, throw a transient error, so the job retries as other transient T3 errors do (t3-executor.ts:354-357). The ticket does not fail.
  - If the project is gone from `t3_project_list`, or its workspaceRoot realpath differs from `binding.root`, fail with "Project X is no longer registered in T3 Code at <root>. Use superagent_reroute to file this request in the project's current registration." Re-adding the folder gives it a new project id, and the binding is a snapshot, so a plain retry would fail again.
- `prepareWorktree({ projectRoot: binding.root, directory: ticket.execution.directory, baseRef: binding.baseRef, ... })` (t3-executor.ts:311).
- `repository` variable (t3-executor.ts:323) only when `binding.delivery === 'pr'`.
- `t3.launch({ projectId: binding.projectId, ... })` (t3-executor.ts:333). Model and runtime mode unchanged (D15).
- Retries and restarts with a threadId only send (t3-executor.ts:327-331), so they stay in the same thread and project.

**TicketThread** (t3-executor.ts:20-48): add optional `projectId` and `baseSha` as cross-checks. The binding stays in its own kv row, because TicketThread is first saved only after `t3.launch` returns, too late to survive a restart between accept and launch.

**render.ts** (src/executor/render.ts:47-87):
- `## Project`: title, key, root, catalogue purpose, map file path.
- `## Delivery requirements` (the section name vendor/dsh/prompts/worker.md:5 refers to): a second copy of the branch rule for `branch`; today's text for `pr`.
- The base line: "Base <ref> at <sha>", plus the dirty note when relevant.
- `RESUMED` (render.ts:84-87) says "inspect the worktree, git history and PR state". It is our text, so it gets a `branch` variant without "PR state".
- `RECOVERY_NOTE` (vendor/dsh/src/core/assignments.ts:21) says "GitHub state". It is vendored and stays. A `branch` worker with no GitHub simply has no GitHub state to inspect.
- From phase 5: the project's last 5 ended tickets.

**Router delivery check.** The Router's prompt includes team/delivery (src/router/prompt.ts:31), which tells the orchestrator to check PR and visual evidence before delivering a ready result. DEPLOYMENT gets a sentence (phase 2): for a `branch` project, a ready report with a branch name and commit SHA is a complete result; do not ask for a PR.

**Review list.** New async `runtime.toReview()`: ended tickets with outcome `completed` and `branch` delivery whose branch still exists and is not in the project's default branch (`git -C root merge-base --is-ancestor <branch> <defaultBranch>` exits non-zero). Cached for 60 s. Shown as `to_review` in `superagent_attention` and in the panel. A branch that is merged or deleted drops off the list. Cleanup of leftover worktrees and `agent/*` branches is open question 8; until then the service only lists them, with the exact `git worktree remove` and `git branch -d` commands.

**Slots** (src/executor/slots.ts:8-20): the global cap stays (`settings.executor.maxWorkers`, 1-16, vendor/dsh/src/limits.ts:6). `load()` reports per-project counts (phase 5). A per-project cap only in phase 4.

**Branches**: `agent/` prefix stays global. Names stay unique through the ticket-id suffix (render.ts:119-121).

**Scratch threads**: console and Watchdog stay as they are, in t3code's hidden scratch project (contract.spec.ts:262-268). The Watchdog prompt's list of parts (runtime.ts:293) gains `projects` (phase 1). Existing Watchdog threads get a one-time re-setup message under clientRequestId `${requestId}:setup-v2`, gated by kv `watchdog:setup`, because the setup text goes only to an empty thread (runtime.ts:209).

### 3.4 Context and memory of past work

The Router's conversation (kv `router:messages`, claude-router.ts:55) is working memory only. It mixes all projects and is compacted on the server. Durable memory is in the database and is read through tools.

**Built (phases 3a and 5).**
- `TicketView` (runtime.ts:23-31, `view()` at 252-268) gets `project: { id, key, title }` from the binding (phase 3a).
- `superagent_history({ project?, q?, before?, limit = 20 })` (phase 5): ended tickets newest first, with title, outcome, latest report summary (≤300 chars), branch, merged or not, PR link, thread link, and the binding's `by`.
- `superagent_status` gains `by_project` (open, waiting for a person, to review, ended in 7 days) and a project filter. `superagent_attention` and `superagent_messages` get the same filter.
- `tickets()` and `attention()` filter in memory by joining `kv.list('ticket-project:')` values (which carry `ticketId`) with `repo.tickets.list()`.
- `orchestrator_read` (tools.ts:181-208) gains `project/<key>` and `tickets?project=<key>&before=<iso>`. Today `tickets` stops at the 50 newest overall (tools.ts:185), which hides quiet projects.
- The worker's first message lists the project's last 5 ended tickets (title, outcome, summary, branch).
- Decision.audit keeps `{ project, projectBy }` for Router choices (vendor/dsh/src/core/evals.ts:312-313). The binding's `by` covers the rest.
- The worker `ticket` resource (src/mcp/worker-tools.ts:90) gets the project block.

**Deferred until a need shows up.**
- `superagent_brief({ since })`: a cross-project digest. The console agent can build one from `superagent_status` and `superagent_history`.
- `superagent_remember` / `superagent_forget`: operator notes and routing preferences in kv, written only by console tools, never by the Router.
- `superagent_context({ project, thread })`: read a pasted T3 Code thread link with `t3.read` and save a digest as a note. The phase 0 probe 4 found `t3_thread_list` (one project or `allProjects`, cursor paging, a `settled` filter) and `t3_thread_search`, both open to the CLI-issued token and both returning each thread's `projectId` (tests/live/contract.spec.ts, probe 4). The search was seen matching a title. That it then looks at branch, PR, project and message text is taken from its tool description, not observed; the same description says it covers active threads only, skips subagent threads and is not exhaustive. So this tool lists a project's earlier threads with `t3_thread_list` instead of needing a pasted link, and uses the search only as a shortcut. Still deferred.
- `parts` / `group` on `superagent_request`: several projects in one call. Partial failure (one part refused) would need defined behaviour first.
- `superagent_route` for re-filing an ignored request: calling `superagent_request` again does the same.
- Codex sessions outside T3 Code (~/.codex): private transcripts in an undocumented format. Open question 10.

### 3.5 GitHub

GitHub stays optional. With no `SUPERAGENT_GITHUB_LOGIN`, no GithubSource is built (runtime.ts:84) and every project uses `branch` delivery.

**Phases 1-5 (single repository).**
- `SUPERAGENT_REPOSITORY` maps to the legacy project. Startup fails when GitHub is configured and the legacy project does not resolve.
- GithubSource (src/sources/github.ts) sets `meta.project` and `meta.projectBy: 'source'` on each trigger before `engine.receive` (phase 3a). Before that, the bind-time legacy default covers GitHub tickets.
- Only that project gets delivery `pr` and `DSH_SUPERAGENT_GITHUB_REPOSITORY` (render.ts:65).
- `orchestrator_report` with `pr_url` (worker-tools.ts:58): when `bindPull` returns false (PR in another repository, github.ts:220-223), return a warning in the tool result. t3code PR linking (worker-tools.ts:55) still runs.

**Phase 6 (multi-repo, gated; src/sources/github.ts, src/app/runtime.ts).** Must land whole before a second repository is enabled:
- Wrap the vendored builder outputs: thread id `owner/name#n`, matching `channel.thread`, `channel.address.repository`, `meta.repository`. Re-key issue, pull and CI trigger ids with the repository using `key()` (vendor/dsh/src/core/ids.ts:3). Otherwise intake drops repo B's #N as a duplicate of A's #N (vendor/dsh/src/core/intake.ts:23), and `threadClosed` ends tickets across repos (tickets.ts:77-89).
- Namespace kv keys `github:since`, `github:closed:<n>`, `github:following`, `github:observing` (github.ts:62-67) per repository. Bare keys and bare `github:<n>` threads stay mapped to the legacy repository.
- `scope()` returns listened for old Mandates without `meta.repository`, so revalidate still passes.
- Keep one source `github` and one allowed list. One outbox sender picks the repository from `channel.address` (runtime.ts:105, github.ts:233-238).
- Per-repo health keys `github:<owner/name>` and failure isolation (github.ts:93-123). Update the Watchdog prompt's list of parts (runtime.ts:293).
- Poll only repositories with GitHub enabled in the overrides. Each costs at least 3 list calls per poll every 30 s (config.ts:87), so dozens of repos would exceed GitHub's REST rate limit.
- Per-repo restriction goes in `SourceScope`, not in Policy rows, because policyVersion hashes `policy.sources` (policy.ts:118) and a change would requeue Evals.

### 3.6 Persistence and migration of existing state

State dir stays `~/.superagent-t3` by default (config.ts:133). Database `<stateDir>/state.sqlite`. No SQL schema change.

**New kv rows.**
- `ticket-project:<ticketId>` = `{ ticketId, projectId, key, title, root, commonDir, worktreeRoot, baseRef, delivery, repository?, by: 'operator' | 'github' | 'router' | 'inherited' | 'legacy' | 'single', at }`. A snapshot: a later registry edit never moves a ticket.
- `schema:projects` = `{ version: 1, migratedAt, legacyProjectId }`.
- `projects:roster` (display only), `console:intro` = 2, `watchdog:setup` = 2, and in phase 3b `router:deployment-v2`.

**New files.** `<stateDir>/console-token` (0600), `<stateDir>/superagent.lock` (pid), optional `<stateDir>/projects.json`, and in the D13 layout `<stateDir>/worktrees/`.

**Migration v1** runs in a new async `runtime.prepare()`, which main.ts awaits after the lock and the registry load, and before `startHttp` (main.ts:41). It cannot run in `Runtime.start()` (runtime.ts:145), which is synchronous, and it must finish before HTTP opens: today HTTP accepts console requests before `start()`, `ClaudeRouter.add()` defers a `kick()` straight away (claude-router.ts:112-116), and the InterimRouter enqueues its own job. The Runtime constructor opens the Store but queues no work (to check once more during implementation).
1. If `schema:projects` is missing and the ticket table has rows, copy the database with `VACUUM INTO '<stateDir>/state.sqlite.bak-<timestamp>'`, outside any transaction (consistent in WAL mode). If the copy fails, stop startup. The README also tells Hector to copy `~/.superagent-t3` before the first start on the new version.
2. Take the legacy project from the registry (resolved from `SUPERAGENT_PROJECT_ID` or `SUPERAGENT_PROJECT_ROOT`). If legacy tickets exist and it does not resolve, stop startup with a message to set `SUPERAGENT_PROJECT_ROOT` once for the migration and the backup path. Do not guess.
3. In one transaction, write a binding with `by: 'legacy'` for every ticket without one. Each binding's `worktreeRoot` is `dirname(ticket.execution.directory)` when present, so a later change to `SUPERAGENT_WORKTREE_ROOT` never moves old tickets. Delivery follows the legacy rule in 3.1.
4. Check that each open legacy ticket's TicketThread `worktreePath` and `execution.directory` are under that root and are worktrees of the legacy project's common dir. Log mismatches; do not touch them. This catches a mis-set `SUPERAGENT_PROJECT_ROOT`.
5. Set `schema:projects` with `migratedAt`. Console triggers with `at` before `migratedAt` and no `meta.project` count as inherited legacy hints in `bindProject`, so Evals open at upgrade still accept after phase 3a even if Hector chose "refuse" for unnamed requests (D19).
6. The migration is idempotent and skips tickets that already have a binding.

**Console and Watchdog threads on upgrade.**
- If `SUPERAGENT_CONSOLE_TOKEN` was not set before, the old token was random, so the first start of the new version derives a new clientRequestId (runtime.ts:176, 202) and creates one new console and one new Watchdog thread. Both are empty, so they get the new intro and setup normally. From then on the persisted token keeps them. Hector can archive the old threads.
- If `SUPERAGENT_CONSOLE_TOKEN` was set, the existing threads are reused and have items, so the intro and setup would not be re-sent (runtime.ts:184, 209). They get one-time update messages under `${requestId}:intro-v2` and `${requestId}:setup-v2`, gated by `console:intro` and `watchdog:setup`.

**Old decisions** have no `audit.project`. Views read the binding.

**Transition.** Stop the old instance, then start the new one on the same state dir with the old `SUPERAGENT_PROJECT_ROOT`. If an old per-project instance must keep running, it needs its own `SUPERAGENT_STATE_DIR` and `SUPERAGENT_PORT`. The lock only protects against instances of the new version.

### 3.7 Safety

**Which projects a request may touch.** Only `ready` projects. Access `deny` never routes. `named` and `work` matter only for a Router choice (phase 3b): the console agent's `project` argument counts as naming. Policy has no per-project dimension (allowed lists are per source, policy.ts:121), so this is enforced in our code at three points, all fail-closed:
1. `superagent_request` validation, before `engine.receive`.
2. `SourceScope` (runtime.ts:90-93): `listened: false` only when `meta.project` names an explicitly denied project (D19). Revalidate (policy.ts:218) then refuses to resume an ended ticket only for a project Hector has since denied.
3. `bindProject` in `prepareTicket`, which rolls back the accept.

**Wrong-repo protection, in layers.**
1. Explicit hint validated against the registry.
2. Inherited hints never override another explicit choice; Router choices (3b) only for `work` projects.
3. `bindProject` final check and an atomic binding.
4. Launch: registration, realpath root, toplevel, common dir and directory ownership.
5. t3code refuses a worktree path that is not a git worktree and an unknown projectId (contract.spec.ts:128-131). The phase 0 probe 1 showed it also refuses project A's worktree launched under project B, with the same `invalid_request` (tests/live/contract.spec.ts:461). It accepts any worktree of the same repository under either id, including a project whose root is a linked worktree of another (probe 3). Either way, a worktree of A launched as A passes even if B was meant, so layers 1-3 are the real guard.
6. Visibility: `superagent_request` returns the resolved project, console acknowledgements are prefixed `[<key>]`, TicketView and the attention app show a project label.
7. With `checkWorktrees` on, FakeT3 enforces what the phase 0 probe observes, so tests catch mismatches.

**Delivery.** `branch` everywhere except the GitHub-mapped project, so routing into any of 125 repos cannot publish anything unasked.

**Side effects in each repo that gets work** (same as today): `agent/<name>` branches, a worktree, lines appended to `.git/info/exclude` (workspace.ts:59-67). Catalogued git-worktree entries share their parent's branch namespace and exclude file. Nothing touches the operator's working-tree files.

**Project creation.** The service does not call `t3_project_create`. The CLI-issued token gets `capability_denied` (contract.spec.ts:95-96). A full-access paired token can create projects (contract.spec.ts:98-100), but this plan leaves registration to Hector.

### 3.8 How vendor/dsh stays unchanged

Hooks used, all existing:
- `EngineOptions.prepareTicket` (vendor/dsh/src/core/part.ts:15, called at tickets.ts:49): binds the project; a throw rolls back `engine.decide`.
- `Execution.assignment` (model.ts:315): our text, which carries the branch-delivery rule.
- Accept `audit?: Record<string, unknown>` (ports.ts:44-45): carries a Router choice in phase 3b; persisted on the Decision (evals.ts:312-313).
- `Trigger.meta` (model.ts:38): carries hints; copied into `Mandate.basis.scope` (policy.ts:177, 197). Untrusted, so validated.
- `SourceScope.scope`: used at intake and on revalidate; the deny switch.
- Our `DEPLOYMENT` block (src/router/prompt.ts), assembled after the vendored prompts (prompt.ts:28-35), overrides single-repo and PR-only wording.
- Our render.ts sections and `RESUMED` text.
- Vendored GitHub builders are pure functions; phase 6 post-processes their output.

Nothing is added to core `Ticket` or `Execution` types. Settings is not touched (its schemas are `.strict()`, and policyVersion hashes sources).

New test **tests/vendor-intact.spec.ts** hashes every file under vendor/dsh, with nothing excluded, against **tests/fixtures/vendor-dsh.sha256**. The manifest lives outside vendor/dsh so the vendored tree gains no file. The manifest pins the tree as it is. The repository is now under git (branch feat/multi-project), so git history also shows vendor edits once committed; the test still catches uncommitted ones. It does not prove the tree equals UPSTREAM 6337fc8 plus the one recorded change in vendor/dsh/src/policy.ts (README "Develop"); that is to check by diffing against the upstream commit once.

---

## 4. Phases

Each phase leaves the existing single-project behaviour working and `npm run check` green, except where a phase states a behaviour change.

### Phase 0. Guard rails and live probes

Scope:
- Live contract probes, in tests/live/contract.spec.ts, using the full-access client to create a second project as contract.spec.ts:98-100 does:
  1. launch project A's real worktree with project B's id: record whether t3code refuses it and with which error;
  2. an existing_worktree launch with a worktree under a directory outside the checkout's parent (simulating `<stateDir>/worktrees`);
  3. a launch in a project whose root is itself a linked git worktree;
  4. `tools/list`: record whether any thread list or search tool exists.
- FakeT3 stores `projectId` on each thread. With `new FakeT3(projects, { checkWorktrees: true })`, `launch` throws `T3Error('t3_thread_launch', 'invalid_request')` for an unknown projectId and for a path that is not a git worktree, and for a foreign worktree only if probe 1 shows t3code refuses one. Without the option, it behaves as today. Add `addProject()` and `removeProject()`.
- The option is on in tests/harness.ts and in every new multi-project spec. It stays off for fixtures that launch `worktreePath: '/unused'` against `workspaceRoot: '/unused'` (tests/failed-turn-restart.spec.ts:21-22, tests/read-tracking.spec.ts:73-74, tests/stop-races.spec.ts:69-70 and :157) and for SlotT3 in tests/workload/driver.ts:380-389, which starts with `workspaceRoot: ''`.
- tests/harness.ts: `checkout(name = 'widgets')` so several repos share one temp dir.
- Vendor manifest and test.

Files: tests/live/contract.spec.ts, tests/fake-t3.ts, tests/fake-t3.spec.ts, tests/harness.ts, tests/vendor-intact.spec.ts, tests/fixtures/vendor-dsh.sha256 (new).

Tests:
- In-memory: fake-t3.spec with `checkWorktrees` refuses a wrong projectId and a non-worktree path, plus a foreign worktree if probe 1 says so. vendor-intact passes. The existing suite passes, because the check is off for the `/unused` fixtures and the harness fixtures launch real worktrees of their one project.
- Live: the four probes, with results recorded in the README.

Done when: a harness test that launches with a wrong project id fails in memory; probe 2 settles D13; probe 3 settles how catalogued git-worktree projects are routed; probe 4 settles whether earlier T3 Code threads can be listed.

**Results (2026-11-04, t3code 0.1.6, `T3_LIVE=1 npx vitest run tests/live/contract.spec.ts`).** The probes are the describe block "t3code with several projects" (tests/live/contract.spec.ts:429-573), with "Observed:" comments.
1. Probe 1, foreign worktree: refused. A real worktree of widgets launched under gadgets' id, and gadgets' main checkout under widgets' id, both get `invalid_request` "worktreePath must be one of the project's git worktrees. t3_worktree_list shows them.", the same refusal as a plain folder, a missing folder or a subfolder of a worktree. t3code checks the resolved path (symlinks followed, trailing slash dropped) against the project root's `git worktree list`. The main checkout is in that list, so a launch there is accepted; the executor never launches there. An unknown project id gets `invalid_request` "The project was not found." A clientRequestId t3code already answered returns the same thread under any listed project id, whatever the path; under a project id that is not listed it is refused with `orchestration_error` "The operation could not be completed.", which `T3Error.transient` counts as worth retrying.
2. Probe 2, worktree outside the checkout's parent: accepted and run normally. D13 holds: `<stateDir>/worktrees/<project-slug>/`.
3. Probe 3, project root that is a linked worktree: `t3_project_create` accepts it. Because `git worktree list` is the same from every worktree of a repository, t3code accepts a worktree made from the main checkout under the linked project's id and the reverse. So t3code cannot keep two projects of one repository apart. Routing consequence for phase 1: the registry groups T3 Code projects by common dir. When the main checkout is registered, it is the one routable project for that repository, and a registered linked worktree of it shows as folded into it (like a catalogue `git-worktree` entry, D10). When only a linked worktree is registered, it is routable as itself, and its worktrees are made from its root. Both share one `agent/*` branch namespace and one `.git/info/exclude`. Separately, `t3_project_create` refuses a root that is already registered, also with a trailing slash, but does not follow symlinks: a symlinked form of a registered root becomes a second project for the same folder, and that folder's worktrees launch under either id. The rule above does not pick between two such projects; the registry dedupes by realpath root first and gives them status `ambiguous` unless an override names one (3.1).
4. Probe 4, `tools/list`: `t3_thread_list` and `t3_thread_search` exist and work for the CLI-issued token. The list takes `projectId` or `allProjects` (without either, outside a T3 thread, it answers `target_required`) and returns threads newest first with `projectId`, title, status, link, `createdBy` and `creationSource`. The search matched by title in the probe; a match on message text was not seen with the scripted agent and is not relied on. Earlier T3 Code threads can be listed; see the `superagent_context` note in 3.4. Not checked: threads made in the web app rather than over `/mcp`, since the isolated server has none.

**As built, and where it differs from the scope above.**
- FakeT3 (tests/fake-t3.ts) records `projectId` on each thread (null for scratch). `checkWorktrees` makes `launch` apply t3code's rule from probe 1: the project id must be listed, and the resolved path must be in `git worktree list` of the project's root. A foreign worktree is refused by that rule, and a worktree of the same repository is accepted, as in t3code. A refused launch stores nothing under its clientRequestId. `addProject()` refuses a known id or an already registered root, compared as t3code compares it (trailing slash dropped, symlinks not followed); `removeProject()` keeps the threads. A replayed clientRequestId under a project id that is not listed is refused with `orchestration_error`, as in t3code. `listProjects()` now returns copies.
- The harness turns `checkWorktrees` on for any FakeT3 that leaves it unset (`t3.checkWorktrees ??= true` in `harness()`), because callers build the FakeT3 and pass it in. SlotT3 in tests/workload/driver.ts passes `checkWorktrees: false`, so driver.ts changed too, which the file list above did not name. The workload also passes with the check on; phase 3a can turn it on there with the projectId property. The `/unused` fixtures build their executors without the harness and are unchanged.
- `checkout(name = 'widgets', dir?)`: with `dir` from an earlier checkout, the repository goes into that temp dir and is removed with it.
- tests/vendor-intact.spec.ts compares every file under vendor/dsh with tests/fixtures/vendor-dsh.sha256 (`shasum -a 256` format; the spec's header has the command that writes it) and checks on a temp copy that a changed byte, an added dotfile and a removed file all show. A root .gitattributes marks vendor/dsh and the manifest `-text`, so a Windows clone with core.autocrlf gets the same bytes; the spec checks that attribute.
- The AGENTS.md / repositories.json update that phase 1 names is outside this repository and waits for Hector's OK.
- Outside the phase scope, to get the live suite green: two contract tests ("waits until a run ends", "sends in each mode") and one read-tracking test failed on and off, also on the unchanged tree. Under load t3code 0.1.6 shows a run as `running` before its ACP agent has the prompt, and a send in mode auto until then queues instead of steering (seen in 9 of 25 tries in a scratch probe). Those tests now also wait for the scripted agent's log to show the prompt (25 of 25 steered), and the wait test accepts `starting` as well as `running` for a run that has not ended. For the executor this means a follow-up sent just after a launch can be queued, not steered; read tracking already handles a queued run.

### Phase 1. Read-only registry, state files, lock

Scope:
- src/app/projects.ts as in 3.1 (exact and fallback join, fold, exclude, absolute deny prefixes, statuses, aliases, resolve, refresh, last-good cache, health `projects`).
- Config changes in 3.1, including `stateDir`; src/app/state-files.ts with `acquireLock` and `ensureConsoleToken`.
- main.ts order from 3.1; builds the registry instead of lines 34-38 and logs it.
- Runtime constructor takes the registry; `{ id, root }` still works through `ProjectRegistry.single()`.
- Console tool `superagent_projects`.
- Watchdog prompt adds `projects` to its parts (runtime.ts:293), with the `setup-v2` message for existing threads.
- Workers still launch only in the legacy project. Without a legacy project and with more than one ready project, `superagent_request` refuses with "multi-project routing is not enabled yet".
- Docs: README (new env vars, state files, setup step from section 1). Per AGENTS.md, add COMMON/superagent to /Users/hextor/coding/repositories.json and REPOSITORIES.md, and record the `<stateDir>/worktrees` location if D13 holds. Those two files are outside this repo, so Hector approves that edit first.

Files: src/app/projects.ts (new), src/app/state-files.ts (new), src/config.ts, src/main.ts, src/app/runtime.ts, src/mcp/console-tools.ts, src/app/health.ts, tests/harness.ts, tests/e2e.spec.ts, tests/pending.spec.ts, README.md.

Tests:
- In-memory, new tests/projects.spec.ts with a fixture catalogue and temp git repos: symlinked root matches by realpath (macOS /tmp is a symlink); exact match beats a containing parent; a nested uncatalogued project gets `insideCatalogued` and no purpose; git-worktree entry folds into its parent; non-git folder is `no-git`; uncatalogued t3 project uses its title; catalogue-only entry is `not-registered` with the add hint; `ARCHIVE/` denies a project that is not in the catalogue; override changes access; `-superagent` paths excluded; a project added to FakeT3 appears after refresh; a failed refresh keeps the last list and marks health.
- loadConfig without `SUPERAGENT_PROJECT_ROOT` (tests/github.spec.ts:165 pattern), and loadConfig writes no file.
- state-files: `ensureConsoleToken` returns the same token twice on one temp dir, file mode 0600; `acquireLock` twice in one process is refused; a lock with a dead pid is taken over.
- Console-only start with GitHub off and zero ready projects still opens the console.
- Live: start against the live t3 server with no project env and list its project.

Done when: the service starts with no project env, prints every T3 Code project with status and reason, the console lists them with catalogue purpose, and the console thread survives a restart without `SUPERAGENT_CONSOLE_TOKEN`. Hector can now see which projects are registered, which the plan could not check.

**As built, and where it differs from the scope above.**
- src/app/projects.ts follows 3.1, with these additions. A seventh status, `folded`, for a registered linked worktree whose main checkout is registered too (phase 0, probe 3); the main checkout lists it under `worktrees`. T3 Code projects excluded as worktree folders (under a worktree root, or a `*-superagent` path segment) are listed as `denied` with that reason rather than dropped, so every T3 Code project is printed; catalogue entries there are dropped. A catalogue-only folder without `.git` is `no-git` (checked with the file system, not git, to keep a refresh at a few git calls per registered project). Open question 2's default is built in: `ARCHIVE/`, `PERSONAL/` and `FAMILY/` under the catalogue's workspace are denied, the last two with `describe: false` (catalogue text withheld from `superagent_projects`); projects.json can override each, by the same key or a more specific one; a broader projects.json prefix (the whole workspace, say) does not, since prefixes apply from the shortest folder, a default and a projects.json one alike. Only a folder named `*-superagent`, or one directly inside it (the old `<root>-superagent/<ticket>` layout), is excluded by name, not any path with such a segment further up: a temp dir named that way denied everything under it. A catalogue-only folder whose `.git` file names a git dir that does not exist is `no-git`, as the FMEA folder is. Catalogue modules have `path` and `responsibility`, not `name`, so the registry keeps module paths. A project with no `origin/HEAD` branch, `main` or `master` gets base `HEAD`. `pr` delivery in projects.json applies only to the legacy project for now. Keys are made unique by appending the t3 id, and worktree folders by a short hash of it when two keys give the same slug. Which project keeps the plain key and folder depends only on stable facts (legacy first, then a catalogue path over a title, then the t3 id), not on status, so they do not swap when a checkout goes missing for a while. A worktree root still follows the key, so it changes when a project is catalogued later. Phase 2 should therefore launch a ticket in the `execution.directory` stored at its accept, not in a path recomputed from the registry (T3Executor's launch recomputes it from `worktreeRoot` today, src/executor/t3-executor.ts:320).
- The legacy project is found by `SUPERAGENT_PROJECT_ID`, else by the real path of `SUPERAGENT_PROJECT_ROOT`; of two T3 Code projects on that root, the one registered under the path given is taken, as main.ts did; otherwise it is left unresolved with a message to set the id. When both variables are set and the id's project is another folder than the root, the start is refused (before, git ran in the root and t3code launched under the id). A legacy project registered at a folder inside its checkout stays ready, with a reason that says so, since worktrees can be made from there and it worked before; any other project there is `no-git`. It keeps access `work` whatever a prefix says; only an override for its own id or path can deny it. It is never folded.
- The lock also takes over a lock whose pid runs but started after the lock file was written (from `ps -o etime=`; a reused pid), and a refusal names the process and the lock file.
- `kv projects:roster` is not built. main.ts still needs t3code to start (the registry load and `ensureConsole` both fail without it), so a stored roster would have no reader; a failed refresh while running keeps the last good list in memory. The `projects` health entry follows the existing Health rule: failing after three failed refreshes in a row, cleared by the next good one, so src/app/health.ts is unchanged.
- Refreshes in phase 1: at start, every 5 minutes, and `superagent_projects({ refresh: true })`. The other two triggers in 3.1 need `project` on `superagent_request` and per-ticket launches (phases 3a and 2).
- main.ts fails the start when `SUPERAGENT_PROJECT_ROOT`/`_ID` is set and does not resolve to a ready project, as before, not only when GitHub is configured. A typo there would otherwise start a service that refuses every request. With no project env it starts console-only.
- Without a legacy project every console request is refused, also with zero or one ready project, all starting with "multi-project routing is not enabled yet". The plan names only the case of more than one ready project, but taking the single ready project without a stored binding would be the launch-time default D3 rules out; D21's `single` default comes with the binding in phase 2.
- `runtime.prepare()` exists already. In phase 1 it refuses the start when no project is configured and open tickets exist, since every ticket so far was made in the legacy project. main.ts awaits it before `startHttp`. Phase 2 adds the migration there.
- T3Executor's `project` and `worktreeRoot` became optional (src/executor/t3-executor.ts, not in the file list): without them `prepare` throws, which rolls an accept back, and a launch fails its ticket with the same message.
- `loadConfig` leaves `consoleToken` empty unless `SUPERAGENT_CONSOLE_TOKEN` is set; main.ts fills it with `ensureConsoleToken`, and the Runtime refuses an empty one. `SUPERAGENT_WORKTREE_ROOT`, `SUPERAGENT_BASE_REF` and `SUPERAGENT_REPOSITORY` without a project are refused at load.
- `superagent_projects` counts open tickets and the last ticket date only for the legacy project, where all tickets are until phase 2. `watchdog_check` gained a `projects` summary. The console intro lists `superagent_projects` for new console threads; existing ones learn of it with `intro-v2` in phase 3a.
- tests/live/e2e.spec.ts builds the registry as main.ts does (phase 7 planned this) and has a console-only start against the live server.
- The AGENTS.md / repositories.json / REPOSITORIES.md update is outside this repository and waits for Hector's OK. D13 holds (phase 0, probe 2), so that update should record `<stateDir>/worktrees/`.

### Phase 2. Per-ticket binding, migration, branch delivery

Scope:
- `bindProject` in the prepareTicket wrapper with the phase 1-2 rules: explicit hints do not exist yet, so unnamed accepts bind to the legacy project (`by: 'legacy'`), or the single ready project when there is no legacy project (D21). kv `ticket-project` rows with `ticketId`.
- T3Executor options, prepare, launch and the create-only and reuse checks from 3.3. Per-common-dir mutex; `baseSha`; dirty warn or refuse; transient handling when t3code is unreachable.
- Default-branch detection for new projects (D14); the legacy project keeps its env settings.
- `runtime.prepare()` with migration v1 and the backup; main.ts awaits it before `startHttp`.
- Branch delivery: the assignment text in `prepare()`, render.ts `Project` and `Delivery requirements` blocks, the `RESUMED` variant, the DEPLOYMENT sentence on branch results.
- `runtime.toReview()` and the `to_review` list in `superagent_attention` and the panel.

Files: src/app/runtime.ts, src/app/projects.ts, src/app/migrate-projects.ts (new), src/main.ts, src/executor/t3-executor.ts, src/executor/workspace.ts, src/executor/render.ts, src/router/prompt.ts, src/mcp/console-tools.ts, src/mcp/attention-app.ts, plus the direct T3Executor constructions in tests listed in 3.3.

Tests (in-memory, new tests/multi-project.spec.ts, console-only, no `config.github`, checkouts `widgets` and `gadgets`, `checkWorktrees` on):
- An accept with `meta.project = gadgets, projectBy: 'operator'` set directly on the trigger by the test launches with gadgets' projectId. The worktree is in `git worktree list` of gadgets only. gadgets' `.git/info/exclude` has `.mcp.json`. The first message has the branch rule in its Assignment section and no `DSH_SUPERAGENT_GITHUB_REPOSITORY`.
- An unnamed accept with a legacy project and two ready projects binds to the legacy project. With no legacy project and two ready projects it is refused, and no ticket, decision or kv row exists afterwards.
- A `no-git` project is refused at bind time.
- Restart between accept and launch (file DB reopen, tests/router.spec.ts:124-136 pattern): the pending assignment relaunches in gadgets.
- A retry stays in the same thread and project. A retry after the main checkout became dirty, with `dirty: refuse`, still succeeds.
- gadgets removed from FakeT3 before launch: the ticket fails with the reroute text. FakeT3 `listProjects` throwing a transient error: the launch retries and the ticket does not fail.
- An existing directory from another repo at the target path: the ticket fails.
- Dirty checkout with base `HEAD`: `refuse` fails before any git write; `warn` puts the note in the variables.
- Two parallel launches in one repo both succeed.
- A completed `branch` ticket appears in `to_review` and drops off after its branch is merged into the default branch.
- Migration: a DB from the current version (built by the current harness) gets a backup file and legacy bindings with worktree root from `dirname(execution.directory)`, and resumes. With legacy tickets and no legacy project configured, startup refuses and names the backup. HTTP is not listening while the migration runs. A missing binding at launch fails and does not default.
- Live: none yet.

Done when: every launch path takes its project only from the stored binding, an existing single-project install upgrades and keeps working, and two-project T3 Code setups still accept unnamed requests into the legacy project. Behaviour change: a legacy project without `SUPERAGENT_REPOSITORY` switches to branch delivery, and its finished tickets show in `to_review` instead of nowhere.

### Phase 3a. Console names the project

Scope:
- `superagent_request` with `project` and `wait_seconds`; explicit hints (`projectBy: 'operator'`); unnamed default per open question 1.
- `superagent_answer` copies the hint as inherited; inherited hints and pre-upgrade console triggers in `bindProject`.
- `superagent_ticket` accepts a trigger id; recent ignored console requests in `superagent_attention`.
- `superagent_reroute`.
- `TicketView.project`; card `project_hint`; console-only acknowledgement prefix; cross-project attach guard; DEPLOYMENT sentences on reinterpretation, attach and handbacks.
- GithubSource sets `meta.project` with `projectBy: 'source'`.
- Rules router resolution with `resolveProject`.
- `SourceScope` deny rule (D19).
- `CONSOLE_INTRO` v2 and the `intro-v2` message.

Files: src/mcp/console-tools.ts, src/app/console-source.ts, src/app/runtime.ts, src/app/projects.ts, src/router/tools.ts, src/router/claude-router.ts, src/router/prompt.ts, src/app/interim-router.ts, src/sources/github.ts, tests/workload/router-script.ts.

Tests:
- In-memory, tests/router.spec.ts with a scripted model: a request with `project` lands in that project; an unknown project is refused before any trigger exists; a missing project follows the configured default (legacy, or refused); accepting the same trigger twice keeps the first project; an attach from a request naming gadgets to a widgets ticket is refused.
- Handback: a follow-up copied from a widgets ticket (inherited hint) that the Router attaches to a gadgets ticket is allowed.
- An Eval opened before the migration, with no `meta.project`, accepts into the legacy project even with "refuse" configured.
- `superagent_request` returns `accepted ... in <key>` within `wait_seconds`, `ignored: <reason>` for an ignore, and `pending` when the scripted router is slow. `superagent_ticket` with the trigger id returns the decision later.
- `superagent_reroute` stops the ticket, files a new one in the new project and lists the leftover branch.
- Console acknowledgement carries `[<key>]`; a GitHub acknowledgement does not.
- SourceScope: a legacy console trigger without `meta.project` stays listened; with the registry failing, still listened; a denied project is filtered.
- Rules router (tests/interim-stop.spec.ts, tests/followups.spec.ts): uses the hint or the default, else ignores with the "name the project" reason.
- tests/workload/router-script.ts reads a `{project:...}` tag; property in tests/workload/properties.ts: every `t3_thread_launch` used the expected projectId.
- Existing one-project router tests pass unchanged.
- Live: none yet (phase 7).

Done when: from the console Hector can file requests in any ready project, each lands in the named project or comes back with a clear reason, and wrong-project tickets can be rerouted.

### Phase 3b (optional). The Router picks among `work` projects

Only if open question 3 says yes.

Scope: everything in 3.2 "phase 3b": `auto`, `project` on RouteItem and Assessment, audit merge after `assessmentOutcome`, conditional `NEEDS.accept`, `project_matches`, `needs_project:` and `needs_split:` reasons, the `work` roster system block, and the gated inbox item.

Files: src/router/tools.ts, src/router/claude-router.ts, src/router/prompt.ts, src/mcp/console-tools.ts.

Tests:
- In-memory: a Router choice for a `named` project is refused; for a `work` project it is accepted and recorded in Decision.audit; an explicit hint and a different choice are refused with no ticket afterwards; the roster block lists only `work` projects and is byte-identical across two turns with no registry change; the inbox item is sent once across two starts on one DB.
- Live: none.

Done when: `project: "auto"` requests land in a `work` project or come back as `needs_project`.

### Phase 4 (conditional). Per-project model, runtime mode, worker cap

Only for the parts open question 9 asks for.

Scope, per answer:
- per-project `model`: `LaunchInput.modelSelection` overrides the client default (src/t3/client.ts:153-167); scratch launches keep `SUPERAGENT_MODEL`;
- per-project `runtimeMode`, lower only, rejected at load when above the global mode;
- per-project `maxWorkers` checked in `WorkerSlots.reserve()` (src/executor/slots.ts:16).

Files: src/app/projects.ts, src/t3/client.ts, src/executor/t3-executor.ts, src/executor/slots.ts.

Tests: a per-project model reaches the launch call; a `runtimeMode` above the global mode is rejected at load; with a per-project cap of 1 and a global cap of 3, a second gadgets ticket waits while a widgets ticket starts. Live: none.

Done when: the chosen overrides apply only to their project.

### Phase 5. Memory and visibility

Scope: `superagent_history`; project filters and `by_project` in status, attention and messages; project label and filter in the attention app (src/mcp/attention-app.ts:52) and panel; `orchestrator_read project/<key>` and `tickets?project=`; the worker's first message lists the project's last 5 ended tickets; worker `ticket` resource project block; Decision.audit and the binding's `by` shown in `superagent_ticket`; per-project `load()` for status and the Watchdog.

Files: src/mcp/console-tools.ts, src/app/runtime.ts, src/mcp/attention-app.ts, src/mcp/worker-tools.ts, src/mcp/watchdog-tools.ts, src/executor/render.ts, src/executor/t3-executor.ts, src/router/tools.ts.

Tests:
- History paging and filtering over 60 tickets in 3 projects; a quiet project still lists old tickets; legacy tickets show under the legacy project; merged and unmerged branches are labelled.
- `orchestrator_read project/<key>` returns tickets older than the global 50.
- The first message includes summaries from the same project only.
- Update toEqual assertions on TicketView (tests/pending.spec.ts:155, tests/watchdog.spec.ts).
- Live: none.

Done when: "what did we do in bardash last month?" and "what needs me across everything?" are answered from tools, with links, without relying on the Router's conversation.

### Phase 6. GitHub across repositories (optional, gated)

Scope: everything in 3.5 phase 6, behind a flag that stays off until all of it lands.

Files: src/sources/github.ts, src/app/runtime.ts, src/mcp/worker-tools.ts (`thread_follow` qualifies bare numbers with the ticket's repo), tests/fake-github.ts (dispatcher over several fakes).

Tests (tests/github.spec.ts additions):
- Same issue number in two repos: two triggers and two threads, no duplicate drop.
- A reply goes to the right repo.
- A merge in B does not end a ticket following A#n.
- One failing repo does not stop the others; health is per repo.
- Old `github:<n>` threads and Mandates without `meta.repository` still resolve to the legacy repo and revalidate.
- Live: none (no live GitHub fixture).

Done when: two repositories can be polled at once with no cross-repo leakage, and existing GitHub tickets keep resuming.

### Phase 7. Live verification

Scope: tests/live/t3-server.ts `StartOptions.projects` (default `['widgets']`), looping the existing `t3 project add` CLI path (around lines 189-197); expose `projects: { title, id, checkout }[]` and keep `projectId`/`checkout` as the first. tests/live/e2e.spec.ts builds the registry as main.ts does (replacing lines 53-55). Workload `RequestSpec` gets a target project.

Files: tests/live/t3-server.ts, tests/live/e2e.spec.ts, tests/live/workload.spec.ts, tests/workload/driver.ts, tests/workload/workload.ts, tests/workload/properties.ts.

Tests: `npm run test:live` with two real projects. A console request naming the second project runs in that project's real worktree, in the D13 layout. The acceptance workload with mixed projects; the projectId property holds.

Done when: live contract, e2e and workload pass against a real t3code with two projects.


### Phase 8. From the paper's design (independent of the phases above)

DeepSeek's summary of the paper lists parts this port does not have yet. These three are small and do not depend on multi-project work, so they can go in any order.

- **8a. A small Router model.** The paper says a small, fast model is enough for the Router; workers get the strongest model. Ours defaults to `claude-opus-5-5` (src/config.ts:78). Change: run the acceptance workload's Router against the real API with a smaller model such as `claude-haiku-5-5` (tier A uses a scripted model today, so this needs a mode that calls the API), compare routing decisions against an Opus run, and change the default only if the properties in tests/workload/properties.ts still hold. Done when: the default is chosen from a measured comparison, and README states it.
- **8b. CI results as incoming events.** The vendored source already builds triggers for CI changes on a PR and on the default branch (vendor/dsh/src/sources/github-trigger.ts:97-107), and the GitHub skill says changed CI on followed PRs reaches the worker. src/sources/github.ts never reads checks. Change: poll check runs of followed PRs (and the default branch, behind a setting), build triggers with the vendored builders, and dedupe by revision as they do. Tests: tests/github.spec.ts with FakeGitHub check runs: a failing check on a followed PR reaches its ticket's worker once per revision; a check on an unfollowed PR does nothing. Done when: a worker hears about its PR's failing CI without a person mentioning it.
- **8c. Measure what the paper measured.** The paper reports p95 time to finish tasks (15.7 min against 29) and tokens per run (2 to 4 times more). Our acceptance run checks correctness only. Change: record per-ticket time from first message to end, and Router tokens from the API's `usage` (src/router/claude-router.ts, which reads no usage today), and print p50/p95 and token totals at the end of `npm run acceptance:live`. Done when: each acceptance run reports those numbers, so a change such as 8a can be judged by them.

---

## 5. Open questions for the operator

1. **An unnamed console request once several projects are ready (from phase 3a).** Recommended: send it to the legacy project and say so in the reply, so today's habit keeps working. Switch to "refuse" when you use several projects daily.
2. **Which folders are denied, and what catalogue text goes to model APIs.** The Router (Anthropic API) and the console agent (its T3 Code model) receive purposes and notes. Recommended: deny `ARCHIVE/`; for `PERSONAL/` and `FAMILY/`, deny routing and send keys only, no purpose or notes, until you allow specific ones.
3. **Should the Router ever pick a project (phase 3b)?** Recommended: not now. The console agent names the project and asks you when unsure. Revisit if naming becomes a chore.
4. **Default access for registered projects.** Recommended: `named`. It only matters if phase 3b is built.
5. **Default delivery for projects other than the GitHub-mapped one.** Recommended: `branch` (commit only, no push, no PR).
6. **Base branch for new worktrees, and fetching.** Recommended: your local `main` or `master` (whichever `origin/HEAD` names), including your unpushed commits, and the service never runs `git fetch`.
7. **Dirty checkout when the base is your current branch.** Recommended: `warn` (work from the last commit and tell you and the worker that local changes are not included).
8. **Cleanup of finished work.** Recommended: the service lists completed tickets until their branch is merged, shows the exact commands to remove the worktree and branch, and deletes nothing itself.
9. **Per-project model, runtime mode or worker cap (phase 4).** Recommended: none now; one global `SUPERAGENT_MODEL`, runtime mode and cap. Add a cap only if one repo starves the others.
10. **Indexing Codex sessions (~/.codex).** Recommended: no. If wanted later: opt-in, read-only, titles and dates only, full text only on explicit request.
11. **GitHub multi-repo (phase 6).** Recommended: not now; one watched repository plus console-only everywhere else.
12. **T3 Code project settings.** For each project you use, will you turn off PR watching and "continue threads after server update" before the first ticket? Recommended: yes, as part of registering it. The service cannot check this.

---

## 6. Risks

- **Wrong-repo work.** If any path resolves the project from something other than the binding, a restart can launch work in another repo, and t3code may accept a matching pair from the wrong repo. Mitigation: one reader (`bindings.of`), hard failure when missing, layered checks in 3.7, FakeT3 with `checkWorktrees` in all routing tests.
- **Bind-time legacy default.** An unnamed request goes to the legacy project. That is persisted and echoed, but a request meant for another project can land there if the console agent forgets `project`. Mitigation: the echoed key, reroute, and open question 1.
- **Console agent guesses.** The console model may pass a `project` Hector never said, and `named` trusts its word. Mitigation: the resolved project is echoed in the result and in the console acknowledgement.
- **Ignores are silent outside the request result.** If the console agent does not read the result or attention, an ignored request waits. `pending` is common with the Claude Router at medium effort. Mitigation: `wait_seconds`, the ignored list, and the intro text.
- **Finished work goes unreviewed.** Branch tickets end at once as `completed`. Mitigation: the `to_review` list. Leftover worktrees and branches pile up until Hector removes them.
- **Stale registry.** Validation uses a cache because tool.run and prepareTicket are synchronous. A project removed after acceptance fails at launch with a reroute message, not as a refusal.
- **Vendored prompt conflict.** orchestrator.md and admission.md say "the deployment's repository" before DEPLOYMENT reinterprets it, and team/delivery asks for PR evidence. The model may be cautious or inconsistent. Hard rules are in tools.ts and `bindProject`, not the prompt. Keep proactive work in observe mode (`SUPERAGENT_ACCEPT_MODE`).
- **Migration.** It writes to `~/.superagent-t3/state.sqlite`. The VACUUM INTO backup runs first, HTTP stays closed until it finishes, startup fails closed when legacy tickets cannot be bound, and old worktree paths are checked against the legacy project.
- **Upgrade creates a new console thread** when the console token was random before. Expected once; the old thread can be archived.
- **Prompt cache churn (phase 3b only).** Any change to the roster block invalidates the cache for the whole Router conversation. Mitigation: only the slow-changing `work` roster goes there, rebuilt on a content-hash change.
- **Shared limits.** One global worker pool (max 16 in vendor); a busy project can hold all slots unless phase 4 adds caps.
- **Side effects across many repos.** `agent/*` branches, worktrees, `.git/info/exclude` lines; catalogued worktrees share their parent's namespace.
- **Two instances on one state dir.** The lock prevents it only for the new version; the old one must be stopped first.
- **T3 Code project settings.** PR watching and "continue after update" must be off in each project used; the service cannot check this.
- **Catalogue drift.** repositories.json is a historical snapshot with no remote field. Git is re-checked live; the repository comes only from the legacy env.
- **Vendor manifest proves only the current state**, because the repo has no git history.
- **GitHub multi-repo.** Enabling a second repository before phase 6 lands whole causes dropped duplicates, cross-repo fan-out and replies in the wrong repo.

---

## Corrections applied from the judges

- An ignore does not reach the console as a reply (replies.ts:43-44 only acknowledges accepts; the console outbox at runtime.ts:104 only marks sent). Covered by `wait_seconds`, `superagent_ticket` by trigger id and the ignored list.
- The console token is stored only in a 0600 file under the state dir, not in kv.
- `SourceScope` denies only explicitly denied projects; missing hints and registry failures count as listened.
- Workers keep `SUPERAGENT_MODEL` by default.
- t3code stores `workspaceRoot` as given (contract.spec.ts:107); realpath on both sides.
- Hint precedence is enforced in `bindProject`, not only in `route()`.
- Worktrees outside the checkout's parent are a live probe, not a fact. (Phase 0: the probe showed t3code accepts them.)
- Console request threads are already separate per request (console-source.ts:14).
- Correct console-tools lines: `superagent_request` at :43 (schema :150-153), `superagent_answer` at :48 (follow-up :71).
- A random old token means a new console thread on upgrade; `intro-v2` matters only when the token was set.
- `t3_project_create` is denied to the CLI-issued token; a full-access token can create projects, but this plan does not.
