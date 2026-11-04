/**
 * Phase 2 of docs/multi-project-plan.md: each ticket is bound to its project at its accept (kv `ticket-project:<id>`), and
 * every launch, retry, restart and resume takes its project from that binding alone. Worktrees of new projects go under
 * `<stateDir>/worktrees/<project>`, are made once from the project's default branch with the checks of 3.3, and are only
 * checked when used again. Projects without pull requests get branch delivery, and their finished tickets wait in the
 * review list until merged. Migration v1 binds an earlier version's tickets to the legacy project, after a backup, before
 * HTTP opens.
 *
 * Console-only (no GitHub), with the checkouts `widgets` and `gadgets` in one temp dir and FakeT3's `checkWorktrees` on.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { threadKey } from '../vendor/dsh/src/core/index.ts'
import { consoleTrigger } from '../src/app/console-source.ts'
import { SCHEMA_KEY } from '../src/app/migrate-projects.ts'
import { ProjectRegistry, resolveProject, type ProjectBinding } from '../src/app/projects.ts'
import { Runtime } from '../src/app/runtime.ts'
import { Store } from '../src/app/store.ts'
import type { Config, LegacyProject } from '../src/config.ts'
import { NO_BINDING, unregistered } from '../src/executor/t3-executor.ts'
import { BRANCH_DELIVERABLE, inputMessage } from '../src/executor/render.ts'
import { serial } from '../src/executor/workspace.ts'
import { serve } from '../src/http/server.ts'
import { attentionPage } from '../src/mcp/attention-app.ts'
import type { ModelCall } from '../src/router/claude-router.ts'
import { routerInstructions } from '../src/router/prompt.ts'
import { T3Error } from '../src/t3/client.ts'
import { FakeT3 } from './fake-t3.ts'
import { checkout, data, git, harness, mcp, until, type Harness } from './harness.ts'
import { commit, failure, fast, named, setup, workerLaunches, worktreesOf } from './two-projects.ts'


describe('tickets bound to their project', () => {
  let made: Harness | undefined
  afterEach(async () => { await made?.close(); made = undefined })

  it('launches a request that names gadgets in gadgets, from its default branch, with branch delivery', async () => {
    const place = checkout('widgets')
    checkout('gadgets', place.dir)
    const gadgets = join(place.dir, 'gadgets')
    // The operator is on a feature branch with a commit main does not have: new worktrees start from main (D14).
    const main = git(gadgets, 'rev-parse', 'main')
    git(gadgets, 'checkout', '-q', '-b', 'feature')
    commit(gadgets, 'feature.txt', 'wip\n')
    // And has uncommitted work there, which dirty: refuse would refuse if the base were the branch checked out.
    writeFileSync(join(gadgets, 'notes.txt'), 'mine\n')
    const env = await setup({ dir: place.dir, projects: { 'p-gadgets': { dirty: 'refuse' } } })
    made = env.made
    const trigger = named('Fix the gadget count', 'p-gadgets')
    made.runtime.engine.receive(trigger)
    const thread = await until(() => env.t3.workerThreads()[0], 'the worker thread')
    const ticketId = await env.ticketOf(trigger)
    const ticket = made.runtime.repo.tickets.get(ticketId)!

    expect(thread.projectId).toBe('p-gadgets')
    expect(made.runtime.binding(ticketId)).toMatchObject({ ticketId, projectId: 'p-gadgets', key: 'Gadgets', by: 'operator', delivery: 'branch',
      baseRef: 'main', defaultBranch: 'main', worktreeRoot: join(place.dir, 'state', 'worktrees', 'gadgets') })
    expect(ticket.execution!.directory).toBe(join(place.dir, 'state', 'worktrees', 'gadgets', ticket.execution!.name))
    expect(thread.worktreePath).toBe(ticket.execution!.directory)
    const path = realpathSync(thread.worktreePath!)
    expect(worktreesOf(gadgets)).toContain(path)
    expect(worktreesOf(env.widgets)).not.toContain(path)
    expect(git(path, 'rev-parse', 'HEAD')).toBe(main)
    expect(readFileSync(join(gadgets, '.git', 'info', 'exclude'), 'utf8').split('\n')).toContain('.mcp.json')
    expect(made.runtime.executor.thread(ticketId)).toMatchObject({ projectId: 'p-gadgets', baseSha: main })

    const text = thread.messages[0]!.text
    const assignment = text.slice(text.indexOf('## Assignment'), text.indexOf('## Source request'))
    expect(assignment).toContain(BRANCH_DELIVERABLE)
    expect(text).toContain(`## Delivery requirements\n${BRANCH_DELIVERABLE}`)
    expect(text).toContain(`## Project\n- Gadgets (Gadgets)\n- Checkout: ${realpathSync(env.gadgets)}`)
    expect(text).toContain(`- Base main at ${main}`)
    // The base is not the branch checked out, so the operator's changes there are not looked at.
    expect(git(gadgets, 'status', '--porcelain')).toContain('notes.txt')
    expect(text).not.toContain('uncommitted')
    expect(existsSync(join(path, 'notes.txt'))).toBe(false)
    expect(text).not.toContain('DSH_SUPERAGENT_GITHUB_REPOSITORY')
  })

  it('binds an unnamed accept to the legacy project when two projects are ready', async () => {
    const env = await setup()
    made = env.made
    const trigger = consoleTrigger('hector', 'Tidy the widget list')
    made.runtime.engine.receive(trigger)
    const thread = await until(() => env.t3.workerThreads()[0], 'the worker thread')
    expect(made.runtime.binding(await env.ticketOf(trigger))).toMatchObject({ projectId: 'p-widgets', by: 'legacy', worktreeRoot: join(env.dir, 'worktrees') })
    expect(thread.projectId).toBe('p-widgets')
    expect(worktreesOf(env.widgets)).toContain(realpathSync(thread.worktreePath!))
  })

  it('refuses an unnamed accept with no legacy project and two ready projects, leaving no ticket, decision or binding', async () => {
    const env = await setup({ legacy: false })
    made = env.made
    // The console refuses it before anything is stored.
    const console = await mcp(`${made.base}/mcp/console/console-secret`)
    const refused = await console.callTool({ name: 'superagent_request', arguments: { text: 'Tidy up' } })
    expect(JSON.stringify(refused.content)).toContain('No project is the default: no legacy project is set and 2 projects are ready')
    await console.close()
    // One that reaches the rules router another way is ignored with the reason.
    const ignored = consoleTrigger('hector', 'Tidy up')
    made.runtime.engine.receive(ignored)
    const decision = await until(() => made!.runtime.repo.decisions.byThread(threadKey(ignored.threads[0]!))[0], 'the decision')
    expect(decision).toMatchObject({ kind: 'ignore' })
    expect(JSON.stringify(decision)).toContain('Name the project: superagent_request with project=<key>')
    // An accept that reaches the Engine anyway, as from a Router that does not ask first, is rolled back at its binding.
    vi.spyOn(made.runtime, 'projectRefusal').mockReturnValue(undefined)
    const trigger = consoleTrigger('hector', 'Tidy up')
    made.runtime.engine.receive(trigger)
    await until(() => made!.errors.some(error => error.includes('No project is the default')), 'the refused accept')
    expect(made.runtime.repo.tickets.list()).toEqual([])
    expect(made.runtime.repo.decisions.byThread(threadKey(trigger.threads[0]!))).toEqual([])
    expect(made.runtime.repo.kv.list('ticket-project:')).toEqual([])
    expect(workerLaunches(env.t3)).toEqual([])
  })

  it('refuses a request that names a project without git at its accept', async () => {
    const place = checkout('widgets')
    checkout('gadgets', place.dir)
    mkdirSync(join(place.dir, 'notes'))
    const t3 = new FakeT3([{ id: 'p-widgets', workspaceRoot: place.root, title: 'Widgets' }, { id: 'p-gadgets', workspaceRoot: join(place.dir, 'gadgets'), title: 'Gadgets' },
      { id: 'p-notes', workspaceRoot: join(place.dir, 'notes'), title: 'Notes' }], { checkWorktrees: true })
    const env = await setup({ dir: place.dir, t3 })
    made = env.made
    const ignored = named('Write the notes up', 'p-notes')
    made.runtime.engine.receive(ignored)
    const decision = await until(() => made!.runtime.repo.decisions.byThread(threadKey(ignored.threads[0]!))[0], 'the decision')
    expect(decision).toMatchObject({ kind: 'ignore' })
    expect(JSON.stringify(decision)).toContain('Project Notes is no-git')
    vi.spyOn(made.runtime, 'projectRefusal').mockReturnValue(undefined)
    made.runtime.engine.receive(named('Write the notes up', 'p-notes'))
    await until(() => made!.errors.some(error => error.includes('Project Notes is no-git')), 'the refused accept')
    expect(made.runtime.repo.tickets.list()).toEqual([])
    expect(made.runtime.repo.kv.list('ticket-project:')).toEqual([])
  })

  it('relaunches a pending assignment in gadgets after a restart between accept and launch', async () => {
    const place = checkout('widgets')
    checkout('gadgets', place.dir)
    const database = join(place.dir, 'state.sqlite')
    const first = new FakeT3([{ id: 'p-widgets', workspaceRoot: place.root, title: 'Widgets' }, { id: 'p-gadgets', workspaceRoot: join(place.dir, 'gadgets'), title: 'Gadgets' }],
      { checkWorktrees: true })
    // The launch never answers, so the Assignment is still pending when the service stops.
    first.launch = () => new Promise(() => {})
    let env = await setup({ dir: place.dir, t3: first, database })
    made = env.made
    const trigger = named('Fix the gadget count', 'p-gadgets')
    made.runtime.engine.receive(trigger)
    const ticketId = await env.ticketOf(trigger)
    const directory = made.runtime.repo.tickets.get(ticketId)!.execution!.directory
    await until(() => existsSync(directory), 'the worktree')
    await made.close()

    env = await setup({ dir: place.dir, database })
    made = env.made
    const thread = await until(() => env.t3.workerThreads()[0], 'the relaunched thread')
    expect(thread).toMatchObject({ projectId: 'p-gadgets', worktreePath: directory })
    expect(made.runtime.binding(ticketId)).toMatchObject({ projectId: 'p-gadgets', by: 'operator' })
  })

  it('retries in the same thread and project, also once the checkout is dirty with dirty: refuse', async () => {
    const env = await setup({ projects: { 'p-gadgets': { dirty: 'refuse' } } })
    made = env.made
    const trigger = named('Fix the gadget count', 'p-gadgets')
    made.runtime.engine.receive(trigger)
    const thread = await until(() => env.t3.workerThreads()[0], 'the worker thread')
    const ticketId = await env.ticketOf(trigger)
    await until(() => made!.runtime.executor.busySince(ticketId), 'the running turn')
    made.runtime.engine.report(ticketId, { state: 'failed', summary: 'The build tool crashed.' })
    // The operator now has uncommitted work on main, the base of new worktrees.
    writeFileSync(join(env.gadgets, 'scratch.txt'), 'mine\n')
    const retried = made.runtime.engine.retryTicket(ticketId)
    const assignment = retried.assignments.at(-1)!
    await until(() => made!.runtime.repo.tickets.get(ticketId)!.assignments.at(-1)!.state === 'running', 'the retry running')
    const sent = env.t3.calls.find(call => call.tool === 't3_thread_send' && (call.args as { clientRequestId: string }).clientRequestId === `assign:${assignment.id}`)
    expect(sent?.args).toMatchObject({ threadId: thread.id })
    expect(env.t3.workerThreads()).toHaveLength(1)
    expect(workerLaunches(env.t3)).toHaveLength(1)
    expect(failure(made, ticketId)).toBe('The build tool crashed.')
  })

  it('fails a retry whose thread is in another project than the ticket\'s binding', async () => {
    const env = await setup()
    made = env.made
    const trigger = named('Fix the gadget count', 'p-gadgets')
    made.runtime.engine.receive(trigger)
    const ticketId = await env.ticketOf(trigger)
    await until(() => made!.runtime.executor.busySince(ticketId), 'the running turn')
    made.runtime.engine.report(ticketId, { state: 'failed', summary: 'The build tool crashed.' })
    // The binding row no longer matches the thread, as a hand edit of the database would leave it.
    made.runtime.repo.kv.set(`ticket-project:${ticketId}`, { ...made.runtime.binding(ticketId)!, projectId: 'p-widgets' })
    const sends = env.t3.calls.filter(call => call.tool === 't3_thread_send').length
    made.runtime.engine.retryTicket(ticketId)
    expect(await until(() => failure(made!, ticketId) !== 'The build tool crashed.' && failure(made!, ticketId), 'the failed retry'))
      .toContain('This ticket\'s thread is in T3 Code project p-gadgets, but the ticket is bound to Gadgets (p-widgets)')
    expect(env.t3.calls.filter(call => call.tool === 't3_thread_send')).toHaveLength(sends)
  })

  it('fails the ticket with the reroute text when gadgets left T3 Code before its launch', async () => {
    let accepted = false
    const env = await setup({ timing: { ...fast, projectsMaxAgeMs: 0 } })
    made = env.made
    const list = env.t3.listProjects.bind(env.t3)
    env.t3.listProjects = async () => {
      if (accepted && env.t3.projects.some(project => project.id === 'p-gadgets')) env.t3.removeProject('p-gadgets')
      return list()
    }
    accepted = true
    const trigger = named('Fix the gadget count', 'p-gadgets')
    made.runtime.engine.receive(trigger)
    const ticketId = await env.ticketOf(trigger)
    const binding = made.runtime.binding(ticketId)!
    expect(await until(() => failure(made!, ticketId), 'the failed launch')).toBe(unregistered(binding))
    expect(failure(made, ticketId)).toContain('is no longer registered in T3 Code at')
    expect(workerLaunches(env.t3)).toEqual([])
  })

  it('tries the launch again, without failing the ticket, while T3 Code cannot list its projects', async () => {
    const env = await setup({ timing: { ...fast, projectsMaxAgeMs: 0 } })
    made = env.made
    const list = env.t3.listProjects.bind(env.t3)
    let failures = 2
    env.t3.listProjects = async () => {
      if (failures > 0) { failures--; throw new T3Error('t3_project_list', 'network', 'fetch failed') }
      return list()
    }
    const trigger = named('Fix the gadget count', 'p-gadgets')
    made.runtime.engine.receive(trigger)
    const thread = await until(() => env.t3.workerThreads()[0], 'the worker thread after the retries')
    expect(thread.projectId).toBe('p-gadgets')
    expect(failure(made, await env.ticketOf(trigger))).toBeUndefined()
    expect(made.errors.filter(error => error.includes('Reading T3 Code\'s projects before launching'))).toHaveLength(2)
  })

  it('fails the ticket when a folder of another repository is at its worktree path', async () => {
    let accepted = false
    const env = await setup({ timing: { ...fast, projectsMaxAgeMs: 0 } })
    made = env.made
    const list = env.t3.listProjects.bind(env.t3)
    env.t3.listProjects = async () => {
      // Just before the launch prepares the worktree, someone made a repository where it goes.
      const ticket = accepted ? made!.runtime.repo.tickets.list()[0] : undefined
      if (ticket?.execution && !existsSync(ticket.execution.directory)) execFileSync('git', ['init', '-q', ticket.execution.directory])
      return list()
    }
    accepted = true
    const trigger = named('Fix the gadget count', 'p-gadgets')
    made.runtime.engine.receive(trigger)
    const ticketId = await env.ticketOf(trigger)
    const summary = await until(() => failure(made!, ticketId), 'the failed launch')
    expect(summary).toMatch(/^Preparing the worktree failed: .* is a worktree of another repository/)
    expect(workerLaunches(env.t3)).toEqual([])
  })

  it('refuses a dirty checkout with base HEAD and dirty: refuse before any git write', async () => {
    const env = await setup({ projects: { 'p-gadgets': { baseRef: 'HEAD', dirty: 'refuse' } } })
    made = env.made
    writeFileSync(join(env.gadgets, 'scratch.txt'), 'mine\n')
    const trigger = named('Fix the gadget count', 'p-gadgets')
    made.runtime.engine.receive(trigger)
    const ticketId = await env.ticketOf(trigger)
    const summary = await until(() => failure(made!, ticketId), 'the failed launch')
    expect(summary).toContain('has 1 uncommitted change on main, the base of new worktrees, and projects.json sets dirty to refuse')
    expect(existsSync(made.runtime.repo.tickets.get(ticketId)!.execution!.directory)).toBe(false)
    expect(worktreesOf(env.gadgets)).toHaveLength(1)
    expect(git(env.gadgets, 'branch', '--list', 'agent/*')).toBe('')
    expect(existsSync(join(env.gadgets, '.git', 'info', 'exclude')) ? readFileSync(join(env.gadgets, '.git', 'info', 'exclude'), 'utf8') : '').not.toContain('.mcp.json')
    expect(workerLaunches(env.t3)).toEqual([])
  })

  it('warns of a dirty checkout with base HEAD in the worker\'s variables', async () => {
    const env = await setup({ projects: { 'p-gadgets': { baseRef: 'HEAD' } } })
    made = env.made
    writeFileSync(join(env.gadgets, 'scratch.txt'), 'mine\n')
    writeFileSync(join(env.gadgets, 'README.md'), 'changed\n')
    made.runtime.engine.receive(named('Fix the gadget count', 'p-gadgets'))
    const thread = await until(() => env.t3.workerThreads()[0], 'the worker thread')
    const head = git(env.gadgets, 'rev-parse', 'HEAD')
    const variables = thread.messages[0]!.text.split('## Execution variables')[1]!.split('\n## ')[0]!
    expect(variables).toContain(`- Base HEAD at ${head}`)
    expect(variables).toContain(`- Base ${head.slice(0, 12)} on main; the checkout had 2 uncommitted changes that are not in this worktree.`)
    // The worktree has the last commit, not the changes.
    expect(readFileSync(join(thread.worktreePath!, 'README.md'), 'utf8')).toBe('# gadgets\n')
  })

  it('keeps the base line and the dirty note for a launch after a restart that came once the worktree was made', async () => {
    const place = checkout('widgets')
    const gadgets = checkout('gadgets', place.dir).root
    const database = join(place.dir, 'state.sqlite')
    const projects = { 'p-gadgets': { baseRef: 'HEAD' } }
    const first = new FakeT3([{ id: 'p-widgets', workspaceRoot: place.root, title: 'Widgets' }, { id: 'p-gadgets', workspaceRoot: gadgets, title: 'Gadgets' }],
      { checkWorktrees: true })
    // The launch never answers, so the service stops after the worktree was made and before the thread exists.
    let launched = false
    first.launch = () => { launched = true; return new Promise(() => {}) }
    writeFileSync(join(gadgets, 'scratch.txt'), 'mine\n')
    let env = await setup({ dir: place.dir, t3: first, database, projects })
    made = env.made
    const trigger = named('Fix the gadget count', 'p-gadgets')
    made.runtime.engine.receive(trigger)
    await env.ticketOf(trigger)
    await until(() => launched, 'the first launch')
    await made.close()

    env = await setup({ dir: place.dir, database, projects })
    made = env.made
    const thread = await until(() => env.t3.workerThreads()[0], 'the relaunched thread')
    const head = git(gadgets, 'rev-parse', 'HEAD')
    const variables = thread.messages[0]!.text.split('## Execution variables')[1]!.split('\n## ')[0]!
    expect(variables).toContain(`- Base HEAD at ${head}`)
    expect(variables).toContain(`- Base ${head.slice(0, 12)} on main; the checkout had 1 uncommitted change that is not in this worktree.`)
  })

  it('launches two tickets of one repository at once', async () => {
    const env = await setup()
    made = env.made
    made.runtime.engine.receive(named('Fix the gadget count', 'p-gadgets'))
    made.runtime.engine.receive(named('Rename the gadget module', 'p-gadgets'))
    const threads = await until(() => env.t3.workerThreads().length === 2 && env.t3.workerThreads(), 'both worker threads')
    expect(threads.map(thread => thread.projectId)).toEqual(['p-gadgets', 'p-gadgets'])
    for (const thread of threads) expect(worktreesOf(env.gadgets)).toContain(realpathSync(thread.worktreePath!))
    expect(made.runtime.repo.tickets.list().flatMap(ticket => failure(made!, ticket.id) ?? [])).toEqual([])
  })

  it('adds the worktrees of one repository one at a time, and of two repositories at once', async () => {
    const place = checkout('widgets')
    checkout('gadgets', place.dir)
    // A git that logs when each `git worktree add` starts and ends, and takes long enough that two at once would overlap.
    const bin = join(place.dir, 'bin'), log = join(place.dir, 'worktree-add.log')
    mkdirSync(bin)
    const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
    writeFileSync(join(bin, 'git'), ['#!/bin/sh', 'if [ "$1" = worktree ] && [ "$2" = add ]; then',
      `  echo "start $5" >> "${log}"`, '  sleep 0.3', `  "${real}" "$@"; code=$?`, `  echo "end $5" >> "${log}"`, '  exit $code', 'fi',
      `exec "${real}" "$@"`, ''].join('\n'), { mode: 0o755 })
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path}`
    try {
      const env = await setup({ dir: place.dir, config: { maxWorkers: 3 } })
      made = env.made
      made.runtime.engine.receive(named('Fix the gadget count', 'p-gadgets'))
      made.runtime.engine.receive(named('Rename the gadget module', 'p-gadgets'))
      made.runtime.engine.receive(consoleTrigger('hector', 'Fix the widget count'))
      await until(() => env.t3.workerThreads().length === 3, 'three worker threads', 8000)
    } finally { process.env.PATH = path }
    const lines = readFileSync(log, 'utf8').trim().split('\n')
    const gadgets = lines.filter(line => line.includes(`${join('worktrees', 'gadgets')}/`)).map(line => line.split(' ')[0])
    expect(gadgets).toEqual(['start', 'end', 'start', 'end'])
    // widgets is another repository, so its add does not wait for gadgets'.
    const at = (word: string, which: (line: string) => boolean) => lines.findIndex(line => line.startsWith(word) && which(line))
    const isWidgets = (line: string) => !line.includes(`${join('worktrees', 'gadgets')}/`)
    expect(at('start', isWidgets)).toBeLessThan(lines.findLastIndex(line => line.startsWith('end') && !isWidgets(line)))
    expect(at('end', isWidgets)).toBeGreaterThan(at('start', line => !isWidgets(line)))
  }, 15_000)

  it('fails a new thread\'s launch when the project\'s T3 Code root moved since the accept', async () => {
    const place = checkout('widgets')
    checkout('gadgets', place.dir)
    const gizmos = checkout('gizmos', place.dir).root
    let accepted = false
    const env = await setup({ dir: place.dir, timing: { ...fast, projectsMaxAgeMs: 0 } })
    made = env.made
    const list = env.t3.listProjects.bind(env.t3)
    env.t3.listProjects = async () => {
      // The same T3 Code id now names another folder.
      if (accepted && env.t3.projects.some(project => project.id === 'p-gadgets' && project.workspaceRoot === env.gadgets)) {
        env.t3.removeProject('p-gadgets')
        env.t3.addProject({ id: 'p-gadgets', workspaceRoot: gizmos, title: 'Gadgets' })
      }
      return list()
    }
    accepted = true
    const trigger = named('Fix the gadget count', 'p-gadgets')
    made.runtime.engine.receive(trigger)
    const ticketId = await env.ticketOf(trigger)
    expect(await until(() => failure(made!, ticketId), 'the failed launch')).toBe(unregistered(made.runtime.binding(ticketId)!))
    expect(workerLaunches(env.t3)).toEqual([])
  })

  it('fails a launch whose worktree is not inside its binding\'s worktree folder', async () => {
    const env = await setup()
    made = env.made
    const read = made.runtime.binding.bind(made.runtime)
    vi.spyOn(made.runtime, 'binding').mockImplementation(id => { const found = read(id); return found && { ...found, worktreeRoot: join(env.dir, 'elsewhere') } })
    const trigger = named('Fix the gadget count', 'p-gadgets')
    made.runtime.engine.receive(trigger)
    const ticketId = await env.ticketOf(trigger)
    const summary = await until(() => failure(made!, ticketId), 'the failed launch')
    expect(summary).toMatch(/^Preparing the worktree failed: .* is not inside the project's worktree folder .*elsewhere\.$/)
    expect(existsSync(made.runtime.repo.tickets.get(ticketId)!.execution!.directory)).toBe(false)
    expect(workerLaunches(env.t3)).toEqual([])
  })

  it('fails a new worktree when the project\'s checkout became another repository since the accept', async () => {
    let accepted = false
    const env = await setup({ timing: { ...fast, projectsMaxAgeMs: 0 } })
    made = env.made
    const list = env.t3.listProjects.bind(env.t3)
    env.t3.listProjects = async () => {
      // The folder is a checkout again, of a repository whose git dir is elsewhere.
      if (accepted && !existsSync(join(env.dir, 'other.git'))) {
        rmSync(join(env.gadgets, '.git'), { recursive: true, force: true })
        execFileSync('git', ['init', '-q', '-b', 'main', '--separate-git-dir', join(env.dir, 'other.git'), env.gadgets])
      }
      return list()
    }
    accepted = true
    const trigger = named('Fix the gadget count', 'p-gadgets')
    made.runtime.engine.receive(trigger)
    const ticketId = await env.ticketOf(trigger)
    const summary = await until(() => failure(made!, ticketId), 'the failed launch')
    expect(summary).toMatch(/^Preparing the worktree failed: .*gadgets is another repository than when the ticket was accepted: its git dir is .*other\.git/)
    expect(workerLaunches(env.t3)).toEqual([])
  })

  it('launches with the last good project list when projects.json became invalid after the start', async () => {
    const env = await setup({ timing: { ...fast, projectsMaxAgeMs: 0 } })
    made = env.made
    mkdirSync(join(env.dir, 'state'), { recursive: true })
    writeFileSync(join(env.dir, 'state', 'projects.json'), '{ not json')
    const trigger = consoleTrigger('hector', 'Tidy the widget list')
    made.runtime.engine.receive(trigger)
    const thread = await until(() => env.t3.workerThreads()[0], 'the worker thread')
    expect(thread.projectId).toBe('p-widgets')
    expect(failure(made, await env.ticketOf(trigger))).toBeUndefined()
    expect(made.errors.some(error => error.includes('checking its project against the last list read') && error.includes('projects.json is not JSON'))).toBe(true)
    expect(made.errors.filter(error => error.includes('launch:'))).toEqual([])
  })

  it('fails the ticket when T3 Code refuses to list its projects before the launch', async () => {
    const env = await setup({ timing: { ...fast, projectsMaxAgeMs: 0 } })
    made = env.made
    env.t3.listProjects = async () => { throw new T3Error('t3_project_list', 'capability_denied', 'not allowed') }
    const trigger = named('Fix the gadget count', 'p-gadgets')
    made.runtime.engine.receive(trigger)
    const ticketId = await env.ticketOf(trigger)
    expect(await until(() => failure(made!, ticketId), 'the failed launch')).toContain('Reading T3 Code\'s projects before the launch failed: t3_project_list: capability_denied')
    expect(workerLaunches(env.t3)).toEqual([])
  })

  it('ignores a request whose project became unavailable after the start, with the reason, and refuses it at the console', async () => {
    const env = await setup()
    made = env.made
    renameSync(env.widgets, `${env.widgets}-moved`)
    await made.runtime.projects.refresh()
    expect(made.runtime.projects.configuredLegacy()?.status).toBe('missing-checkout')
    const console = await mcp(`${made.base}/mcp/console/console-secret`)
    const refused = await console.callTool({ name: 'superagent_request', arguments: { text: 'Tidy the widget list' } })
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('Project Widgets is missing-checkout')
    expect(JSON.stringify(data(await console.callTool({ name: 'superagent_projects', arguments: {} })).work)).toContain('Project Widgets is missing-checkout')
    await console.close()
    // One that reaches the rules router another way, such as from GitHub, is ignored with the reason, not retried.
    const trigger = consoleTrigger('hector', 'Tidy the widget list')
    made.runtime.engine.receive(trigger)
    const decision = await until(() => made!.runtime.repo.decisions.byThread(threadKey(trigger.threads[0]!))[0], 'the decision')
    expect(decision).toMatchObject({ kind: 'ignore' })
    expect(JSON.stringify(decision)).toContain('Project Widgets is missing-checkout')
    expect(made.runtime.repo.tickets.list()).toEqual([])
    expect(made.errors.filter(error => error.includes('assess:'))).toEqual([])
  })

  it('tells a resumed branch ticket to look at git, and a resumed pull-request ticket at its pull request too', async () => {
    const env = await setup({ legacy: { repository: 'acme/widgets' } })
    made = env.made
    const gadgetsRequest = named('Fix the gadget count', 'p-gadgets'), widgetsRequest = consoleTrigger('hector', 'Fix the widget count')
    const requests = [gadgetsRequest, widgetsRequest]
    for (const request of requests) made.runtime.engine.receive(request)
    const ids = await Promise.all(requests.map(request => env.ticketOf(request)))
    for (const id of ids) {
      await until(() => made!.runtime.executor.busySince(id), 'the running turn')
      made.runtime.engine.report(id, { state: 'ready', summary: 'Done.' })
      expect(made.runtime.repo.tickets.get(id)!.ended?.outcome).toBe('completed')
    }
    // A follow-up on each request's own thread resumes its ticket.
    for (const request of requests) made.runtime.engine.receive(consoleTrigger('hector', 'Also update the changelog', request.threads[0]!))
    const resumedText = (projectId: string) => until(() => env.t3.workerThreads().find(thread => thread.projectId === projectId)!.messages
      .find(message => message.text.includes('resumed it under the same mandate'))?.text, `the resumed message in ${projectId}`)
    const branch = await resumedText('p-gadgets'), pr = await resumedText('p-widgets')
    expect(branch).toContain('inspect the worktree and git history and continue')
    expect(branch).not.toContain('PR state')
    expect(pr).toContain('inspect the worktree, git history and PR state and continue')
  })

  it('keeps the branch deliverable in the Assignment section of a long request', async () => {
    const env = await setup()
    made = env.made
    made.runtime.engine.receive(named(`Fix the gadget count.\n${'Some detail. '.repeat(200)}`, 'p-gadgets'))
    const thread = await until(() => env.t3.workerThreads()[0], 'the worker thread')
    const text = thread.messages[0]!.text
    const assignment = text.slice(text.indexOf('## Assignment'), text.indexOf('## Source request'))
    expect(assignment).toContain('… (read ticket/')
    expect(assignment).toContain(BRANCH_DELIVERABLE)
  })

  it('lists a completed branch ticket to review until its branch is merged into the default branch', async () => {
    // widgets has a repository, so pull-request delivery: its finished tickets are not in the list.
    const env = await setup({ legacy: { repository: 'acme/widgets' } })
    made = env.made
    const gadgetsRequest = named('Fix the gadget count', 'p-gadgets'), widgetsRequest = consoleTrigger('hector', 'Fix the widget count')
    made.runtime.engine.receive(gadgetsRequest)
    made.runtime.engine.receive(widgetsRequest)
    const ids = [await env.ticketOf(gadgetsRequest), await env.ticketOf(widgetsRequest)]
    for (const id of ids) await until(() => made!.runtime.executor.busySince(id), 'the running turn')
    expect(made.runtime.binding(ids[1]!)).toMatchObject({ delivery: 'pr' })
    const [gadgetsThread, widgetsThread] = ids.map(id => made!.runtime.executor.thread(id)!)
    const sha = commit(gadgetsThread!.worktreePath, 'count.txt', '3\n')
    commit(widgetsThread!.worktreePath, 'count.txt', '4\n')
    for (const id of ids) made.runtime.engine.report(id, { state: 'ready', summary: `Committed on ${made.runtime.executor.thread(id)!.branch}.` })
    for (const id of ids) expect(made.runtime.repo.tickets.get(id)!.ended?.outcome).toBe('completed')

    const listed = await made.runtime.toReview(0)
    expect(listed).toEqual([expect.objectContaining({ id: ids[0], project: 'Gadgets', branch: gadgetsThread!.branch, into: 'main',
      worktree: gadgetsThread!.worktreePath, summary: `Committed on ${gadgetsThread!.branch}.`,
      cleanup: [`git -C ${realpathSync(env.gadgets)} worktree remove ${gadgetsThread!.worktreePath}`, `git -C ${realpathSync(env.gadgets)} branch -d ${gadgetsThread!.branch}`] })])
    const console = await mcp(`${made.base}/mcp/console/console-secret`)
    expect(data(await console.callTool({ name: 'superagent_attention', arguments: {} }))).toMatchObject({ tickets: [], to_review: [{ id: ids[0] }] })
    await console.close()
    expect(await panelList(made.base)).toContain(`To review / merge</h2>`)
    expect(await panelList(made.base)).toContain(`Branch ${gadgetsThread!.branch}, not in main yet.`)

    git(env.gadgets, 'merge', '-q', '--ff-only', gadgetsThread!.branch)
    expect(git(env.gadgets, 'rev-parse', 'main')).toBe(sha)
    // The list is kept for a minute, then made again.
    expect(await made.runtime.toReview()).toHaveLength(1)
    expect(await made.runtime.toReview(0)).toEqual([])
  })

  it('tells the Router that a branch ticket\'s ready report is a complete result', async () => {
    const requests: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming[] = []
    const model: ModelCall = async params => {
      requests.push(structuredClone(params))
      const last = params.messages.at(-1)!.content as { type: string; text?: string }[]
      const card = last.flatMap(block => block.text?.startsWith('{') ? [JSON.parse(block.text) as { type: string; trigger_id: string }] : [])
        .find(item => item.type === 'candidate')
      const content = card ? [{ type: 'tool_use', id: `toolu_${requests.length}`, name: 'orchestrator_route', input: { decisions: [{ kind: 'accept',
        trigger_id: card.trigger_id, title: 'Fix the gadget count', worktree_name: 'fix-gadget-count', acknowledgement: 'Fixing it.' }] } }]
        : [{ type: 'text', text: 'ok' }]
      return { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: params.model, content, stop_reason: card ? 'tool_use' : 'end_turn',
        stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } as unknown as Anthropic.Beta.Messages.BetaMessage
    }
    const env = await setup({ config: { router: { kind: 'claude', model: 'claude-opus-5-5', effort: 'low', acceptMode: 'observe' } }, model })
    made = env.made
    const trigger = named('Fix the gadget count', 'p-gadgets')
    made.runtime.engine.receive(trigger)
    const ticketId = await env.ticketOf(trigger)
    expect(made.runtime.binding(ticketId)).toMatchObject({ projectId: 'p-gadgets', by: 'operator' })
    await until(() => made!.runtime.executor.busySince(ticketId), 'the running turn')
    const report = { state: 'ready' as const, summary: 'Committed abc123 on agent/fix-gadget-count.' }
    made.runtime.router.reported(made.runtime.engine.report(ticketId, report), report)
    const seen = await until(() => requests.find(request => JSON.stringify(request.messages.at(-1)).includes('worker_report')), 'the report to the Router')
    expect(JSON.stringify(seen.messages.at(-1))).toContain('\\"delivery\\":\\"branch\\"')
    expect(routerInstructions()).toContain('A worker report or question that says delivery "branch"')
  })
})

describe('migration v1', () => {
  let made: Harness | undefined
  afterEach(async () => { await made?.close(); made = undefined })

  /**
   * A database as the version before bindings left it: made by this harness, then with the binding rows and the marker
   * removed. That version wrote neither, and wrote everything else the same way.
   */
  async function oldDatabase(running = true) {
    const place = checkout('widgets')
    checkout('gadgets', place.dir)
    const database = join(place.dir, 'state.sqlite')
    const env = await setup({ dir: place.dir, database, legacy: { repository: 'acme/widgets' } })
    const trigger = consoleTrigger('hector', 'Speed up the widget build')
    env.made.runtime.engine.receive(trigger)
    const ticketId = await env.ticketOf(trigger)
    if (running) await until(() => env.made.runtime.executor.busySince(ticketId), 'the running turn')
    const directory = env.made.runtime.repo.tickets.get(ticketId)?.execution?.directory
    await env.made.close()
    const store = new Store(database)
    for (const key of [SCHEMA_KEY, `ticket-project:${ticketId}`]) store.kv.delete(key)
    store.close()
    return { place, database, t3: env.t3, ticketId, directory }
  }
  const backups = (dir: string) => readdirSync(dir).filter(name => name.startsWith('state.sqlite.bak-'))

  it('copies an old database, binds its tickets to the legacy project where their worktrees are, and resumes them', async () => {
    const old = await oldDatabase()
    const store = new Store(old.database)
    const directory = store.tickets.get(old.ticketId)!.execution!.directory
    store.close()
    // SUPERAGENT_WORKTREE_ROOT changed since: the old ticket stays where its worktree is.
    const env = await setup({ dir: old.place.dir, database: old.database, t3: old.t3,
      legacy: { repository: 'acme/widgets', worktreeRoot: join(old.place.dir, 'elsewhere') } })
    made = env.made
    expect(backups(old.place.dir)).toHaveLength(1)
    const copy = new Store(join(old.place.dir, backups(old.place.dir)[0]!))
    expect(copy.tickets.list().map(ticket => ticket.id)).toEqual([old.ticketId])
    expect(copy.kv.get(SCHEMA_KEY)).toBeUndefined()
    copy.close()
    expect(made.runtime.binding(old.ticketId)).toMatchObject({ projectId: 'p-widgets', by: 'legacy', delivery: 'pr', repository: 'acme/widgets',
      worktreeRoot: join(old.place.dir, 'worktrees') } satisfies Partial<ProjectBinding>)
    expect(directory.startsWith(join(old.place.dir, 'worktrees'))).toBe(true)
    expect(made.runtime.repo.kv.get(SCHEMA_KEY)).toMatchObject({ version: 1, migratedAt: expect.any(String), legacyProjectId: 'p-widgets' })
    // The running turn is watched again.
    await until(() => made!.runtime.executor.busySince(old.ticketId), 'the resumed turn')
    expect(made.errors.filter(error => error.includes('check SUPERAGENT_PROJECT_ROOT'))).toEqual([])
    // Idempotent: a second run copies and binds nothing.
    await made.runtime.prepare()
    expect(backups(old.place.dir)).toHaveLength(1)
  })

  /** Nothing of the migration is in the database: no binding and no marker. */
  const unmigrated = (database: string) => {
    const store = new Store(database)
    try { return store.kv.list('ticket-project:').length === 0 && store.kv.get(SCHEMA_KEY) === undefined } finally { store.close() }
  }
  const wrongRoot = (dir: string) => ({ t3: new FakeT3([{ id: 'p-gadgets', workspaceRoot: join(dir, 'gadgets'), title: 'Gadgets' }], { checkWorktrees: true }),
    legacy: { root: join(dir, 'gadgets'), worktreeRoot: join(dir, 'gw') } })

  it('refuses to start, binding nothing, when old open tickets\' worktrees are not of the legacy project, and binds them once it is set right', async () => {
    const old = await oldDatabase()
    // SUPERAGENT_PROJECT_ROOT set to the wrong checkout for the migration.
    const start = setup({ dir: old.place.dir, database: old.database, ...wrongRoot(old.place.dir) })
    await expect(start).rejects.toThrow(new RegExp(`An open ticket of an earlier version does not belong to the project SUPERAGENT_PROJECT_ROOT names, `
      + `Gadgets .*${old.directory} is a worktree of .*Set SUPERAGENT_PROJECT_ROOT to the project those tickets were made in.*Nothing was bound; `
      + 'a copy of the database from before is at .*state\\.sqlite\\.bak-'))
    expect(unmigrated(old.database)).toBe(true)
    expect(existsSync(old.directory!)).toBe(true)
    // With the variable fixed, the next start binds the ticket to the project its worktree is of.
    const env = await setup({ dir: old.place.dir, database: old.database, t3: old.t3, legacy: { repository: 'acme/widgets' } })
    made = env.made
    expect(made.runtime.binding(old.ticketId)).toMatchObject({ projectId: 'p-widgets', by: 'legacy' })
  })

  it('refuses to start when an old open ticket\'s worktree is not made yet and its folder is not the legacy project\'s', async () => {
    const old = await oldDatabase()
    // As a ticket the earlier version accepted and had not launched: no worktree, and no thread.
    git(join(old.place.dir, 'widgets'), 'worktree', 'remove', '--force', old.directory!)
    const store = new Store(old.database)
    store.kv.delete(`ticket-thread:${old.ticketId}`)
    store.close()
    const start = setup({ dir: old.place.dir, database: old.database, ...wrongRoot(old.place.dir) })
    await expect(start).rejects.toThrow(new RegExp(`its worktree ${old.directory} is not made yet, and its folder ${join(old.place.dir, 'worktrees')} `
      + `is not Gadgets's worktree folder ${join(old.place.dir, 'gw')}`))
    expect(unmigrated(old.database)).toBe(true)
    expect(git(join(old.place.dir, 'gadgets'), 'branch', '--list')).not.toContain('agent/')
  })

  it('refuses to start with old tickets and no legacy project, and names the copy of the database', async () => {
    const old = await oldDatabase()
    const start = setup({ dir: old.place.dir, database: old.database, t3: old.t3, legacy: false })
    await expect(start).rejects.toThrow(/1 ticket was made before tickets kept their own project.*Set SUPERAGENT_PROJECT_ROOT.*A copy of the database from before is at .*state\.sqlite\.bak-/)
    expect(backups(old.place.dir)).toHaveLength(1)
    const store = new Store(old.database)
    expect(store.kv.list('ticket-project:')).toEqual([])
    expect(store.kv.get(SCHEMA_KEY)).toBeUndefined()
    store.close()
  })

  it('does not open HTTP until the migration has finished, and not at all when it fails', async () => {
    const place = checkout()
    const t3 = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])
    const config: Config = { t3Url: 'unused', t3Token: 'unused', tokenFile: 'unused', stateDir: join(place.dir, 'state'), projectsFile: join(place.dir, 'state', 'projects.json'),
      legacy: { root: place.root, worktreeRoot: join(place.dir, 'worktrees'), baseRef: 'HEAD' }, router: { kind: 'rules', model: 'claude-opus-5-5', effort: 'medium', acceptMode: 'observe' },
      port: 0, publicUrl: '', consoleToken: 'console-secret', watchdogMinutes: 0, database: ':memory:', operator: 'hector', maxWorkers: 2, log: () => {} }
    const runtime = new Runtime(config, t3, { id: 'project-1', root: place.root })
    const port = await freePort()
    const healthy = () => fetch(`http://127.0.0.1:${port}/healthz`).then(response => response.ok, () => false)
    let finish!: () => void
    const migrate = runtime.prepare.bind(runtime)
    const prepare = vi.spyOn(runtime, 'prepare').mockImplementation(() => new Promise<void>(resolve => { finish = resolve }).then(migrate))
    const served = serve(runtime, port)
    await until(() => finish, 'the migration to start')
    expect(await healthy()).toBe(false)
    finish()
    const http = await served
    expect(await healthy()).toBe(true)
    expect(runtime.repo.kv.get(SCHEMA_KEY)).toMatchObject({ version: 1 })
    http.close()

    prepare.mockRejectedValueOnce(new Error('migration failed'))
    const other = await freePort()
    await expect(serve(runtime, other)).rejects.toThrow('migration failed')
    expect(await fetch(`http://127.0.0.1:${other}/healthz`).then(() => true, () => false)).toBe(false)
    await runtime.stop()
  })

  it('gives an open legacy ticket that now has branch delivery the deliverable, and lists its finished one to review', async () => {
    const place = checkout('widgets')
    checkout('gadgets', place.dir)
    const database = join(place.dir, 'state.sqlite')
    // The old version: the legacy project has no repository, one ticket finished on its branch, one is still to launch.
    const first = new FakeT3([{ id: 'p-widgets', workspaceRoot: place.root, title: 'Widgets' }], { checkWorktrees: true })
    const launch = first.launch.bind(first)
    let launches = 0
    first.launch = input => launches++ ? new Promise(() => {}) : launch(input)
    const old = await setup({ dir: place.dir, t3: first, database })
    const done = consoleTrigger('hector', 'Fix the widget count'), pending = consoleTrigger('hector', 'Rename the widget module')
    old.made.runtime.engine.receive(done)
    const doneId = await old.ticketOf(done)
    await until(() => old.made.runtime.executor.busySince(doneId), 'the running turn')
    commit(old.made.runtime.executor.thread(doneId)!.worktreePath, 'count.txt', '3\n')
    old.made.runtime.engine.report(doneId, { state: 'ready', summary: 'Committed.' })
    old.made.runtime.engine.receive(pending)
    const pendingId = await old.ticketOf(pending)
    await until(() => launches === 2, 'the second launch')
    await old.made.close()
    // That version wrote no bindings, no marker and no deliverable into the assignment.
    const store = new Store(database)
    for (const key of [SCHEMA_KEY, `ticket-project:${doneId}`, `ticket-project:${pendingId}`]) store.kv.delete(key)
    const stored = store.tickets.get(pendingId)!
    store.tickets.save({ ...stored, execution: { ...stored.execution!, assignment: stored.execution!.assignment.replace(`\n${BRANCH_DELIVERABLE}`, '') } })
    store.close()

    const env = await setup({ dir: place.dir, database, t3: new FakeT3([{ id: 'p-widgets', workspaceRoot: place.root, title: 'Widgets' }], { checkWorktrees: true }) })
    made = env.made
    expect(made.runtime.binding(pendingId)).toMatchObject({ by: 'legacy', delivery: 'branch' })
    expect(made.runtime.repo.tickets.get(pendingId)!.execution!.assignment).not.toContain(BRANCH_DELIVERABLE)
    const thread = await until(() => env.t3.workerThreads()[0], 'the relaunched thread')
    const text = thread.messages[0]!.text
    expect(text.slice(text.indexOf('## Assignment'), text.indexOf('## Source request'))).toContain(BRANCH_DELIVERABLE)
    expect(await made.runtime.toReview(0)).toEqual([expect.objectContaining({ id: doneId, project: 'Widgets', into: 'main' })])
  })

  it('refuses, rather than gives the one ready project, a console request held from before the upgrade with no legacy project', async () => {
    const place = checkout('widgets')
    checkout('gadgets', place.dir)
    const database = join(place.dir, 'state.sqlite')
    // The old version, paused, holds a console request; no ticket exists yet.
    const old = await setup({ dir: place.dir, database })
    old.made.runtime.setPaused(true)
    const held = consoleTrigger('hector', 'Fix the widget count')
    old.made.runtime.engine.receive(held)
    await old.made.close()
    const store = new Store(database)
    store.kv.delete(SCHEMA_KEY)
    store.close()
    await new Promise(resolve => setTimeout(resolve, 5))

    // Upgraded without SUPERAGENT_PROJECT_ROOT, and T3 Code has one ready project, which is not where the request was made.
    const env = await setup({ dir: place.dir, database, legacy: false,
      t3: new FakeT3([{ id: 'p-gadgets', workspaceRoot: join(place.dir, 'gadgets'), title: 'Gadgets' }], { checkWorktrees: true }) })
    made = env.made
    // A new request goes to the one ready project (D21).
    const fresh = consoleTrigger('hector', 'Fix the gadget count')
    made.runtime.setPaused(false)
    made.runtime.engine.receive(fresh)
    expect(made.runtime.binding(await env.ticketOf(fresh))).toMatchObject({ projectId: 'p-gadgets', by: 'single' })
    const decision = await until(() => made!.runtime.repo.decisions.byThread(threadKey(held.threads[0]!))[0], 'the decision on the held request')
    expect(decision).toMatchObject({ kind: 'ignore' })
    expect(JSON.stringify(decision)).toContain('before the super agent kept a project per ticket')
    expect(made.runtime.repo.tickets.list().filter(ticket => ticket.origin.triggerId === held.id)).toEqual([])
    expect(made.errors.filter(error => error.includes('assess:'))).toEqual([])
  })

  it('binds a console request held from before the upgrade to the legacy project as inherited', async () => {
    const place = checkout('widgets')
    checkout('gadgets', place.dir)
    const database = join(place.dir, 'state.sqlite')
    const old = await setup({ dir: place.dir, database })
    old.made.runtime.setPaused(true)
    const held = consoleTrigger('hector', 'Fix the widget count')
    old.made.runtime.engine.receive(held)
    await old.made.close()
    const store = new Store(database)
    store.kv.delete(SCHEMA_KEY)
    store.close()
    await new Promise(resolve => setTimeout(resolve, 5))
    const env = await setup({ dir: place.dir, database })
    made = env.made
    made.runtime.setPaused(false)
    expect(made.runtime.binding(await env.ticketOf(held))).toMatchObject({ projectId: 'p-widgets', by: 'inherited' })
  })

  it('fails a launch whose ticket has no binding, and does not default to the legacy project', async () => {
    const place = checkout('widgets')
    checkout('gadgets', place.dir)
    const database = join(place.dir, 'state.sqlite')
    const first = new FakeT3([{ id: 'p-widgets', workspaceRoot: place.root, title: 'Widgets' }, { id: 'p-gadgets', workspaceRoot: join(place.dir, 'gadgets'), title: 'Gadgets' }],
      { checkWorktrees: true })
    first.launch = () => new Promise(() => {})
    let env = await setup({ dir: place.dir, t3: first, database })
    const trigger = consoleTrigger('hector', 'Speed up the widget build')
    env.made.runtime.engine.receive(trigger)
    const ticketId = await env.ticketOf(trigger)
    await env.made.close()
    // The marker stays, so the migration does not bind it again.
    const store = new Store(database)
    store.kv.delete(`ticket-project:${ticketId}`)
    store.close()
    env = await setup({ dir: place.dir, database })
    made = env.made
    expect(await until(() => failure(made!, ticketId), 'the failed launch')).toBe(NO_BINDING)
    expect(workerLaunches(env.t3)).toEqual([])
  })
})

describe('project rules without a Runtime', () => {
  it('resolves an accept\'s project by the rules of 3.2', async () => {
    const place = checkout('widgets')
    checkout('gadgets', place.dir)
    const t3 = new FakeT3([{ id: 'p-widgets', workspaceRoot: place.root, title: 'Widgets' }, { id: 'p-gadgets', workspaceRoot: join(place.dir, 'gadgets'), title: 'Gadgets' }])
    const stateDir = join(place.dir, 'state')
    const legacy: LegacyProject = { root: place.root, worktreeRoot: join(place.dir, 'worktrees'), baseRef: 'HEAD' }
    const withLegacy = await ProjectRegistry.load({ t3, stateDir, legacy })
    const without = await ProjectRegistry.load({ t3, stateDir })
    const meta = (project?: string, projectBy?: string) => ({ meta: { scope: 'console', ...project ? { project } : {}, ...projectBy ? { projectBy } : {} } })
    const pick = (registry: ProjectRegistry, triggers: { meta: Record<string, unknown> }[], choice?: unknown) => {
      const { entry, by } = resolveProject(registry, { triggers, choice })
      return { key: entry.key, by }
    }
    expect(pick(withLegacy, [meta()])).toEqual({ key: 'Widgets', by: 'legacy' })
    expect(pick(withLegacy, [meta('p-gadgets', 'operator')])).toEqual({ key: 'Gadgets', by: 'operator' })
    expect(pick(withLegacy, [meta('p-gadgets', 'source')])).toEqual({ key: 'Gadgets', by: 'github' })
    expect(pick(withLegacy, [meta('p-gadgets', 'inherited')])).toEqual({ key: 'Gadgets', by: 'inherited' })
    // An explicit hint goes before an inherited one; a hint without a known `projectBy` is none.
    expect(pick(withLegacy, [meta('p-widgets', 'inherited'), meta('p-gadgets', 'operator')])).toEqual({ key: 'Gadgets', by: 'operator' })
    expect(pick(withLegacy, [meta('p-gadgets', 'router')])).toEqual({ key: 'Widgets', by: 'legacy' })
    expect(() => pick(withLegacy, [meta('p-gadgets', 'operator'), meta('p-widgets', 'operator')])).toThrow('name different projects')
    expect(() => pick(withLegacy, [meta()], 'p-gadgets')).toThrow('A Router choice of project is not enabled')
    expect(() => pick(withLegacy, [meta('p-widgets', 'operator')], 'p-gadgets')).toThrow('The request named p-widgets, and the route chose p-gadgets.')
    expect(() => pick(withLegacy, [meta('gizmos', 'operator')])).toThrow('No project gizmos in T3 Code')
    expect(() => pick(without, [meta()])).toThrow('No project is the default: no legacy project is set and 2 projects are ready (Gadgets, Widgets)')
    t3.removeProject('p-gadgets')
    await without.refresh()
    expect(pick(without, [meta()])).toEqual({ key: 'Widgets', by: 'single' })
  })

  it('tells a resumed branch ticket to look at git, not at a pull request', () => {
    const resumed = { id: 'input-1', kind: 'resumed', at: '2026-01-01T00:00:00.000Z' } as never
    expect(inputMessage(resumed, undefined, 'branch')).toContain('inspect the worktree and git history and continue')
    expect(inputMessage(resumed, undefined, 'branch')).not.toContain('PR state')
    expect(inputMessage(resumed)).toContain('inspect the worktree, git history and PR state and continue')
  })

  it('runs work under one key one at a time, and goes on after a failure', async () => {
    const log: string[] = []
    const step = (name: string, fail = false) => serial('repo', async () => {
      log.push(`${name} start`)
      await new Promise(resolve => setTimeout(resolve, 5))
      log.push(`${name} end`)
      if (fail) throw new Error(name)
      return name
    })
    const results = await Promise.allSettled([step('a'), step('b', true), step('c'), serial('other', async () => { log.push('other'); return 'other' })])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'fulfilled'])
    expect(log.filter(line => line !== 'other')).toEqual(['a start', 'a end', 'b start', 'b end', 'c start', 'c end'])
    // Another key does not wait.
    expect(log.indexOf('other')).toBeLessThan(log.indexOf('a end'))
  })
})

/** The panel's list as a browser would draw it from this service's HTTP API, with just enough of a DOM. */
async function panelList(base: string): Promise<string> {
  const html = attentionPage('panel', '/panel/console-secret')
  const script = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'))
  const nodes = { list: { innerHTML: '', textContent: '' }, note: { innerHTML: '', textContent: '' } }
  const document = { getElementById: (id: 'list' | 'note') => nodes[id], addEventListener() {}, documentElement: { dataset: {} } }
  new Function('document', 'window', 'fetch', 'setInterval', 'parent', script)(document, { addEventListener() {} },
    (url: string, init: RequestInit) => fetch(base + url, init), () => 0, undefined)
  return until(() => nodes.list.innerHTML.includes('row') && nodes.list.innerHTML, `the panel list (note: ${nodes.note.textContent})`)
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}
