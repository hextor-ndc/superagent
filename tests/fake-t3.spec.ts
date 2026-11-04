/**
 * The in-memory t3code itself: its scratch threads get real folders, and none of them outlive the test that made them. With
 * `checkWorktrees` its launches are refused as t3code refuses them (tests/live/contract.spec.ts, "t3code with several projects").
 */
import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { consoleTrigger } from '../src/app/console-source.ts'
import { T3Error, type LaunchInput } from '../src/t3/client.ts'
import { FakeT3, removeAllScratch, SCRATCH_PROJECT } from './fake-t3.ts'
import { checkout, git, harness, until, type Harness } from './harness.ts'

async function scratchFolder(t3: FakeT3, clientRequestId: string): Promise<string> {
  const launched = await t3.launchScratch({ title: 'Superagent', clientRequestId })
  return (await t3.read(launched.threadId)).thread.worktreePath!
}

describe('FakeT3 scratch threads', () => {
  it('gives each scratch thread its own folder, and removes them all when closed', async () => {
    const t3 = new FakeT3([])
    const console = await scratchFolder(t3, 'console')
    const watchdog = await scratchFolder(t3, 'watchdog')
    expect(console).not.toBe(watchdog)
    expect(await scratchFolder(t3, 'console')).toBe(console)
    expect(existsSync(console) && existsSync(watchdog)).toBe(true)
    await t3.close()
    expect(existsSync(console) || existsSync(watchdog) || existsSync(dirname(console))).toBe(false)
  })

  it('makes a new folder for a scratch launch after it was closed', async () => {
    const t3 = new FakeT3([])
    await scratchFolder(t3, 'console')
    await t3.close()
    const again = await scratchFolder(t3, 'watchdog')
    expect(existsSync(again)).toBe(true)
    await t3.close()
    expect(existsSync(again)).toBe(false)
  })

  it('removes the scratch folders of a FakeT3 nobody closed when the spec file ends', async () => {
    const folders = [await scratchFolder(new FakeT3([]), 'console'), await scratchFolder(new FakeT3([]), 'console')]
    expect(folders.every(folder => existsSync(folder))).toBe(true)
    // What the module's afterAll hook runs.
    removeAllScratch()
    expect(folders.some(folder => existsSync(folder) || existsSync(dirname(folder)))).toBe(false)
  })
})

describe('FakeT3 projects and worktree checks', () => {
  /** Two repositories in one temp dir, each with one worktree of its own beside it, registered as two projects. */
  function twoProjects(options: { checkWorktrees?: boolean } = { checkWorktrees: true }) {
    const widgets = checkout()
    const gadgets = checkout('gadgets', widgets.dir)
    const tree = (root: string, name: string) => {
      const path = join(widgets.dir, 'worktrees', name)
      git(root, 'worktree', 'add', '-q', '-b', `agent/${name}`, path, 'HEAD')
      return path
    }
    const t3 = new FakeT3([{ id: 'widgets-id', workspaceRoot: widgets.root }, { id: 'gadgets-id', workspaceRoot: gadgets.root }], options)
    return { t3, widgets, gadgets, widgetsTree: tree(widgets.root, 'w1'), gadgetsTree: tree(gadgets.root, 'g1') }
  }
  let requests = 0
  const launch = (t3: FakeT3, projectId: string, worktreePath: string, clientRequestId = `launch:${++requests}`) =>
    t3.launch({ projectId, title: '[T-1] work', message: 'Assignment', worktreePath, clientRequestId } satisfies LaunchInput)
  const refusal = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error)
  const notOneOfItsWorktrees = { tool: 't3_thread_launch', code: 'invalid_request', transient: false,
    message: expect.stringContaining('worktreePath must be one of the project\'s git worktrees') }

  it('records the project of each thread, and t3code\'s scratch project for a scratch thread, which it lists from then on', async () => {
    const { t3, widgetsTree, gadgetsTree } = twoProjects()
    const first = await launch(t3, 'widgets-id', widgetsTree)
    const second = await launch(t3, 'gadgets-id', gadgetsTree)
    expect((await t3.listProjects()).map(project => project.id)).toEqual(['widgets-id', 'gadgets-id'])
    const scratch = await t3.launchScratch({ title: 'Superagent', clientRequestId: 'console' })
    expect([first, second, scratch].map(launched => t3.threads.get(launched.threadId)!.projectId)).toEqual(['widgets-id', 'gadgets-id', SCRATCH_PROJECT])
    expect(scratch.projectId).toBe(SCRATCH_PROJECT)
    const folder = (await t3.read(scratch.threadId)).thread.worktreePath!
    expect((await t3.listProjects()).at(-1)).toEqual({ id: SCRATCH_PROJECT, title: 'No project', workspaceRoot: dirname(folder) })
    await t3.close()
  })

  it('with checkWorktrees, refuses an unknown project id, a path that is no worktree, and another repository\'s worktree', async () => {
    const { t3, widgets, gadgets, widgetsTree, gadgetsTree } = twoProjects()
    const unknown = await refusal(launch(t3, 'no-such-project', widgetsTree))
    expect(unknown).toBeInstanceOf(T3Error)
    expect(unknown).toMatchObject({ code: 'invalid_request', message: expect.stringContaining('The project was not found.') })
    expect(await refusal(launch(t3, 'gadgets-id', widgetsTree))).toMatchObject(notOneOfItsWorktrees)
    expect(await refusal(launch(t3, 'widgets-id', gadgets.root))).toMatchObject(notOneOfItsWorktrees)
    mkdirSync(join(widgetsTree, 'sub'))
    expect(await refusal(launch(t3, 'widgets-id', join(widgetsTree, 'sub')))).toMatchObject(notOneOfItsWorktrees)
    expect(await refusal(launch(t3, 'widgets-id', widgets.dir))).toMatchObject(notOneOfItsWorktrees)
    expect(await refusal(launch(t3, 'widgets-id', join(widgets.dir, 'missing')))).toMatchObject(notOneOfItsWorktrees)
    expect(t3.threads.size).toBe(0)
    // Each project's own worktrees and its main checkout are accepted, as t3code accepts them.
    for (const [projectId, path] of [['widgets-id', widgetsTree], ['gadgets-id', gadgetsTree], ['widgets-id', widgets.root]] as const) {
      expect(t3.threads.get((await launch(t3, projectId, path)).threadId)).toMatchObject({ projectId, worktreePath: path })
    }
    await t3.close()
  })

  it('with checkWorktrees, compares resolved paths and accepts any worktree of the same repository, as t3code does', async () => {
    const { t3, widgets, widgetsTree } = twoProjects()
    const link = join(widgets.dir, 'link-to-w1')
    symlinkSync(widgetsTree, link)
    await launch(t3, 'widgets-id', link)
    await launch(t3, 'widgets-id', `${widgetsTree}/`)
    // A project whose root is a linked worktree of widgets shares widgets' worktree list (contract probe 3).
    const linked = join(widgets.dir, 'widgets-linked')
    git(widgets.root, 'worktree', 'add', '-q', '-b', 'feature/linked', linked, 'HEAD')
    t3.addProject({ id: 'linked-id', workspaceRoot: linked })
    await launch(t3, 'linked-id', widgetsTree)
    expect(t3.threads.size).toBe(3)
    await t3.close()
  })

  it('with checkWorktrees, keeps nothing for a refused launch, so the same clientRequestId is checked again', async () => {
    const { t3, widgets } = twoProjects()
    const path = join(widgets.dir, 'worktrees', 'later')
    expect(await refusal(launch(t3, 'widgets-id', path, 'launch:later'))).toMatchObject(notOneOfItsWorktrees)
    git(widgets.root, 'worktree', 'add', '-q', '-b', 'agent/later', path, 'HEAD')
    const launched = await launch(t3, 'widgets-id', path, 'launch:later')
    expect(t3.threads.get(launched.threadId)).toMatchObject({ worktreePath: path })
    // A launch it answered is answered again under its clientRequestId, as t3code does, whatever the path says now.
    expect((await launch(t3, 'gadgets-id', '/nowhere', 'launch:later')).threadId).toBe(launched.threadId)
    await t3.close()
  })

  it('with checkWorktrees, refuses a replayed clientRequestId under an unknown or removed project id, as t3code does', async () => {
    const { t3, widgetsTree, gadgetsTree } = twoProjects()
    const launched = await launch(t3, 'gadgets-id', gadgetsTree, 'launch:replay')
    const notCompleted = { tool: 't3_thread_launch', code: 'orchestration_error', message: expect.stringContaining('The operation could not be completed.') }
    expect(await refusal(launch(t3, 'no-such-project', widgetsTree, 'launch:replay'))).toMatchObject(notCompleted)
    t3.removeProject('gadgets-id')
    expect(await refusal(launch(t3, 'gadgets-id', gadgetsTree, 'launch:replay'))).toMatchObject(notCompleted)
    // A listed project id still gets the stored thread.
    expect((await launch(t3, 'widgets-id', widgetsTree, 'launch:replay')).threadId).toBe(launched.threadId)
    expect(t3.threads.size).toBe(1)
    await t3.close()
  })

  it('without checkWorktrees, launches any project id and path, as before', async () => {
    const { t3, widgetsTree } = twoProjects({})
    expect(t3.checkWorktrees).toBeUndefined()
    const launched = [await launch(t3, 'no-such-project', '/unused'), await launch(t3, 'gadgets-id', widgetsTree)]
    expect(launched.map(item => t3.threads.get(item.threadId)!.projectId)).toEqual(['no-such-project', 'gadgets-id'])
    await t3.close()
  })

  it('adds and removes projects; a launch in a removed project is refused, and its threads keep their project', async () => {
    const { t3, gadgets, gadgetsTree } = twoProjects()
    const before = await t3.listProjects()
    const thread = await launch(t3, 'gadgets-id', gadgetsTree)
    t3.removeProject('gadgets-id')
    expect((await t3.listProjects()).map(project => project.id)).toEqual(['widgets-id'])
    // listProjects returns copies, so a list kept from before does not change.
    expect(before.map(project => project.id)).toEqual(['widgets-id', 'gadgets-id'])
    expect(await refusal(launch(t3, 'gadgets-id', gadgetsTree))).toMatchObject({ code: 'invalid_request', message: expect.stringContaining('The project was not found.') })
    expect(t3.threads.get(thread.threadId)!.projectId).toBe('gadgets-id')
    expect(() => t3.removeProject('gadgets-id')).toThrow(/no project/)
    // Adding the folder again gives it a new id, as in t3code; its worktrees launch under that id.
    t3.addProject({ id: 'gadgets-2', title: 'gadgets', workspaceRoot: gadgets.root })
    expect(await t3.listProjects()).toContainEqual({ id: 'gadgets-2', title: 'gadgets', workspaceRoot: gadgets.root })
    await launch(t3, 'gadgets-2', gadgetsTree)
    expect(() => t3.addProject({ id: 'gadgets-3', workspaceRoot: gadgets.root })).toThrow(/already registered/)
    expect(() => t3.addProject({ id: 'gadgets-4', workspaceRoot: `${gadgets.root}/` })).toThrow(/already registered/)
    // t3code does not follow symlinks here, so a symlinked form of a registered root is a second project for the same folder.
    const link = join(gadgets.dir, 'link-to-gadgets')
    symlinkSync(gadgets.root, link)
    t3.addProject({ id: 'gadgets-5', workspaceRoot: link })
    expect((await t3.listProjects()).map(project => project.id)).toEqual(['widgets-id', 'gadgets-2', 'gadgets-5'])
    expect(() => t3.addProject({ id: 'widgets-id', workspaceRoot: '/elsewhere' })).toThrow(/exists/)
    await t3.close()
  })
})

describe('the harness on a FakeT3', () => {
  let open: Harness[] = []
  afterEach(async () => { for (const item of open) await item.close().catch(() => {}); open = [] })

  it('checks worktrees, so a launch under a project id t3code does not know fails the assignment', async () => {
    const place = checkout()
    // The harness's Runtime launches in `project-1`; this t3code knows the checkout under another id.
    const t3 = new FakeT3([{ id: 'project-2', workspaceRoot: place.root }])
    const made = await harness(t3, place)
    open.push(made)
    expect(t3.checkWorktrees).toBe(true)
    made.runtime.engine.receive(consoleTrigger('hector', 'Fix the typo in the README'))
    const report = await until(() => made.runtime.repo.tickets.list()[0]?.assignments[0]?.report, 'the launch to be reported')
    expect(report).toMatchObject({ state: 'failed', summary: expect.stringContaining('t3_thread_launch: invalid_request: The project was not found.') })
    expect(t3.calls.filter(call => call.tool === 't3_thread_launch' && (call.args as LaunchInput).projectId === 'project-1')).toHaveLength(1)
    expect(t3.workerThreads()).toEqual([])
  })

  it('launches as before with the right project id, and leaves a FakeT3 that turned the check off alone', async () => {
    const place = checkout()
    const checked = new FakeT3([{ id: 'project-1', workspaceRoot: place.root }])
    open.push(await harness(checked, place))
    expect(checked.checkWorktrees).toBe(true)
    open[0]!.runtime.engine.receive(consoleTrigger('hector', 'Fix the typo in the README'))
    expect(await until(() => checked.workerThreads()[0], 'the worker thread')).toMatchObject({ projectId: 'project-1' })

    const other = checkout()
    const unchecked = new FakeT3([{ id: 'project-2', workspaceRoot: other.root }], { checkWorktrees: false })
    const made = await harness(unchecked, other)
    open.push(made)
    expect(unchecked.checkWorktrees).toBe(false)
    made.runtime.engine.receive(consoleTrigger('hector', 'Fix the typo in the README'))
    expect(await until(() => unchecked.workerThreads()[0], 'the unchecked worker thread')).toMatchObject({ projectId: 'project-1' })
  })
})
