/**
 * The project registry (docs/multi-project-plan.md, 3.1) against a fake t3code, a fixture catalogue and real git checkouts
 * in one temp dir: the join by real path, folding, exclusions, default denies, overrides, statuses, resolve, the legacy
 * project, default branches, and refreshes.
 */
import { mkdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Health } from '../src/app/health.ts'
import { ProjectRegistry, type ProjectEntry, type ProjectOverride } from '../src/app/projects.ts'
import type { LegacyProject } from '../src/config.ts'
import type { ProjectSummary } from '../src/t3/client.ts'
import { FakeT3 } from './fake-t3.ts'
import { checkout, git, until } from './harness.ts'

type CatalogueItem = { path: string; kind?: string; purpose?: string; notes?: string; related?: string[]; modules?: { path: string; responsibility: string }[] }

/** A workspace temp dir with a catalogue file and an optional projects.json. */
function workspace() {
  const { dir } = checkout('apps/widgets')
  const write = (repositories: CatalogueItem[]) => writeFileSync(join(dir, 'repositories.json'), JSON.stringify({ schema_version: 1, workspace: dir, repositories }))
  const overrides = (value: Record<string, ProjectOverride> | string) =>
    writeFileSync(join(dir, 'state', 'projects.json'), typeof value === 'string' ? value : JSON.stringify(value))
  mkdirSync(join(dir, 'state'), { recursive: true })
  const load = (t3: FakeT3, legacy?: LegacyProject) => ProjectRegistry.load({ t3, stateDir: join(dir, 'state'), legacy,
    catalogue: join(dir, 'repositories.json'), projectsFile: join(dir, 'state', 'projects.json') })
  return { dir, at: (path: string) => join(dir, path), real: (path: string) => realpathSync(join(dir, path)), write, overrides, load }
}
const byKey = (registry: ProjectRegistry, key: string): ProjectEntry => {
  const entry = registry.list().find(item => item.key === key)
  if (!entry) throw new Error(`no ${key} in ${registry.list().map(item => item.key).join(', ')}`)
  return entry
}
const project = (id: string, workspaceRoot: string, title?: string): ProjectSummary => ({ id, workspaceRoot, ...title ? { title } : {} })

describe('the project registry', () => {
  it('joins T3 Code projects to the catalogue by real path, and says for every folder whether work can go there', async () => {
    const ws = workspace()
    checkout('apps/gadgets', ws.dir)
    checkout('docs-only', ws.dir)
    checkout('ARCHIVE/old', ws.dir)
    checkout('PERSONAL/diary', ws.dir)
    checkout('sa-testrepo-superagent', ws.dir)
    checkout('state/worktrees/stray', ws.dir)
    mkdirSync(ws.at('tools/plain'), { recursive: true })
    mkdirSync(ws.at('notes'), { recursive: true })
    git(ws.at('apps/widgets'), 'worktree', 'add', '-q', '-b', 'feature', ws.at('widgets-feature'))
    // T3 Code has the checkout under a symlinked path; the catalogue names the real one (macOS's /tmp is itself a symlink).
    symlinkSync(ws.at('apps/widgets'), ws.at('link-widgets'))
    ws.write([
      { path: 'apps', kind: 'project-folder', purpose: 'All the apps.' },
      { path: 'apps/widgets', kind: 'git-repository', purpose: 'Widget shop.', notes: 'Payments live in src/pay.', related: ['apps/gadgets'],
        modules: [{ path: 'src/pay', responsibility: 'Payments' }] },
      { path: 'widgets-feature', kind: 'git-worktree', purpose: 'Widget shop, feature checkout.' },
      { path: 'docs-only', kind: 'git-repository', purpose: 'Docs.' },
      { path: 'notes', kind: 'project-folder', purpose: 'Notes.' },
      { path: 'PERSONAL/diary', kind: 'git-repository', purpose: 'Private diary.', notes: 'Private.' },
      { path: 'sa-testrepo-superagent', kind: 'git-repository', purpose: 'A test copy.' },
      { path: 'gone', kind: 'git-repository', purpose: 'Deleted since.' },
    ])
    const t3 = new FakeT3([project('p-widgets', ws.at('link-widgets'), 'Widgets'), project('p-gadgets', ws.at('apps/gadgets'), 'Gadgets'),
      project('p-plain', ws.at('tools/plain'), 'Plain'), project('p-old', ws.at('ARCHIVE/old'), 'Old'), project('p-diary', ws.at('PERSONAL/diary'), 'Diary'),
      project('p-stray', ws.at('state/worktrees/stray'), 'Stray'), project('p-missing', ws.at('vanished'), 'Vanished')])
    const registry = await ws.load(t3)

    // Exact real path beats the catalogued folder that contains it; its catalogue facts come along.
    expect(byKey(registry, 'apps/widgets')).toMatchObject({ id: 'p-widgets', title: 'Widgets', root: ws.real('apps/widgets'), status: 'ready',
      access: 'named', delivery: 'branch', defaultBranch: 'main', baseRef: 'main', legacy: false, describe: true,
      worktreeRoot: join(ws.dir, 'state', 'worktrees', 'apps-widgets'), worktrees: ['widgets-feature'],
      catalogue: { path: 'apps/widgets', kind: 'git-repository', purpose: 'Widget shop.', notes: 'Payments live in src/pay.', related: ['apps/gadgets'], modules: ['src/pay'] } })
    // A nested project the catalogue does not list keeps its T3 Code title and copies nothing from its parent.
    expect(byKey(registry, 'Gadgets')).toMatchObject({ status: 'ready', catalogue: { insideCatalogued: 'apps' } })
    expect(byKey(registry, 'Gadgets').catalogue).not.toHaveProperty('purpose')
    // The catalogued linked worktree folds into its checkout rather than showing as a folder to add.
    expect(registry.list().some(entry => entry.key === 'widgets-feature')).toBe(false)
    expect(byKey(registry, 'Plain')).toMatchObject({ status: 'no-git', reason: expect.stringContaining('not a git checkout') })
    expect(byKey(registry, 'docs-only')).toMatchObject({ status: 'not-registered', reason: `Add ${ws.real('docs-only')} as a project in T3 Code, then run superagent_projects with refresh.` })
    expect(byKey(registry, 'docs-only').id).toBeUndefined()
    expect(byKey(registry, 'notes')).toMatchObject({ status: 'no-git' })
    expect(byKey(registry, 'apps')).toMatchObject({ status: 'no-git', catalogue: { purpose: 'All the apps.' } })
    expect(byKey(registry, 'gone')).toMatchObject({ status: 'missing-checkout' })
    expect(byKey(registry, 'Vanished')).toMatchObject({ status: 'missing-checkout' })
    // The one default deny: ARCHIVE/, even for a project the catalogue does not list. PERSONAL/ takes work and is described
    // like any other folder (plan, open question 2, answered 2026-11-04).
    expect(byKey(registry, 'Old')).toMatchObject({ status: 'denied', access: 'deny', reason: 'Denied by default (ARCHIVE/).' })
    expect(byKey(registry, 'PERSONAL/diary')).toMatchObject({ status: 'ready', access: 'named', describe: true, catalogue: { purpose: 'Private diary.' } })
    // The super agent's own worktree folders are never projects.
    expect(registry.list().some(entry => entry.key === 'sa-testrepo-superagent')).toBe(false)
    expect(byKey(registry, 'Stray')).toMatchObject({ status: 'denied', reason: expect.stringContaining('where the super agent keeps ticket worktrees') })

    expect(registry.ready().map(entry => entry.key)).toEqual(['apps/widgets', 'Gadgets', 'PERSONAL/diary'])
    expect(registry.list()[0]!.status).toBe('ready')
    expect(registry.summary()).toBe('3 ready, 1 not-registered, 3 no-git, 2 denied, 2 missing-checkout')
    expect(registry.state()).toMatchObject({ refreshedAt: expect.any(String) })
    expect(registry.legacyProblem()).toBeUndefined()
  })

  it('takes access, aliases, base ref and catalogue sharing from projects.json, by id, path or prefix', async () => {
    const ws = workspace()
    checkout('apps/gadgets', ws.dir)
    checkout('PERSONAL/diary', ws.dir)
    checkout('PERSONAL/blog', ws.dir)
    ws.write([{ path: 'apps/widgets', purpose: 'Widget shop.' }, { path: 'PERSONAL/diary', purpose: 'Private diary.' }])
    ws.overrides({
      'apps/widgets': { access: 'work', aliases: ['shop'], baseRef: 'release', dirty: 'refuse', delivery: 'pr' },
      'p-gadgets': { access: 'deny' },
      // A prefix denies a folder and withholds its text; a more specific key wins over it.
      'PERSONAL/': { access: 'deny', describe: false },
      'PERSONAL/diary': { access: 'named', describe: true },
      [ws.at('PERSONAL/blog')]: { aliases: ['blog'] },
    })
    const t3 = new FakeT3([project('p-widgets', ws.at('apps/widgets'), 'Widgets'), project('p-gadgets', ws.at('apps/gadgets'), 'Gadgets'),
      project('p-diary', ws.at('PERSONAL/diary'), 'Diary'), project('p-blog', ws.at('PERSONAL/blog'), 'Blog')])
    const registry = await ws.load(t3)
    // `pr` delivery waits for GitHub across repositories (plan, phase 6): only the legacy project's repository gets it.
    expect(byKey(registry, 'apps/widgets')).toMatchObject({ status: 'ready', access: 'work', aliases: ['shop'], baseRef: 'release', dirty: 'refuse', delivery: 'branch' })
    expect(byKey(registry, 'Gadgets')).toMatchObject({ status: 'denied', reason: 'Denied by projects.json (p-gadgets).' })
    expect(byKey(registry, 'PERSONAL/diary')).toMatchObject({ status: 'ready', access: 'named', describe: true })
    expect(byKey(registry, 'Blog')).toMatchObject({ status: 'denied', aliases: ['blog'], describe: false, reason: 'Denied by projects.json (PERSONAL/).' })

    ws.overrides('{"apps/widgets": {"access": "everyone"}}')
    await expect(registry.refresh()).rejects.toThrow(/projects\.json is not valid: apps\/widgets\.access/)
    // A failed refresh keeps the last good list.
    expect(byKey(registry, 'apps/widgets').access).toBe('work')
    await expect(ws.load(t3)).rejects.toThrow(/projects\.json is not valid/)
    ws.overrides({ 'apps/widgets': { model: 'codex/gpt' } as ProjectOverride })
    await expect(ws.load(t3)).rejects.toThrow(/Unrecognized key/)
  })

  it('lets a broader projects.json prefix leave the default denies alone, and a more specific one lift them', async () => {
    const ws = workspace()
    checkout('ARCHIVE/old', ws.dir)
    checkout('ARCHIVE/kept', ws.dir)
    checkout('PERSONAL/diary', ws.dir)
    checkout('FAMILY/photos', ws.dir)
    ws.write([{ path: 'FAMILY/photos', purpose: 'Family photos.' }])
    ws.overrides({ [`${ws.real('.')}/`]: { access: 'work', describe: true }, 'ARCHIVE/kept/': { access: 'named' } })
    const registry = await ws.load(new FakeT3([project('p-widgets', ws.at('apps/widgets'), 'Widgets'), project('p-old', ws.at('ARCHIVE/old'), 'Old'),
      project('p-kept', ws.at('ARCHIVE/kept'), 'Kept'), project('p-diary', ws.at('PERSONAL/diary'), 'Diary'), project('p-photos', ws.at('FAMILY/photos'), 'Photos')]))
    expect(byKey(registry, 'Widgets')).toMatchObject({ status: 'ready', access: 'work' })
    expect(byKey(registry, 'Old')).toMatchObject({ status: 'denied', access: 'deny', reason: 'Denied by default (ARCHIVE/).' })
    // PERSONAL/ and FAMILY/ have no default, so the broader prefix applies to them.
    expect(byKey(registry, 'Diary')).toMatchObject({ status: 'ready', access: 'work', describe: true })
    expect(byKey(registry, 'FAMILY/photos')).toMatchObject({ status: 'ready', access: 'work', describe: true })
    expect(byKey(registry, 'Kept')).toMatchObject({ status: 'ready', access: 'named' })
  })

  it('lets PERSONAL/, FAMILY/ and COMMON/ take work and describes them, and denies only ARCHIVE/ by default', async () => {
    const ws = workspace()
    for (const path of ['PERSONAL/diary', 'FAMILY/photos', 'COMMON/tools', 'ARCHIVE/old']) checkout(path, ws.dir)
    checkout('PERSONAL/notes', ws.dir)
    ws.write([{ path: 'PERSONAL/diary', purpose: 'Private diary.', notes: 'Kept by hand.' }, { path: 'FAMILY/photos', purpose: 'Family photos.' },
      { path: 'COMMON/tools', purpose: 'Shared tools.' }, { path: 'ARCHIVE/old', purpose: 'Old work.' }, { path: 'PERSONAL/notes', purpose: 'Notes.' }])
    const registry = await ws.load(new FakeT3([project('p-diary', ws.at('PERSONAL/diary'), 'Diary'), project('p-photos', ws.at('FAMILY/photos'), 'Photos'),
      project('p-tools', ws.at('COMMON/tools'), 'Tools'), project('p-old', ws.at('ARCHIVE/old'), 'Old')]))
    for (const key of ['PERSONAL/diary', 'FAMILY/photos', 'COMMON/tools']) {
      expect(byKey(registry, key)).toMatchObject({ status: 'ready', access: 'named', describe: true })
    }
    expect(byKey(registry, 'PERSONAL/diary').catalogue).toMatchObject({ purpose: 'Private diary.', notes: 'Kept by hand.' })
    // A catalogued folder T3 Code does not have yet is one to add, not a denied one.
    expect(byKey(registry, 'PERSONAL/notes')).toMatchObject({ status: 'not-registered', access: 'named', describe: true })
    expect(byKey(registry, 'ARCHIVE/old')).toMatchObject({ status: 'denied', access: 'deny', reason: 'Denied by default (ARCHIVE/).' })
    // A folder that is not a project yet: only ARCHIVE/ and the worktree folders are refused (superagent_new_project asks this).
    expect(registry.denial(join(ws.real('PERSONAL'), 'garden'))).toBeUndefined()
    expect(registry.denial(join(ws.real('ARCHIVE'), 'garden'))).toBe('It is denied by default (ARCHIVE/).')
    expect(registry.denial(join(ws.real('state'), 'worktrees', 'x'))).toMatch(/^It is inside .*worktrees, where the super agent keeps ticket worktrees\.$/)
    ws.overrides({ 'FAMILY/': { access: 'deny' }, 'ARCHIVE/garden': { access: 'named' } })
    expect(registry.denial(join(ws.real('FAMILY'), 'garden'))).toBe('It is denied by projects.json (FAMILY/).')
    expect(registry.denial(join(ws.real('ARCHIVE'), 'garden'))).toBeUndefined()
  })

  it('puts a project\'s worktrees where projects.json says, and never takes a project inside that folder', async () => {
    const ws = workspace()
    checkout('elsewhere/agent-1', ws.dir)
    ws.write([])
    ws.overrides({ 'p-widgets': { worktreeRoot: ws.at('elsewhere') } })
    const registry = await ws.load(new FakeT3([project('p-widgets', ws.at('apps/widgets'), 'Widgets'), project('p-agent', ws.at('elsewhere/agent-1'), 'Agent')]))
    expect(byKey(registry, 'Widgets')).toMatchObject({ status: 'ready', worktreeRoot: ws.at('elsewhere') })
    expect(byKey(registry, 'Agent')).toMatchObject({ status: 'denied', reason: expect.stringContaining(`inside ${ws.real('elsewhere')}`) })
  })

  it('denies the old worktree layout, <name>-superagent and the folders directly in it, but not projects further below such a name', async () => {
    const ws = workspace()
    checkout('outer-superagent/apps/deep', ws.dir)
    checkout('other-superagent/agent-y', ws.dir)
    checkout('own-superagent', ws.dir)
    ws.write([])
    const registry = await ws.load(new FakeT3([project('p-deep', ws.at('outer-superagent/apps/deep'), 'Deep'),
      project('p-agent', ws.at('other-superagent/agent-y'), 'Agent'), project('p-own', ws.at('own-superagent'), 'Own')]))
    expect(byKey(registry, 'Deep').status).toBe('ready')
    expect(byKey(registry, 'Agent')).toMatchObject({ status: 'denied', reason: expect.stringContaining('a "-superagent" folder') })
    expect(byKey(registry, 'Own').status).toBe('denied')
  })

  it('reports a catalogued folder whose .git file points at a git dir that is not here as no-git', async () => {
    const ws = workspace()
    mkdirSync(ws.at('copied'))
    writeFileSync(ws.at('copied/.git'), 'gitdir: C:/Users/someone/repo/.git/worktrees/copied\n')
    git(ws.at('apps/widgets'), 'worktree', 'add', '-q', '-b', 'feature', ws.at('linked'))
    ws.write([{ path: 'copied', kind: 'git-worktree' }, { path: 'linked', kind: 'git-repository' }])
    const registry = await ws.load(new FakeT3([]))
    expect(byKey(registry, 'copied')).toMatchObject({ status: 'no-git',
      reason: `${ws.real('copied')} is not a git checkout here: its .git file points at C:/Users/someone/repo/.git/worktrees/copied, which does not exist on this machine.` })
    // A linked worktree's .git file whose git dir exists may be a checkout.
    expect(byKey(registry, 'linked').status).toBe('not-registered')
  })

  it('gives every project its own worktree folder, even when two keys make the same folder name', async () => {
    const ws = workspace()
    checkout('apps/gadgets', ws.dir)
    ws.write([{ path: 'apps/widgets' }])
    const registry = await ws.load(new FakeT3([project('p-widgets', ws.at('apps/widgets'), 'Widgets'), project('p-gadgets', ws.at('apps/gadgets'), 'Apps Widgets')]))
    expect(byKey(registry, 'apps/widgets').worktreeRoot).toBe(join(ws.dir, 'state', 'worktrees', 'apps-widgets'))
    expect(byKey(registry, 'Apps Widgets').worktreeRoot).toMatch(new RegExp(`^${join(ws.dir, 'state', 'worktrees', 'apps-widgets-')}[0-9a-f]{8}$`))
  })

  it('keeps the keys and worktree folders of two projects with one title when one of them is missing for a while', async () => {
    const ws = workspace()
    checkout('apps/gadgets', ws.dir)
    checkout('apps/gizmos', ws.dir)
    ws.write([])
    const t3 = new FakeT3([project('p-gizmos', ws.at('apps/gizmos'), 'Tools'), project('p-gadgets', ws.at('apps/gadgets'), 'Tools')])
    const registry = await ws.load(t3)
    const names = () => Object.fromEntries(registry.list().map(entry => [entry.id, [entry.key, entry.worktreeRoot]]))
    const before = names()
    expect(before['p-gadgets']).toEqual(['Tools', join(ws.dir, 'state', 'worktrees', 'tools')])
    expect(before['p-gizmos']).toEqual(['Tools [p-gizmos]', join(ws.dir, 'state', 'worktrees', 'tools-p-gizmos')])
    renameSync(ws.at('apps/gadgets'), ws.at('apps/gadgets-away'))
    await registry.refresh()
    expect(registry.list().find(entry => entry.id === 'p-gadgets')!.status).toBe('missing-checkout')
    expect(names()).toEqual(before)
    renameSync(ws.at('apps/gadgets-away'), ws.at('apps/gadgets'))
    await registry.refresh()
    expect(names()).toEqual(before)
  })

  it('resolves a name by id, key, alias, unique title, catalogue path and real path, and suggests otherwise', async () => {
    const ws = workspace()
    checkout('apps/gadgets', ws.dir)
    checkout('apps/gizmos', ws.dir)
    git(ws.at('apps/widgets'), 'worktree', 'add', '-q', '-b', 'feature', ws.at('widgets-feature'))
    symlinkSync(ws.at('apps/gadgets'), ws.at('link-gadgets'))
    ws.write([{ path: 'apps/widgets', purpose: 'Widget shop.' }, { path: 'widgets-feature', kind: 'git-worktree' }])
    ws.overrides({ 'apps/widgets': { aliases: ['Shop'] } })
    const t3 = new FakeT3([project('p-widgets', ws.at('apps/widgets'), 'Widgets'), project('p-gadgets', ws.at('apps/gadgets'), 'Tools'),
      project('p-gizmos', ws.at('apps/gizmos'), 'Tools')])
    const registry = await ws.load(t3)
    const key = (hint: string) => registry.resolve(hint).found?.key
    expect(key('p-gizmos')).toBe('Tools [p-gizmos]')
    expect(key('apps/widgets')).toBe('apps/widgets')
    expect(key('shop')).toBe('apps/widgets')
    expect(key('widgets')).toBe('apps/widgets')
    expect(key('widgets-feature')).toBe('apps/widgets')
    expect(key(ws.at('link-gadgets'))).toBe('Tools')
    // A title two projects share, and a near match, are never picked.
    expect(registry.resolve('tools')).toEqual({ suggestions: ['Tools', 'Tools [p-gizmos]'] })
    expect(registry.resolve('widget')).toEqual({ suggestions: ['apps/widgets'] })
    expect(registry.resolve('zzz')).toEqual({ suggestions: [] })
  })

  it('makes one folder registered twice ambiguous, unless projects.json names one of them by id', async () => {
    const ws = workspace()
    symlinkSync(ws.at('apps/widgets'), ws.at('link-widgets'))
    ws.write([])
    const t3 = new FakeT3([project('p-1', ws.at('apps/widgets'), 'Widgets'), project('p-2', ws.at('link-widgets'), 'Widgets again')])
    let registry = await ws.load(t3)
    expect(registry.list().map(entry => [entry.id, entry.status])).toEqual([['p-1', 'ambiguous'], ['p-2', 'ambiguous']])
    expect(registry.list()[0]!.reason).toContain('name one in projects.json by its T3 Code id')
    // The legacy project's root counts as naming it.
    const legacy = await ws.load(t3, { root: ws.at('apps/widgets'), baseRef: 'HEAD' })
    expect(legacy.list().map(entry => [entry.id, entry.status, entry.legacy])).toEqual([['p-1', 'ready', true], ['p-2', 'ambiguous', false]])
    ws.overrides({ 'p-2': { access: 'named' } })
    registry = await ws.load(t3)
    expect(registry.ready().map(entry => entry.id)).toEqual(['p-2'])
    expect(registry.list().find(entry => entry.id === 'p-1')).toMatchObject({ status: 'ambiguous', reason: 'The same folder as T3 Code project p-2, which takes its work.' })
    // An override that denies one of them names none: the other stays ambiguous.
    ws.overrides({ 'p-2': { access: 'deny' } })
    registry = await ws.load(t3)
    expect(registry.list().map(entry => [entry.id, entry.status])).toEqual([['p-2', 'denied'], ['p-1', 'ambiguous']])
  })

  it('folds a registered linked worktree into its registered main checkout, and routes one registered alone as itself', async () => {
    const ws = workspace()
    git(ws.at('apps/widgets'), 'worktree', 'add', '-q', '-b', 'feature', ws.at('widgets-feature'))
    ws.write([])
    const both = await ws.load(new FakeT3([project('p-main', ws.at('apps/widgets'), 'Widgets'), project('p-linked', ws.at('widgets-feature'), 'Feature')]))
    expect(byKey(both, 'Widgets')).toMatchObject({ status: 'ready', worktrees: ['Feature'] })
    expect(byKey(both, 'Feature')).toMatchObject({ status: 'folded', reason: `A linked worktree of ${ws.real('apps/widgets')}, which takes the repository's work.` })
    const alone = await ws.load(new FakeT3([project('p-linked', ws.at('widgets-feature'), 'Feature')]))
    expect(byKey(alone, 'Feature')).toMatchObject({ status: 'ready', commonDir: join(ws.real('apps/widgets'), '.git') })
  })

  it('marks a folder inside a checkout, rather than its top level, as no-git', async () => {
    const ws = workspace()
    mkdirSync(ws.at('apps/widgets/src'))
    ws.write([])
    const registry = await ws.load(new FakeT3([project('p-src', ws.at('apps/widgets/src'), 'Src')]))
    expect(byKey(registry, 'Src')).toMatchObject({ status: 'no-git', reason: expect.stringContaining('not its top level') })
  })

  it('finds the default branch from origin/HEAD, else main, else master, and starts new worktrees from it', async () => {
    const ws = workspace()
    const { root: trunk } = checkout('trunk', ws.dir)
    git(trunk, 'branch', 'trunk')
    git(trunk, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD')
    git(trunk, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk')
    const { root: old } = checkout('old', ws.dir)
    git(old, 'branch', '-m', 'main', 'master')
    const { root: odd } = checkout('odd', ws.dir)
    git(odd, 'branch', '-m', 'main', 'develop')
    ws.write([])
    const registry = await ws.load(new FakeT3([project('p-trunk', trunk, 'Trunk'), project('p-old', old, 'Old'), project('p-odd', odd, 'Odd'),
      project('p-widgets', ws.at('apps/widgets'), 'Widgets')]))
    expect(byKey(registry, 'Trunk')).toMatchObject({ defaultBranch: 'trunk', baseRef: 'trunk' })
    expect(byKey(registry, 'Old')).toMatchObject({ defaultBranch: 'master', baseRef: 'master' })
    expect(byKey(registry, 'Widgets')).toMatchObject({ defaultBranch: 'main', baseRef: 'main' })
    expect(byKey(registry, 'Odd').defaultBranch).toBeUndefined()
    expect(byKey(registry, 'Odd').baseRef).toBe('HEAD')
  })

  it('denies a registered linked worktree of a denied repository, wherever the worktree folder is', async () => {
    const ws = workspace()
    checkout('ARCHIVE/diary', ws.dir)
    git(ws.at('ARCHIVE/diary'), 'worktree', 'add', '-q', '-b', 'side', ws.at('apps/diary-side'))
    ws.write([{ path: 'ARCHIVE/diary' }, { path: 'apps/diary-side' }])
    // Its main checkout registered too, and denied by the ARCHIVE/ default: the worktree is denied, not ready.
    const both = await ws.load(new FakeT3([project('p-diary', ws.at('ARCHIVE/diary'), 'Diary'), project('p-side', ws.at('apps/diary-side'), 'Side')]))
    expect(byKey(both, 'ARCHIVE/diary')).toMatchObject({ status: 'denied' })
    expect(byKey(both, 'apps/diary-side')).toMatchObject({ status: 'denied',
      reason: `A linked worktree of ${ws.real('ARCHIVE/diary')}, which is denied: Denied by default (ARCHIVE/).` })
    // Registered alone, it is denied by the rule on its repository's folder.
    const alone = await ws.load(new FakeT3([project('p-side', ws.at('apps/diary-side'), 'Side')]))
    expect(byKey(alone, 'apps/diary-side')).toMatchObject({ status: 'denied',
      reason: `A linked worktree of ${ws.real('ARCHIVE/diary')}, which is denied by default (ARCHIVE/).` })
    // An override by id that lets the registered main checkout take work lifts it for the worktree too, which folds into it.
    ws.overrides({ 'p-diary': { access: 'named' } })
    expect(byKey(await ws.load(new FakeT3([project('p-diary', ws.at('ARCHIVE/diary'), 'Diary'), project('p-side', ws.at('apps/diary-side'), 'Side')])),
      'apps/diary-side')).toMatchObject({ status: 'folded' })
    // Once projects.json lets the repository's folder take work, the worktree folds into its main checkout, or works alone.
    ws.overrides({ 'ARCHIVE/diary': { access: 'named' } })
    expect(byKey(await ws.load(new FakeT3([project('p-diary', ws.at('ARCHIVE/diary'), 'Diary'), project('p-side', ws.at('apps/diary-side'), 'Side')])),
      'apps/diary-side')).toMatchObject({ status: 'folded' })
    expect(byKey(await ws.load(new FakeT3([project('p-side', ws.at('apps/diary-side'), 'Side')])), 'apps/diary-side')).toMatchObject({ status: 'ready' })
  })

  it('gives pr delivery from projects.json only to the legacy project with a repository', async () => {
    const ws = workspace()
    ws.write([])
    const widgets = ws.at('apps/widgets')
    ws.overrides({ [widgets]: { delivery: 'pr' } })
    const t3 = new FakeT3([project('p-widgets', widgets, 'Widgets')])
    expect((await ws.load(t3, { root: widgets, baseRef: 'HEAD' })).legacy()).toMatchObject({ delivery: 'branch' })
    expect((await ws.load(t3, { root: widgets, baseRef: 'HEAD', repository: 'acme/widgets' })).legacy()).toMatchObject({ delivery: 'pr', repository: 'acme/widgets' })
    ws.overrides({ [widgets]: { delivery: 'branch' } })
    expect((await ws.load(t3, { root: widgets, baseRef: 'HEAD', repository: 'acme/widgets' })).legacy()).toMatchObject({ delivery: 'branch' })
  })

  it('keeps a projects.json prefix\'s describe: false for a legacy project under it, while it works there', async () => {
    const ws = workspace()
    const { root: diary } = checkout('PERSONAL/diary', ws.dir)
    ws.write([{ path: 'PERSONAL/diary', purpose: 'Private diary.', notes: 'Private.' }])
    ws.overrides({ 'PERSONAL/': { access: 'deny', describe: false } })
    const t3 = new FakeT3([project('p-diary', diary, 'Diary')])
    const registry = await ws.load(t3, { root: diary, baseRef: 'HEAD' })
    expect(registry.legacy()).toMatchObject({ status: 'ready', access: 'work', legacy: true, describe: false })
    // projects.json can still allow it, by its path.
    ws.overrides({ 'PERSONAL/': { access: 'deny', describe: false }, 'PERSONAL/diary': { describe: true } })
    expect((await ws.load(t3, { root: diary, baseRef: 'HEAD' })).legacy()).toMatchObject({ access: 'work', describe: true })
  })

  it('keeps the legacy project\'s own settings, finds it by root or id, and says why it does not resolve', async () => {
    const ws = workspace()
    const { root: archived } = checkout('ARCHIVE/legacy', ws.dir)
    ws.write([{ path: 'ARCHIVE/legacy', purpose: 'The old project.' }])
    const t3 = new FakeT3([project('p-legacy', archived, 'Legacy'), project('p-widgets', ws.at('apps/widgets'), 'Widgets')])
    // By root: access `work` whatever a prefix says, the old derived worktree root, its base ref and repository.
    const byRoot = await ws.load(t3, { root: archived, worktreeRoot: join(ws.dir, 'ARCHIVE', 'legacy-superagent'), baseRef: 'HEAD', repository: 'acme/legacy' })
    expect(byRoot.legacy()).toMatchObject({ id: 'p-legacy', key: 'ARCHIVE/legacy', status: 'ready', access: 'work', legacy: true, delivery: 'pr',
      repository: 'acme/legacy', baseRef: 'HEAD', worktreeRoot: join(ws.dir, 'ARCHIVE', 'legacy-superagent') })
    expect(byRoot.list()[0]!.legacy).toBe(true)
    // By id alone: the worktree root is derived from t3code's root, and without a repository delivery is `branch`.
    const byId = await ws.load(t3, { id: 'p-widgets', baseRef: 'HEAD' })
    expect(byId.legacy()).toMatchObject({ id: 'p-widgets', worktreeRoot: join(ws.dir, 'apps', 'widgets-superagent'), delivery: 'branch', baseRef: 'HEAD' })
    // The legacy worktree root is the super agent's: a project inside it is denied.
    checkout('apps/widgets-superagent/agent-x', ws.dir)
    t3.addProject(project('p-agent', ws.at('apps/widgets-superagent/agent-x'), 'Agent'))
    expect(byKey(await ws.load(t3, { id: 'p-widgets', baseRef: 'HEAD' }), 'Agent').status).toBe('denied')

    const unknown = await ws.load(t3, { root: ws.at('nowhere'), baseRef: 'HEAD' })
    expect(unknown.legacy()).toBeUndefined()
    expect(unknown.legacyProblem()).toBe(`No T3 Code project at ${ws.at('nowhere')}. Add the folder as a project in T3 Code first.`)
    // An explicit deny of the legacy project itself stops it, so the start fails rather than works there.
    ws.overrides({ 'p-legacy': { access: 'deny' } })
    const denied = await ws.load(t3, { root: archived, baseRef: 'HEAD' })
    expect(denied.legacy()).toBeUndefined()
    expect(denied.legacyProblem()).toMatch(/^The legacy project .* is denied: Denied by projects\.json \(p-legacy\)\.$/)
    ws.overrides({})
    // One folder registered twice: the registration under the path SUPERAGENT_PROJECT_ROOT gives is the legacy project, as
    // before, and the other takes no work (here denied first, as its real path is under ARCHIVE/). A third form of the path
    // matches neither, so the id has to be set.
    symlinkSync(archived, ws.at('link-legacy'))
    symlinkSync(archived, ws.at('link-legacy-2'))
    t3.addProject(project('p-twin', ws.at('link-legacy'), 'Twin'))
    const twice = await ws.load(t3, { root: archived, baseRef: 'HEAD' })
    expect(twice.legacy()?.id).toBe('p-legacy')
    expect(twice.list().find(entry => entry.id === 'p-twin')).toMatchObject({ status: 'denied', legacy: false })
    const third = await ws.load(t3, { root: ws.at('link-legacy-2'), baseRef: 'HEAD' })
    expect(third.legacy()).toBeUndefined()
    expect(third.legacyProblem()).toContain('set SUPERAGENT_PROJECT_ID')
    expect((await ws.load(t3, { root: archived, id: 'p-twin', baseRef: 'HEAD' })).legacy()?.id).toBe('p-twin')
  })

  it('refuses a SUPERAGENT_PROJECT_ID whose project is another folder than SUPERAGENT_PROJECT_ROOT', async () => {
    const ws = workspace()
    checkout('apps/gadgets', ws.dir)
    ws.write([])
    const t3 = new FakeT3([project('p-widgets', ws.at('apps/widgets'), 'Widgets'), project('p-gadgets', ws.at('apps/gadgets'), 'Gadgets')])
    const mixed = await ws.load(t3, { root: ws.at('apps/widgets'), id: 'p-gadgets', worktreeRoot: ws.at('apps/widgets-superagent'), baseRef: 'HEAD' })
    expect(mixed.legacy()).toBeUndefined()
    expect(mixed.list().some(entry => entry.legacy)).toBe(false)
    expect(mixed.legacyProblem()).toBe(`SUPERAGENT_PROJECT_ID p-gadgets is the T3 Code project at ${ws.real('apps/gadgets')}, but SUPERAGENT_PROJECT_ROOT `
      + `is ${ws.at('apps/widgets')}: set them to the same project, or set only one.`)
    // The same folder in another form is the same project.
    symlinkSync(ws.at('apps/gadgets'), ws.at('link-gadgets'))
    expect((await ws.load(t3, { root: ws.at('link-gadgets'), id: 'p-gadgets', baseRef: 'HEAD' })).legacy()?.id).toBe('p-gadgets')
  })

  it('keeps a legacy project registered at a folder inside its checkout working, and says so', async () => {
    const ws = workspace()
    mkdirSync(ws.at('apps/widgets/pkg'))
    ws.write([])
    const t3 = new FakeT3([project('p-pkg', ws.at('apps/widgets/pkg'), 'Pkg')])
    const registry = await ws.load(t3, { root: ws.at('apps/widgets/pkg'), baseRef: 'HEAD' })
    expect(registry.legacyProblem()).toBeUndefined()
    expect(registry.legacy()).toMatchObject({ id: 'p-pkg', status: 'ready', root: ws.real('apps/widgets/pkg'),
      reason: `${ws.real('apps/widgets/pkg')} is inside the git checkout ${ws.real('apps/widgets')}, not its top level; workers get worktrees of the whole checkout.` })
    // Any other project there is still no-git.
    expect(byKey(await ws.load(t3), 'Pkg').status).toBe('no-git')
  })

  it('shows a project added to T3 Code after a refresh, and keeps the last list through a failed one', async () => {
    const ws = workspace()
    checkout('apps/gadgets', ws.dir)
    ws.write([{ path: 'apps/widgets', purpose: 'Widget shop.' }])
    const t3 = new FakeT3([project('p-widgets', ws.at('apps/widgets'), 'Widgets')])
    const registry = await ws.load(t3)
    const health = new Health()
    registry.reportTo(health)
    t3.addProject(project('p-gadgets', ws.at('apps/gadgets'), 'Gadgets'))
    expect(registry.ready().map(entry => entry.key)).toEqual(['apps/widgets'])
    await registry.refresh()
    expect(registry.ready().map(entry => entry.key)).toEqual(['apps/widgets', 'Gadgets'])

    const list = t3.listProjects.bind(t3)
    t3.listProjects = async () => { throw new Error('t3_project_list: network: connection refused') }
    await expect(registry.refresh()).rejects.toThrow(/connection refused/)
    expect(registry.ready().map(entry => entry.key)).toEqual(['apps/widgets', 'Gadgets'])
    expect(registry.state().error).toContain('connection refused')
    expect(health.snapshot().projects).toMatchObject({ failures: 1, error: expect.stringContaining('connection refused') })
    await registry.refresh().catch(() => {})
    await registry.refresh().catch(() => {})
    expect(health.failing()).toEqual(['projects'])
    t3.listProjects = list
    // The catalogue is read again once it changed.
    ws.write([{ path: 'apps/widgets', purpose: 'Widget shop, now with gadgets.' }])
    await registry.refresh()
    expect(health.failing()).toEqual([])
    expect(registry.state().error).toBeUndefined()
    expect(byKey(registry, 'apps/widgets').catalogue).toMatchObject({ purpose: 'Widget shop, now with gadgets.' })
  })

  it('refreshes on a timer from start until stop', async () => {
    const ws = workspace()
    checkout('apps/gadgets', ws.dir)
    ws.write([])
    const t3 = new FakeT3([project('p-widgets', ws.at('apps/widgets'), 'Widgets')])
    const registry = await ws.load(t3)
    registry.start(20)
    t3.addProject(project('p-gadgets', ws.at('apps/gadgets'), 'Gadgets'))
    await until(() => registry.ready().length === 2, 'the timed refresh')
    registry.stop()
    const listed = t3.listProjects.bind(t3)
    let calls = 0
    t3.listProjects = async () => { calls++; return listed() }
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(calls).toBe(0)
  })

  it('works without a catalogue or projects.json, and with a catalogue that is missing or broken fails to load', async () => {
    const ws = workspace()
    const t3 = new FakeT3([project('p-widgets', ws.at('apps/widgets'), 'Widgets')])
    const plain = await ProjectRegistry.load({ t3, stateDir: join(ws.dir, 'state') })
    expect(plain.list()).toMatchObject([{ key: 'Widgets', status: 'ready', access: 'named' }])
    await expect(ws.load(t3)).rejects.toThrow(/repositories\.json \(SUPERAGENT_CATALOGUE\) does not exist/)
    writeFileSync(ws.at('repositories.json'), '{"workspace": 3}')
    await expect(ws.load(t3)).rejects.toThrow(/is not a repositories\.json: workspace/)
  })

  it('builds one ready legacy project without reading anything, for callers that know it', async () => {
    const single = ProjectRegistry.single({ id: 'project-1', root: '/work/widgets', repository: 'acme/widgets' })
    expect(single.legacy()).toMatchObject({ id: 'project-1', key: 'widgets', root: '/work/widgets', worktreeRoot: '/work/widgets-superagent',
      baseRef: 'HEAD', delivery: 'pr', access: 'work', status: 'ready' })
    expect(await single.refresh()).toHaveLength(1)
    expect(single.summary()).toBe('1 ready')
  })
})
