/**
 * Two T3 Code projects for the multi-project specs (docs/multi-project-plan.md): the checkouts `widgets` and `gadgets` in one
 * temp dir, registered in a FakeT3 with `checkWorktrees` on, a registry loaded as main.ts loads it, and a harness on them.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Trigger } from '../vendor/dsh/src/core/index.ts'
import { consoleTrigger } from '../src/app/console-source.ts'
import { ProjectRegistry } from '../src/app/projects.ts'
import type { Config, LegacyProject } from '../src/config.ts'
import type { Gh } from '../src/sources/github.ts'
import type { ModelCall } from '../src/router/claude-router.ts'
import { FakeT3 } from './fake-t3.ts'
import { checkout, git, harness, until, type Harness, type Timing } from './harness.ts'
import type { NewProjectDeps } from '../src/app/runtime.ts'

export const commit = (cwd: string, file: string, text: string, message = file) => {
  writeFileSync(join(cwd, file), text)
  git(cwd, 'add', file)
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message)
  return git(cwd, 'rev-parse', 'HEAD')
}
export const worktreesOf = (root: string) => git(root, 'worktree', 'list', '--porcelain').split('\n')
  .filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length))
/** A console request that names its project, as `superagent_request` stores it; set on the trigger by the test. */
export const named = (text: string, project: string): Trigger => {
  const trigger = consoleTrigger('hector', text)
  return { ...trigger, meta: { ...trigger.meta, project, projectBy: 'operator' } }
}
export const workerLaunches = (t3: FakeT3) => t3.calls.filter(call => call.tool === 't3_thread_launch' && !(call.args as { scratch?: boolean }).scratch)
export const failure = (made: Harness, ticketId: string) => {
  const ticket = made.runtime.repo.tickets.get(ticketId)
  return ticket?.assignments.flatMap(item => item.report?.state === 'failed' ? [item.report.summary] : []).at(-1)
}
export const fast: Timing = { waitMs: 10, idlePollMs: 10, continueAfterMs: 0, launchRetryMs: 20 }

export interface Setup {
  dir: string; widgets: string; gadgets: string; t3: FakeT3; made: Harness
  /** The ticket a trigger made, once it exists. */
  ticketOf(trigger: Trigger): Promise<string>
}
/**
 * widgets and gadgets registered in a FakeT3, a registry loaded as main.ts loads it, and a harness on them. `legacy` makes
 * widgets the legacy project (the default); `projects` is written as projects.json first.
 */
export async function setup(options: { legacy?: Partial<LegacyProject> | false; projects?: Record<string, unknown>; database?: string; dir?: string
  t3?: FakeT3; timing?: Timing; config?: Partial<Config>; model?: ModelCall; gh?: Gh; catalogue?: string; newProject?: NewProjectDeps } = {}): Promise<Setup> {
  const place = options.dir ? { dir: options.dir, root: join(options.dir, 'widgets') } : checkout('widgets')
  const dir = place.dir, widgets = place.root, gadgets = join(dir, 'gadgets')
  if (!options.dir) checkout('gadgets', dir)
  const t3 = options.t3 ?? new FakeT3([{ id: 'p-widgets', workspaceRoot: widgets, title: 'Widgets' }, { id: 'p-gadgets', workspaceRoot: gadgets, title: 'Gadgets' }],
    { checkWorktrees: true })
  const stateDir = join(dir, 'state')
  if (options.projects) { mkdirSync(stateDir, { recursive: true }); writeFileSync(join(stateDir, 'projects.json'), JSON.stringify(options.projects)) }
  const legacy: LegacyProject | undefined = options.legacy === false ? undefined
    : { root: widgets, worktreeRoot: join(dir, 'worktrees'), baseRef: 'HEAD', ...options.legacy }
  const projects = await ProjectRegistry.load({ t3, stateDir, legacy, projectsFile: join(stateDir, 'projects.json'),
    ...options.catalogue ? { catalogue: options.catalogue } : {} })
  const made = await harness(t3, place, options.database ?? ':memory:', { legacy, ...options.catalogue ? { catalogue: options.catalogue } : {}, ...options.config },
    { projects, project: 'p-widgets', timing: options.timing ?? fast, ...options.model ? { model: options.model } : {},
      ...options.gh ? { gh: options.gh } : {}, ...options.newProject ? { newProject: options.newProject } : {} })
  const ticketOf = (trigger: Trigger) => until(() => made.runtime.repo.tickets.list().find(ticket => ticket.origin.triggerId === trigger.id)?.id,
    `the ticket of ${trigger.text}`)
  return { dir, widgets, gadgets, t3, made, ticketOf }
}

