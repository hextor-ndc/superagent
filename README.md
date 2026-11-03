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
5. **A "Superagent Watchdog" thread.** Its agent schedules its own checks with t3code's scheduler, so it keeps checking even when the super agent is down. It checks the health of t3code, GitHub, the Router and the job queues, and whether each worker is making real progress. It can nudge a looping worker or retry a failed one; anything else becomes an alert in the console's attention queue. Only a person stops a ticket.

## Run it

Requirements: Node 22.19 or later, git, and `t3 serve` with the project added in t3code.

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

It prints the console thread and the panel URL. Open the **Superagent** thread in t3code and ask, for example, "start a request: fix the typo in the README".

| Variable | Default | Meaning |
| --- | --- | --- |
| `T3_MCP_URL` | `http://127.0.0.1:3773/mcp` | The t3code environment's MCP URL (Settings → Environments → Copy MCP URL) |
| `T3_MCP_TOKEN` | the token `npm run connect` saved | An `mcp-client` token given directly |
| `SUPERAGENT_STATE_DIR` | `~/.superagent-t3` | The database and the saved t3code token |
| `SUPERAGENT_PROJECT_ROOT` | required | The project's checkout, as registered in t3code |
| `SUPERAGENT_PROJECT_ID` | found from the root | The t3code project id |
| `SUPERAGENT_WORKTREE_ROOT` | `<root>/../<name>-superagent` | Where Ticket worktrees go |
| `SUPERAGENT_BASE_REF` | `HEAD` | What new worktrees start from |
| `SUPERAGENT_PORT` / `SUPERAGENT_PUBLIC_URL` | `3790` / `http://127.0.0.1:3790` | Where t3code's agents reach this service |
| `SUPERAGENT_CONSOLE_TOKEN` | random | The secret in the console and panel URLs; set it so they survive restarts |
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

This runs the typecheck and the tests that need no t3code: an end-to-end run against an in-memory t3code with a real git checkout, the MCP contract the client sends, and the synthetic workload (below). `vendor/dsh/UPSTREAM` records the prototype commit the core was copied from; `vendor/dsh/src/policy.ts` has one change, an inlined constant.

### Live tests against a real t3code

```bash
npm run test:live
```

This starts its own isolated `t3 serve` for each suite (a temporary base directory and port, a scripted ACP agent as the only provider), so it never touches `~/.t3` or a running t3code. It needs `t3` on `PATH`, or `T3_BIN` set to the binary. Set `T3_LIVE_KEEP=1` to keep the temporary folders. The suites are in `tests/live/`: the contract of every `/mcp` tool the super agent uses, end-to-end runs with approvals and questions, read tracking, and the workload below.

### Acceptance: the synthetic workload

```bash
npm run acceptance
npm run acceptance:live
```

The paper's workload (about 300 messages and 20 requests, generated from `WORKLOAD_SEED`, default 1) is played in memory with the Claude Router scripted, and with the rules router (`npm run acceptance`), then against an isolated t3code (`npm run acceptance:live`, about 45 s). The live run also takes `WORKLOAD_LIVE_ROUTER=rules` and `WORKLOAD_LIVE_SCALE` (such as `0.5`). The paper does not publish its per-category counts, so the mix is our own; see `tests/workload/workload.ts`.
