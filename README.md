# superagent-t3

A super agent in the style of DeepSeek's *Exploring Super-agent Design*. It runs on top of an unmodified [t3code](https://github.com/pingdotgg/t3code).

- **Control plane:** DeepSeek's domain core, vendored unchanged from [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) (MIT, in `vendor/dsh/`). It decides who may ask for work, turns requests into Tickets, and reports back.
- **Execution:** t3code. Each Ticket is an ordinary t3code thread in its own worktree, so it appears in the t3code sidebar on desktop, web and mobile, with diffs, the terminal and notifications.
- **Integration:** the super agent talks to t3code only as an outside agent through its documented `/mcp` endpoint, so updating t3code doesn't touch this code.

See [PLAN.md](PLAN.md) for the design, the phases and what is still approximate.

## What it does

- **Takes requests where people already work.** On GitHub, it acts on a mention of the agent account by someone on the allowed list. In t3code, it acts on what the operator types in the console. Anyone not on the list, any bot, and the agent's own comments are ignored.
- **Decides with a Router.** One Claude conversation in the control plane accepts work, attaches follow-ups, stops work on request, and relays results and questions. Messages that arrive while it is working are handled together in its next request. Every authorization rule stays in DeepSeek's Engine and Policy, never in the model. Proactive work (unaddressed messages matched against the team's rules) starts in `observe` mode: the agent records what it would have done.
- **Works in t3code.** Each Ticket gets its own worktree and thread. The worker's pull request becomes a thread the Ticket follows: review comments reach the worker without a new mention, and the merge ends the Ticket.
- **Survives restarts.** State is in SQLite. Workers keep running in t3code while the super agent restarts, and it picks them up again. A run that t3code interrupted restarts with a recovery note. A failed turn is told to continue three times before the Ticket is reported failed.

## What you see in t3code

1. **One thread per Ticket.** Titled `[T-xxxxxxxx] <request>`, on branch `agent/<name>`. Open it to watch the worker, or type into it to step in.
2. **A pinned "Superagent" thread.** This is the console: ask it what needs you, start requests, answer questions, stop or retry work.
3. **An attention queue.** In the console, `superagent_attention` draws an interactive queue (an MCP App, which renders with Codex). The same view is at `/panel/<console token>` for t3code's browser tab.
4. **Links back.** Every acknowledgement and result the super agent posts ends with **Open in T3 Code**.
5. **A "Superagent Watchdog" thread.** Its agent schedules its own checks with t3code's scheduler, so it keeps checking even when the super agent is down. It checks the health of t3code, GitHub, the Router, the project list and the job queues, and whether each worker is making real progress. It can nudge a looping worker or retry a failed one; anything else becomes an alert in the console's attention queue. Only a person stops a ticket.

## Run it

Requirements: Node 22.19 or later, git, and `t3 serve` with the project added in t3code.

Each ticket keeps the project it was accepted into ("Tickets and projects" below). Console requests cannot name a project yet, so an unnamed one goes to the project `SUPERAGENT_PROJECT_ROOT` (or `SUPERAGENT_PROJECT_ID`) names, or, when none is set, to the one ready T3 Code project. Without a project set and with no ready project or several, the super agent starts console-only: it lists every T3 Code project (see "Projects" below) and refuses requests with "multi-project routing is not enabled yet". Naming the project in a request comes in phase 3a of [docs/multi-project-plan.md](docs/multi-project-plan.md).

Before the first start of this version on an existing state directory, copy `~/.superagent-t3` somewhere. The start also copies the database itself (see "Tickets and projects").

1. Sign the super agent in to t3code once with `npm run connect` (point 5); see "Sign-in" below.
2. In the t3code project's settings, turn off PR watching and "continue threads after server update". The super agent handles both (PLAN.md, ground rule 3).
3. Install and start:

```bash
npm install
```

```bash
T3_MCP_URL=http://127.0.0.1:3773/mcp npm run connect
```

```bash
T3_MCP_URL=http://127.0.0.1:3773/mcp \
SUPERAGENT_PROJECT_ROOT=/path/to/your/checkout \
SUPERAGENT_REPOSITORY=owner/name \
SUPERAGENT_GITHUB_LOGIN=<agent account> \
SUPERAGENT_GITHUB_ALLOWED=<your login> \
ANTHROPIC_API_KEY=<key> \
npm start
```

It prints every T3 Code project with its status, the counts (for example "2 ready, 3 no-git, 108 not-registered, 2 denied"), the console thread and the panel URL. Open the **Superagent** thread in t3code and ask, for example, "start a request: fix the typo in the README".

| Variable | Default | Meaning |
| --- | --- | --- |
| `T3_MCP_URL` | `http://127.0.0.1:3773/mcp` | The t3code environment's MCP URL (Settings → Environments → Copy MCP URL) |
| `T3_MCP_TOKEN` | the token `npm run connect` saved | An `mcp-client` token given directly |
| `SUPERAGENT_STATE_DIR` | `~/.superagent-t3` | The database, the saved t3code token and the other state files (below) |
| `SUPERAGENT_PROJECT_ROOT` | none: console-only | The checkout of the project workers use, as registered in t3code |
| `SUPERAGENT_PROJECT_ID` | found from the root | That project's t3code id; needed when two t3code projects have the same folder |
| `SUPERAGENT_WORKTREE_ROOT` | `<root>/../<name>-superagent` | Where that project's Ticket worktrees go |
| `SUPERAGENT_BASE_REF` | `HEAD` | What that project's new worktrees start from |
| `SUPERAGENT_CATALOGUE` | none | A `repositories.json` that describes the folders on this machine, such as `/Users/hextor/coding/repositories.json`; read again when it changes |
| `SUPERAGENT_PROJECTS_FILE` | `<state dir>/projects.json` | Per-project overrides (below); optional |
| `SUPERAGENT_PORT` / `SUPERAGENT_PUBLIC_URL` | `3790` / `http://127.0.0.1:3790` | Where t3code's agents reach this service |
| `SUPERAGENT_CONSOLE_TOKEN` | made once and kept in `<state dir>/console-token` | The secret in the console and panel URLs |
| `SUPERAGENT_OPERATOR` | `operator` | The operator's name on the console's allowed list |
| `SUPERAGENT_MAX_WORKERS` | `3` | Worker threads running at once |
| `SUPERAGENT_RUNTIME_MODE` | the token's ceiling | Runtime mode for worker threads |
| `SUPERAGENT_MODEL` | the project's default model | `<provider instance>/<model>`, such as `codex/gpt-6-astra`, for every thread it launches. Needed when the project has no default model in t3code; the model picker in t3code's project settings does not set one |
| `SUPERAGENT_GITHUB_LOGIN` | GitHub off | The agent's own GitHub account; mentions of it address the agent |
| `SUPERAGENT_GITHUB_ALLOWED` | nobody | Comma-separated logins that may ask for work on GitHub |
| `SUPERAGENT_GH` | `gh` | The agent account's GitHub CLI, or a wrapper that runs `gh` as that account |
| `SUPERAGENT_GITHUB_POLL_SECONDS` | `30` | How often GitHub is read |
| `SUPERAGENT_GITHUB_COMMIT_EMAIL` | none | The commit email the workers use |
| `SUPERAGENT_ROUTER` | `claude` with Anthropic credentials, else `rules` | `rules` only accepts explicit requests and relays results |
| `SUPERAGENT_ROUTER_MODEL` / `SUPERAGENT_ROUTER_EFFORT` | `claude-opus-5-5` / `medium` | The Router's model and effort |
| `SUPERAGENT_ACCEPT_MODE` | `observe` | Proactive work: `off`, `observe` (record what it would do) or `auto` |
| `SUPERAGENT_GITHUB_OBSERVE` | none | Which GitHub rows are read for proactive work even when nobody mentions the agent: `all`, `none`, or a comma list of `issues`, `pulls`, `comments`. Ignored when `SUPERAGENT_ACCEPT_MODE` is `off` |
| `SUPERAGENT_GITHUB_ADMISSION` | the prototype's table | The admission table as JSON, such as `{"comments":{"unlistedAddressed":"inferred"}}`, checked against the prototype's schema. Only the `issues`, `pulls` and `comments` rows |
| `SUPERAGENT_WATCHDOG_MINUTES` | `15` | Minutes between Watchdog checks; `0` turns it off |

The Router reads Anthropic credentials the way the SDK does: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or an `ant auth login` profile. It sends the default server-side refusal fallback (`fallbacks: "default"`), so a declined request is retried on a fallback model.

`SUPERAGENT_WORKTREE_ROOT`, `SUPERAGENT_BASE_REF` and `SUPERAGENT_REPOSITORY` belong to the project `SUPERAGENT_PROJECT_ROOT` names; setting them without it is refused. GitHub needs that project: with `SUPERAGENT_GITHUB_LOGIN` set and no project, the start is refused. A project that is set but does not resolve to a ready T3 Code project also refuses the start, as before. When t3code has that folder twice (a symlinked form of it), the one registered under the path `SUPERAGENT_PROJECT_ROOT` gives is used, as before; if neither matches it, set `SUPERAGENT_PROJECT_ID`. Setting both to different folders is refused. A project registered at a folder inside a git checkout, rather than its top level, still works there, as before, and the start says so. Starting without a project while tickets of an earlier version are open is refused once, at the migration (below); tickets made by this version keep their own project.

### State files

Everything goes in the state directory (`SUPERAGENT_STATE_DIR`, `~/.superagent-t3` by default); loading the configuration writes nothing, the start does:

- `state.sqlite`: the database.
- `t3-token.json`: the t3code sign-in (mode 600).
- `console-token`: the console token, made on the first start when `SUPERAGENT_CONSOLE_TOKEN` is not set (mode 600). The console and Watchdog threads and the panel URL now survive restarts without the variable. If it was not set before, the first start of this version makes one new console thread and one new Watchdog thread; archive the old ones in T3 Code.
- `superagent.lock`: the pid of the running instance. A second instance on the same state directory refuses to start; a lock whose process is gone is taken over, and so is one whose pid now belongs to a process that started after the lock was written (a pid reused after a crash or a reboot). When the start is refused, the message names the process; if it is not a superagent, delete the lock file. An instance of an earlier version takes no lock, so stop it before starting this one.
- `projects.json`: your overrides, if any.
- `state.sqlite.bak-<time>`: the copy of the database the first start of this version makes before binding old tickets to their project; delete it once you are happy.
- `worktrees/<project>/`: where ticket worktrees of projects other than the configured one go. The folder name comes from the project's key; when two keys give the same name, the second gets a short hash of its T3 Code id. t3code accepts worktrees outside the checkout's folder (see "Several projects on one t3code").

### Projects

The super agent reads T3 Code's project list at the start, every 5 minutes, and when the console asks (`superagent_projects` with `refresh`). It joins it with the catalogue, when `SUPERAGENT_CATALOGUE` is set, by real path (symlinks followed): a folder the catalogue lists gets its purpose and notes; a project inside a catalogued folder but not listed itself copies nothing from it. Catalogued linked worktrees (`git-worktree`) are shown under their main checkout. Git is asked again at every refresh, since the catalogue's git facts are historical.

Each project has a status:

| Status | Meaning |
| --- | --- |
| `ready` | Registered in T3 Code, a git checkout whose top level is the folder, not denied |
| `not-registered` | Catalogued only: add the folder as a project in T3 Code, then refresh |
| `no-git` | Not a git checkout, or a folder inside one rather than its top level. A catalogued folder whose `.git` file points at a git dir that is not on this machine (a checkout copied from elsewhere) is one too |
| `denied` | By `projects.json`, by default (`ARCHIVE/`, `PERSONAL/`, `FAMILY/` under the catalogue's workspace), or because it is a folder of the super agent's own worktrees (a `*-superagent` folder or one directly in it, `<state dir>/worktrees`, a `worktreeRoot` from `projects.json`) |
| `missing-checkout` | The folder no longer exists |
| `ambiguous` | Two T3 Code projects have the same folder (t3code takes a symlinked form of a registered root as a new project); name the one to use in `projects.json` by its id |
| `folded` | A linked worktree registered as its own project while its main checkout is registered too; work for that repository goes to the main checkout |

The console's `superagent_projects({ query?, status?, limit?, refresh? })` lists them with the reason, purpose, access, delivery and base ref. Catalogue text from `PERSONAL/` and `FAMILY/` is not sent to the console's model unless `projects.json` allows it.

To make a folder a project, once per project:

1. Add the folder as a project in T3 Code. The super agent cannot: its token is refused `t3_project_create`.
2. In that project's settings in T3 Code, turn off PR watching and "continue threads after server update". The super agent cannot read or change these settings.
3. Optionally, add an entry to `projects.json`.

`projects.json` maps a key to overrides. A key is a T3 Code project id, an absolute path, a catalogue path, or a prefix ending in `/` (absolute, or relative to the catalogue's workspace). The more specific key wins: an id over a path over a prefix, and a longer prefix over a shorter one. An entry for `ARCHIVE/`, `PERSONAL/` or `FAMILY/` replaces that default, and a longer one such as `ARCHIVE/tool/` overrides it there; a broader prefix, such as the whole workspace, does not lift the defaults. When two projects have the same key (two T3 Code projects with one title), the second gets its T3 Code id added; which one keeps the plain key does not change between refreshes. Unknown fields are refused, and an invalid file stops the start; a later refresh with an invalid file keeps the last good list.

```json
{
  "NDC/bardash": { "access": "named", "aliases": ["bardash", "bar"], "baseRef": "main", "dirty": "warn" },
  "PERSONAL/automix": { "access": "named", "describe": true },
  "COMMON/": { "access": "deny" }
}
```

| Field | Values | Meaning |
| --- | --- | --- |
| `access` | `work`, `named` (default), `deny` | `deny` never takes work. `named` and `work` differ only once the Router may pick a project itself |
| `aliases` | names | More names the console can use for the project |
| `delivery` | `pr`, `branch` | `branch`: commit on the ticket branch, no push, no pull request. Only the project `SUPERAGENT_REPOSITORY` maps to can use `pr` |
| `baseRef` | a ref | What new worktrees start from; default the local branch `origin/HEAD` names, else `main`, else `master` |
| `worktreeRoot` | an absolute path | Where the project's ticket worktrees go; default `<state dir>/worktrees/<project>` |
| `dirty` | `warn` (default), `refuse` | When the base is the branch checked out and the checkout has uncommitted changes |
| `describe` | `true`, `false` | Whether the catalogue's purpose and notes may be sent to models; `false` by default under `PERSONAL/` and `FAMILY/` |

The configured project keeps its own settings (`SUPERAGENT_WORKTREE_ROOT`, `SUPERAGENT_BASE_REF`, `SUPERAGENT_REPOSITORY`) and access `work`; only an entry for its own id or path can deny it.

### Tickets and projects

At its accept, each ticket is bound to one project, and the binding is stored with it (kv `ticket-project:<ticket id>`): the T3 Code project id, the checkout, the worktree folder, the base ref and the delivery, as they were then. Every launch, retry, restart and resume reads the project from there. Nothing at launch time picks a default: a ticket without a binding fails with "No project is recorded for this ticket", and a later change in T3 Code or `projects.json` never moves a ticket. An accept whose project is not ready, or that has no project, is rolled back, so no ticket is left. The rules router checks this before it accepts and ignores such a request with the reason, and `superagent_request` refuses one while the configured project is not ready as the last refresh saw it (its checkout went missing, say).

- **Worktrees.** The first launch checks that the checkout is still the same repository, that the base ref is a commit, and, when the base is the branch checked out (or `HEAD`), whether the checkout has uncommitted changes. With `dirty: warn` (the default) the worker is told the change count and that they are not in its worktree; with `dirty: refuse` the ticket fails before anything is written. The worktree starts from that commit, and its SHA is in the worker's first message. A worktree add runs one at a time per repository. A retry or a restart only checks that the folder is still a worktree of that repository, so a checkout that became dirty since does not fail it; a folder of another repository at that path fails the ticket.
- **T3 Code.** Before a new thread launches, the project list is read again when it is older than a minute. If T3 Code cannot be reached, the launch is tried again later; if it refuses the list (a token that may not read it), the ticket fails with that error. If `projects.json` or the catalogue cannot be read, the launch goes on with the last list read and the error is logged (and the `projects` health entry fails). If the project is no longer registered at the same folder, the ticket fails with a message to stop it and request the work again: re-adding a folder in T3 Code gives it a new id.
- **Delivery.** Only the project `SUPERAGENT_REPOSITORY` maps to delivers pull requests. Every other project, including the configured one without `SUPERAGENT_REPOSITORY`, gets `branch` delivery: the worker commits on the ticket branch and does not push or open a pull request, and its assignment says so, as its last line, also when a long assignment is cut. This is a change for a configured project without a repository, which used to be told to push.
- **To review.** A `branch` ticket ends as completed as soon as its worker reports ready. `superagent_attention` and the panel list it under `to_review` until its branch is merged into the project's default branch or deleted, with the `git worktree remove` and `git branch -d` commands for afterwards. The super agent deletes nothing. The list is made again at most once a minute.
- **Upgrading.** The first start of this version on an existing database copies it to `state.sqlite.bak-<time>` (with `VACUUM INTO`, before HTTP opens), then binds every ticket made before to the configured project, with the worktree folder each ticket already has. If there are such tickets and no project is configured, the start stops and names the copy: set `SUPERAGENT_PROJECT_ROOT` to the project they were made in for that start. Open tickets whose worktrees are not worktrees of that project are logged and left alone, which catches a mis-set `SUPERAGENT_PROJECT_ROOT`. A ticket bound this way that had pull-request delivery before and now has `branch` delivery (no `SUPERAGENT_REPOSITORY`) still gets the branch deliverable in its first message. A console request stored before the upgrade and not decided yet (held while paused, or waiting for the Router) counts as made for the configured project; with none configured it is refused, not given to the one ready project, which may be another folder. Later starts skip all of this.

## Sign-in (point 5)

t3code's `/mcp` endpoint accepts only outside-agent (`mcp-client`) sessions.

- **`npm run connect`** uses t3code's documented OAuth sign-in for outside agents: discovery, client registration, PKCE and a loopback redirect. It prints a page to open. On that page, approve with a pairing code from **Settings → Sharing & access** (or `t3 auth pairing create`), and choose the access: a runtime-mode ceiling that t3code enforces on every thread the super agent starts. Open the page in a browser on the machine where you ran `connect`, because the redirect returns to `127.0.0.1`. The token is saved with mode 600 in the state directory.
- **Alternatively**, on the t3code host, run:

  ```bash
  t3 auth session issue --subject mcp-client --scope orchestration:read --scope orchestration:operate --token-only
  ```

  Then pass the result as `T3_MCP_TOKEN`. A token issued this way is capped at `approval-required`, so workers stop at every tool that needs approval. Use `npm run connect` for a higher ceiling.

The session lasts 30 days, and t3code issues no refresh token. The super agent warns 3 days before expiry; run `npm run connect` again then. Users only ever sign in to t3code.

## Approvals and questions

When a worker waits on a person, its ticket shows in the attention queue:

- **A question** (t3code's `t3_pending_request`) is answered from the console with `superagent_answer`, or from the queue's buttons.
- **An approval** cannot be answered through `/mcp`; t3code answers approvals only in its own UI. The queue shows the request with an **Approve in T3 Code** link to the thread. The Watchdog raises an alert when an approval has waited a minute.

## Develop

```bash
npm run check
```

This runs the typecheck and the tests that need no t3code: an end-to-end run against an in-memory t3code with a real git checkout, the MCP contract the client sends, and the synthetic workload (below). `vendor/dsh/UPSTREAM` records the prototype commit the core was copied from; `vendor/dsh/src/policy.ts` has one change, an inlined constant. `tests/vendor-intact.spec.ts` hashes every file under `vendor/dsh` against `tests/fixtures/vendor-dsh.sha256`, so any edit to the vendored core fails the suite (`.gitattributes` keeps those files' line endings as committed); after a deliberate update, write the manifest again with the command in that spec's header.

### Live tests against a real t3code

```bash
npm run test:live
```

This starts its own isolated `t3 serve` for each suite (a temporary base directory and port, a scripted ACP agent as the only provider), so it never touches `~/.t3` or a running t3code. It needs `t3` on `PATH`, or `T3_BIN` set to the binary. Set `T3_LIVE_KEEP=1` to keep the temporary folders. The suites are in `tests/live/`: the contract of every `/mcp` tool the super agent uses, end-to-end runs with approvals and questions, a worker whose agent process crashes, read tracking, and the workload below. Approvals are answered the way t3code's web app does. Telemetry is off for every test server. The pull request link test runs t3's runtime binary (`~/.t3/runtime/versions/<version>/t3`, only read and run) with a temporary HOME, no GitHub tokens or git config, and a proxy that refuses every request.

#### Several projects on one t3code

The contract suite's "t3code with several projects" block probes what multi-project routing (docs/multi-project-plan.md) depends on. With t3code 0.1.6 it showed:

- **A worktree of another project is refused.** A launch whose `worktreePath` is not in `git worktree list` of the project's root gets `invalid_request` "worktreePath must be one of the project's git worktrees", whether the path is another repository's worktree, a plain folder, a missing folder or a subfolder of a worktree. The path is resolved first, so a symlinked form of a worktree's path is accepted. An unknown project id gets `invalid_request` "The project was not found." A replayed clientRequestId under an unknown project id gets `orchestration_error`.
- **Worktrees can live anywhere.** A worktree outside the checkout's parent folder, as under `<state dir>/worktrees/`, is accepted and runs normally.
- **Projects of one repository are not kept apart.** A linked worktree can be registered as a project of its own, and t3code then accepts each project's worktrees under the other's id, because both have the same `git worktree list`. The super agent has to tell them apart itself. A root that is already registered is refused again, also with a trailing slash, but a symlinked form of it becomes a second project for the same folder.
- **Threads can be listed and searched.** `t3_thread_list` (with `projectId` or `allProjects`) and `t3_thread_search` exist and work for a CLI-issued token; each row carries the thread's `projectId`. The search's own description says it covers active threads only and is not exhaustive.

The in-memory t3code (`tests/fake-t3.ts`) applies the same launch check when built with `checkWorktrees: true`; the test harness turns it on.

### Acceptance: the synthetic workload

```bash
npm run acceptance
npm run acceptance:live
```

The paper's workload (about 300 messages and 20 requests, generated from `WORKLOAD_SEED`, default 1) is played in memory with the Claude Router scripted, and with the rules router (`npm run acceptance`), then against an isolated t3code (`npm run acceptance:live`, about 45 s). The live run also takes `WORKLOAD_LIVE_ROUTER=rules` and `WORKLOAD_LIVE_SCALE` (such as `0.5`). The paper does not publish its per-category counts, so the mix is our own; see `tests/workload/workload.ts`.
