# superagent-t3

A super agent in the style of DeepSeek's *Exploring Super-agent Design*. It runs on top of an unmodified [t3code](https://github.com/pingdotgg/t3code).

- **Control plane:** DeepSeek's domain core, vendored unchanged from [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) (MIT, in `vendor/dsh/`). It decides who may ask for work, turns requests into Tickets, and reports back.
- **Execution:** t3code. Each Ticket is an ordinary t3code thread in its own worktree, so it appears in the t3code sidebar on desktop, web and mobile, with diffs, the terminal and notifications.
- **Integration:** the super agent talks to t3code only as an outside agent through its documented `/mcp` endpoint, so updating t3code doesn't touch this code.

See [PLAN.md](PLAN.md) for the design, the phases and what is still approximate.

## What you see in t3code

1. **One thread per Ticket.** Titled `[T-xxxxxxxx] <request>`, on branch `agent/<name>`. Open it to watch the worker, or type into it to step in.
2. **A pinned "Superagent" thread.** This is the console: ask it what needs you, start requests, answer questions, stop or retry work.
3. **An attention queue.** In the console, `superagent_attention` draws an interactive queue (an MCP App, which renders with Codex). The same view is at `/panel/<console token>` for t3code's browser tab.
4. **Links back.** Every acknowledgement and result the super agent posts ends with **Open in T3 Code**.

## Run it

Requirements: Node 22.19 or later, git, and `t3 serve` with the project added in t3code.

1. Create a token for the super agent. It signs in as an outside agent (point 5); see "Sign-in" below.
2. In the t3code project's settings, turn off PR watching and "continue threads after server update". The super agent handles both (PLAN.md, ground rule 3).
3. Install and start:

```bash
npm install
```

```bash
T3_MCP_URL=http://127.0.0.1:3773/mcp \
T3_MCP_TOKEN=<token> \
SUPERAGENT_PROJECT_ROOT=/path/to/your/checkout \
SUPERAGENT_REPOSITORY=owner/name \
npm start
```

It prints the console thread and the panel URL. Open the **Superagent** thread in t3code and ask, for example, "start a request: fix the typo in the README".

| Variable | Default | Meaning |
| --- | --- | --- |
| `T3_MCP_URL` | `http://127.0.0.1:3773/mcp` | The t3code environment's MCP URL (Settings → Environments → Copy MCP URL) |
| `T3_MCP_TOKEN` | required | An `mcp-client` token |
| `SUPERAGENT_PROJECT_ROOT` | required | The project's checkout, as registered in t3code |
| `SUPERAGENT_PROJECT_ID` | found from the root | The t3code project id |
| `SUPERAGENT_WORKTREE_ROOT` | `<root>/../<name>-superagent` | Where Ticket worktrees go |
| `SUPERAGENT_BASE_REF` | `HEAD` | What new worktrees start from |
| `SUPERAGENT_PORT` / `SUPERAGENT_PUBLIC_URL` | `3790` / `http://127.0.0.1:3790` | Where t3code's agents reach this service |
| `SUPERAGENT_CONSOLE_TOKEN` | random | The secret in the console and panel URLs; set it so they survive restarts |
| `SUPERAGENT_OPERATOR` | `operator` | The operator's name on the console's allowed list |
| `SUPERAGENT_MAX_WORKERS` | `3` | Worker threads running at once |
| `SUPERAGENT_RUNTIME_MODE` | the token's ceiling | Runtime mode for worker threads |

## Sign-in (point 5)

t3code's `/mcp` endpoint accepts only outside-agent (`mcp-client`) sessions. There are two ways to get one:

- **Now:** on the t3code host, run:

  ```bash
  t3 auth session issue --subject mcp-client --scopes orchestration:read,orchestration:operate --token-only
  ```

  Then pass the result as `T3_MCP_TOKEN`.
- **Phase 2:** `superagent connect` will use t3code's documented OAuth sign-in for outside agents. The owner approves it once, with a pairing code, and picks a runtime-mode ceiling that t3code enforces on every thread the super agent starts.

Users only ever sign in to t3code.

## Develop

```bash
npm run check
```

This runs the typecheck and the tests: an end-to-end run against an in-memory t3code with a real git checkout, plus the MCP contract the client sends. `vendor/dsh/UPSTREAM` records the prototype commit the core was copied from; `vendor/dsh/src/policy.ts` has one change, an inlined constant.
