/**
 * Phase 4, Tier C (research/workload.md, section 7.4): the synthetic workload of Tiers A and B against a real, isolated
 * `t3 serve` (tests/live/t3-server.ts), with the same driver, scripted Router and checks (tests/workload/driver.ts and
 * tests/workload/properties.ts). Only the t3code side differs: worker threads launch in real worktrees, and the scripted ACP
 * agent (tests/live/scripted-agent.mjs) plays each worker inside t3code with tests/workload/worker-plan.mjs, so turns start,
 * take in steered messages, stop and end for real. The driver tells a worker when its simulated work is over and reads what
 * it did. GitHub stays FakeGitHub, and the Runtime's `link_pull_request` calls are recorded, not sent (see RecordingT3).
 *
 * The token is full-access, so no worker waits on an approval. Executor timing suits a real server: one-second waits and
 * quarter-second idle looks. The full workload plays in about 45 s of real time, so nothing is scaled down by default.
 *
 * Run with `T3_LIVE=1 npx vitest run tests/live/workload.spec.ts`. `WORKLOAD_SEED` picks the seed (1 by default),
 * `WORKLOAD_LIVE_ROUTER=rules` plays Tier B's rules router instead of Tier A's model-backed one, and `WORKLOAD_LIVE_SCALE`
 * scales the noise down (1 by default, the full workload).
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe } from 'vitest'
import { LiveWorkers, simulate } from '../workload/driver.ts'
import { acceptance } from '../workload/properties.ts'
import { PEOPLE, makeWorkload, messageCount } from '../workload/workload.ts'
import { live, skipReason, startT3, type T3Server } from './t3-server.ts'

const SEED = Number(process.env.WORKLOAD_SEED ?? 1)
const SCALE = Number(process.env.WORKLOAD_LIVE_SCALE ?? 1)
const ROUTER = process.env.WORKLOAD_LIVE_ROUTER === 'rules' ? 'rules' : 'claude'
const MAX_WORKERS = 3
const workload = makeWorkload(SEED, SCALE)
const TIMING = { waitMs: 1000, idlePollMs: 250, continueAfterMs: 1000, pendingCheckMs: 5000 }

describe.skipIf(!live)(`the synthetic workload, Tier C: a real t3code (${ROUTER} router)${live ? '' : ` (skipped: ${skipReason})`}`, () => {
  let server: T3Server | undefined
  let started = 0
  acceptance({
    name: `live ${ROUTER}`, workload, router: ROUTER, maxWorkers: MAX_WORKERS, timeoutMs: 15 * 60_000,
    minMessages: SCALE === 1 ? 280 : messageCount(workload),
    play: async () => {
      started = performance.now()
      // Never silently smaller: the log says what was left out.
      if (SCALE !== 1) console.log(`[workload live ${ROUTER}] scale ${SCALE}: the noise (chatter, CI, unauthorized and proactive messages) is scaled;`
        + ` ${messageCount(workload)} messages instead of the full workload's ${messageCount(makeWorkload(SEED, 1))}; all 20 requests are kept.`)
      // The signals folder is inside the server's folder, so it goes with it.
      let signals = ''
      server = await startT3({ environment: dir => {
        signals = join(dir, 'signals')
        mkdirSync(signals)
        return { SCRIPTED_AGENT_SIGNALS: signals, SCRIPTED_AGENT_PULLS: `https://github.com/${PEOPLE.repository}/pull/` }
      } })
      const t3 = await server.client('full-access', 'plain')
      const workers = new LiveWorkers({ t3, project: server.projectId, dir: server.dir, root: server.checkout, signals, timing: TIMING })
      const sim = await simulate({ workload, router: ROUTER, maxWorkers: MAX_WORKERS, workers })
      const calls = (tool: string) => workers.t3.calls.filter(call => call.tool === tool).length
      console.log(`[workload live ${ROUTER}] played in ${((performance.now() - started) / 1000).toFixed(0)} s of real time;`
        + ` t3code: ${workers.t3.workerThreads().length} worker threads, sends taken ${JSON.stringify(workers.t3.deliveries)},`
        + ` ${calls('t3_thread_interrupt')} interrupts, ${calls('link_pull_requests')} pull request links recorded and not sent.`)
      return sim
    },
    close: async () => { await server?.close() },
  })
})
