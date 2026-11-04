/**
 * Migration v1 of the state (docs/multi-project-plan.md, 3.6): tickets made before projects were kept per ticket get a binding
 * to the legacy project, since every one of them was made there. Runs in `Runtime.prepare()`, which main.ts awaits before
 * HTTP opens and before any work resumes, so nothing reads a ticket without its binding meanwhile. No SQL schema changes:
 * the bindings and the marker are kv rows.
 *
 * In order: a copy of the database when it has tickets and was never migrated; the legacy project, without which those
 * tickets are not bound and the start stops (nothing is guessed); one transaction that binds every ticket without a binding
 * and sets the marker; then a check, logged only, that open tickets' worktrees belong to the legacy project. It is idempotent:
 * a database with the marker is left alone, and a ticket that has a binding keeps it.
 */
import { dirname, join, relative, resolve, sep } from 'node:path'
import { commonDirOf } from '../executor/workspace.ts'
import type { TicketThread } from '../executor/t3-executor.ts'
import { bindingKey, bindingOf, type ProjectBinding, type ProjectRegistry } from './projects.ts'
import type { Store } from './store.ts'

/** kv: set once the migration ran. Console triggers from before `migratedAt` with no project count as the legacy project's (D19). */
export const SCHEMA_KEY = 'schema:projects'
export interface ProjectsSchema { version: 1; migratedAt: string; legacyProjectId?: string }

export interface MigrateInput {
  store: Store
  projects: ProjectRegistry
  /** The database file, or `:memory:`; the copy goes beside it, or in `stateDir` for an in-memory one. */
  database: string
  stateDir: string
  log: (message: string, error?: unknown) => void
  now?: () => Date
}
export interface Migrated { backup?: string; bound: number; mismatches: string[] }

export async function migrateProjects(input: MigrateInput): Promise<Migrated> {
  const { store, projects, log } = input
  if (store.kv.get<ProjectsSchema>(SCHEMA_KEY)) return { bound: 0, mismatches: [] }
  const now = (input.now ?? (() => new Date()))()
  const tickets = store.tickets.list()
  let backup: string | undefined
  if (tickets.length) {
    const file = input.database === ':memory:' ? join(input.stateDir, 'state.sqlite') : input.database
    backup = `${file}.bak-${now.toISOString().replace(/[:.]/g, '-')}`
    try { store.backup(backup) } catch (error) {
      throw new Error(`Copying the database to ${backup} before migrating it failed, so the super agent does not start: ${message(error)}`)
    }
    log(`copied the database to ${backup} before binding its tickets to projects`)
  }
  const unbound = tickets.filter(ticket => !store.kv.get<ProjectBinding>(bindingKey(ticket.id)))
  const legacy = projects.legacy()
  if (unbound.length && !legacy) {
    throw new Error(`${unbound.length} ticket${unbound.length === 1 ? ' was' : 's were'} made before tickets kept their own project, all in the `
      + 'project workers used then, and no such project is set now. Set SUPERAGENT_PROJECT_ROOT (or SUPERAGENT_PROJECT_ID) to that project for '
      + `this start; the super agent does not guess it. A copy of the database from before is at ${backup}.`)
  }
  const at = now.toISOString()
  const bound = store.atomic(() => {
    for (const ticket of unbound) {
      // The folder its worktree is in already, so a later change of SUPERAGENT_WORKTREE_ROOT never moves an old ticket.
      const root = ticket.execution?.directory ? dirname(ticket.execution.directory) : legacy!.worktreeRoot
      store.kv.set(bindingKey(ticket.id), bindingOf(legacy!, ticket.id, 'legacy', at, root))
    }
    store.kv.set(SCHEMA_KEY, { version: 1, migratedAt: at, ...legacy?.id ? { legacyProjectId: legacy.id } : {} } satisfies ProjectsSchema)
    return unbound.length
  })
  if (bound) log(`bound ${bound} ticket${bound === 1 ? '' : 's'} made before tickets kept their own project to ${legacy!.key}`)

  // A mis-set SUPERAGENT_PROJECT_ROOT shows here: open tickets whose worktrees are not the legacy project's. Logged, not changed.
  const mismatches: string[] = []
  const common = legacy ? legacy.commonDir ?? await commonDirOf(legacy.root) : undefined
  for (const ticket of unbound.filter(item => !item.ended && item.execution)) {
    const folder = dirname(ticket.execution!.directory)
    const thread = store.kv.get<TicketThread>(`ticket-thread:${ticket.id}`)
    for (const path of new Set([ticket.execution!.directory, ...thread?.worktreePath ? [thread.worktreePath] : []])) {
      if (!inside(path, folder)) mismatches.push(`${ticket.id}: ${path} is not in ${folder}`)
      const theirs = await commonDirOf(path)
      // A worktree not made yet has no git dir to compare.
      if (theirs && theirs !== common) mismatches.push(`${ticket.id}: ${path} is a worktree of ${theirs}, not of ${legacy!.root}`)
    }
  }
  for (const line of mismatches) log(`after binding old tickets to ${legacy!.key}: ${line}; check SUPERAGENT_PROJECT_ROOT. Nothing was changed.`)
  return { ...backup ? { backup } : {}, bound, mismatches }
}

const inside = (path: string, dir: string) => { const rel = relative(resolve(dir), resolve(path)); return !!rel && !rel.startsWith('..') && !rel.startsWith(sep) }
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
