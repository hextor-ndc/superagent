/**
 * Phase 4 (PLAN.md): the acceptance test on the synthetic workload (tests/workload/workload.ts), in memory, with no model
 * and no t3code: research/workload.md, sections 7.2 (Tier A, the model-backed Router with a scripted model in observe
 * mode) and 7.3 (Tier B, the rules router). Each tier plays the whole workload once and checks the paper-level properties in
 * tests/workload/properties.ts, which the live Tier C (tests/live/workload.spec.ts) shares.
 */
import { describe, expect, it } from 'vitest'
import { simulate } from './driver.ts'
import { acceptance } from './properties.ts'
import { makeWorkload, type Workload } from './workload.ts'

/** `WORKLOAD_SEED` plays another seed's workload; `npm test` plays seed 1. */
const SEED = Number(process.env.WORKLOAD_SEED ?? 1)
const MAX_WORKERS = 3
const workload: Workload = makeWorkload(SEED, 1)
const tier = (router: 'claude' | 'rules') =>
  acceptance({ name: router, workload, router, maxWorkers: MAX_WORKERS, play: () => simulate({ workload, router, maxWorkers: MAX_WORKERS }) })

describe('the synthetic workload, Tier A: the model-backed Router (scripted) in observe mode', () => { tier('claude') })
describe('the synthetic workload, Tier B: the rules router', () => { tier('rules') })

// Keep the spec's view of the mix honest: it is ours, not the paper's (see workload.ts).
describe('the workload generator', () => {
  it('is pure: a seed gives the same workload, another seed a different one', () => {
    expect(JSON.stringify(makeWorkload(SEED).events)).toBe(JSON.stringify(makeWorkload(SEED).events))
    expect(JSON.stringify(makeWorkload(SEED + 1).events)).not.toBe(JSON.stringify(makeWorkload(SEED).events))
    expect(workload.requests).toHaveLength(20)
    expect(workload.counts).toMatchObject({ request: 20, followup: 30, stop: 4, answer: 4, review: 16, ci: 40, unauthorized: 10, proactive: 6 })
  })
})
