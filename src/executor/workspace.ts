/**
 * Prepares a Ticket's worktree before its t3code thread starts: a plain `git worktree add` from the project's checkout, which
 * t3code accepts for `existing_worktree` launches, plus this Ticket's own worker MCP configuration for Claude (`.mcp.json`)
 * and Codex (`.codex/config.toml`). Both files are kept out of git through `info/exclude`.
 *
 * The worktree is the Ticket's `execution.directory`, fixed at its accept (docs/multi-project-plan.md, 3.3). The first
 * preparation checks the checkout and the base and makes the worktree; a later one (a retry, a restart, a resume) only checks
 * that the folder is still a worktree of the same repository, so a checkout that became dirty since, or a default branch that
 * moved, never fails it.
 */
import { execFile } from 'node:child_process'
import { access, appendFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
/** The MCP server name the worker's agent sees; its tools appear as `superagent` tools. */
export const MCP_SERVER_NAME = 'superagent'
const EXCLUDED = ['.mcp.json', '.codex/']

export interface PrepareInput {
  /** The t3code project's checkout. */
  projectRoot: string
  /** The repository's common git dir as the Ticket's binding recorded it; a checkout with another one is refused. */
  commonDir?: string
  /** The project's folder of ticket worktrees; `directory` must be inside it. */
  worktreeRoot: string
  /** The Ticket's worktree, its `execution.directory`. */
  directory: string
  /** The Ticket's short name, also its branch's last path segment, which ties its pull requests to it. */
  name: string
  branchPrefix: string
  baseRef: string
  /**
   * What to do when the base is the branch checked out (or `HEAD`) and the checkout has uncommitted changes, which the new
   * worktree does not have: `warn` (the default) says so in the worker's first message; `refuse` fails before any git write.
   */
  dirty?: 'warn' | 'refuse'
  /** This Ticket's worker MCP URL, which carries its capability token. */
  mcpUrl: string
}
export interface Prepared {
  worktreePath: string
  branch: string
  created: boolean
  /** For a worktree made now: the commit it started from, and a note on uncommitted changes of the checkout it does not have. */
  base?: { sha: string; note?: string }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024 })
  return stdout.trim()
}
const exists = (path: string) => access(path).then(() => true, () => false)
const real = (path: string) => realpath(path).catch(() => resolve(path))
const within = (path: string, dir: string) => path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`)
/** The common git dir of the checkout or worktree at `path`, as a real path; undefined when it is not one. */
export async function commonDirOf(path: string): Promise<string | undefined> {
  try { return await real(await git(path, 'rev-parse', '--path-format=absolute', '--git-common-dir')) } catch { return undefined }
}

/**
 * Runs `work` after every earlier one under `key` has finished, so `git worktree add` runs one at a time per repository: two
 * at once in one repository can collide on its ref and config locks. In this process only, which the instance lock makes the
 * only one.
 */
const queues = new Map<string, Promise<void>>()
export async function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
  const before = queues.get(key) ?? Promise.resolve()
  const result = before.then(work)
  const tail = result.then(() => {}, () => {})
  queues.set(key, tail)
  try { return await result } finally { if (queues.get(key) === tail) queues.delete(key) }
}

/** Makes the worktree on its first preparation, or checks the one that exists; then (re)writes its MCP files. */
export async function prepareWorktree(input: PrepareInput): Promise<Prepared> {
  const worktreePath = resolve(input.directory)
  const branch = `${input.branchPrefix}${input.name}`
  if (!within(worktreePath, resolve(input.worktreeRoot))) {
    throw new Error(`${worktreePath} is not inside the project's worktree folder ${input.worktreeRoot}.`)
  }
  let base: Prepared['base']
  if (await exists(worktreePath)) await checkExisting(input, worktreePath)
  else base = await create(input, worktreePath, branch)
  await writeMcpConfig(worktreePath, input.mcpUrl)
  await excludeFromGit(worktreePath)
  return { worktreePath, branch, created: !!base, ...base ? { base } : {} }
}

/** The first preparation: checks the checkout and the base, then adds the worktree. Nothing is written before the checks pass. */
async function create(input: PrepareInput, worktreePath: string, branch: string): Promise<NonNullable<Prepared['base']>> {
  const root = input.projectRoot
  try { await git(root, 'rev-parse', '--show-toplevel') } catch { throw new Error(`${root} is not a git checkout any more.`) }
  const common = await commonDirOf(root)
  if (!common) throw new Error(`${root} is not a git checkout any more.`)
  if (input.commonDir && common !== await real(input.commonDir)) {
    throw new Error(`${root} is another repository than when the ticket was accepted: its git dir is ${common}, then it was ${input.commonDir}.`)
  }
  let sha: string
  try { sha = await git(root, 'rev-parse', '--verify', '--quiet', `${input.baseRef}^{commit}`) } catch {
    throw new Error(`The base ${input.baseRef} is not a commit in ${root}.`)
  }
  // The operator's uncommitted changes matter only when the base is what is checked out; another local branch is not affected.
  const current = await git(root, 'symbolic-ref', '-q', '--short', 'HEAD').catch(() => '')
  let note: string | undefined
  if (input.baseRef === 'HEAD' || (current && (input.baseRef === current || input.baseRef === `refs/heads/${current}`))) {
    const changes = (await git(root, 'status', '--porcelain')).split('\n').filter(Boolean).length
    if (changes && input.dirty === 'refuse') {
      throw new Error(`${root} has ${changes} uncommitted change${changes === 1 ? '' : 's'} on ${current || 'a detached HEAD'}, the base of new worktrees, `
        + 'and projects.json sets dirty to refuse for it: commit or stash them, or set dirty to warn, then retry.')
    }
    if (changes) {
      note = `Base ${sha.slice(0, 12)} on ${current || 'a detached HEAD'}; the checkout had ${changes} uncommitted `
        + `${changes === 1 ? 'change that is' : 'changes that are'} not in this worktree.`
    }
  }
  await serial(common, async () => {
    await mkdir(input.worktreeRoot, { recursive: true })
    // From the commit just checked, so the worktree starts where the note says even if the ref moves meanwhile.
    await git(root, 'worktree', 'add', '-b', branch, worktreePath, sha)
  })
  return { sha, ...note ? { note } : {} }
}

/** A later preparation: the folder must be a worktree of its own, of the project's repository. */
async function checkExisting(input: PrepareInput, worktreePath: string): Promise<void> {
  const top = await git(worktreePath, 'rev-parse', '--show-toplevel').then(real, () => undefined)
  if (top !== await real(worktreePath)) {
    throw new Error(`${worktreePath} exists but is not a git worktree; move it away, or stop the ticket and request the work again.`)
  }
  const mine = await commonDirOf(worktreePath)
  const project = input.commonDir ? await real(input.commonDir) : await commonDirOf(input.projectRoot)
  if (!mine || mine !== project) {
    throw new Error(`${worktreePath} is a worktree of another repository (git dir ${mine}), not of ${input.projectRoot}; move it away, `
      + 'or stop the ticket and request the work again.')
  }
}

export async function writeMcpConfig(worktreePath: string, url: string): Promise<void> {
  const claude = { mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url } } }
  await writeFile(join(worktreePath, '.mcp.json'), `${JSON.stringify(claude, null, 2)}\n`, { mode: 0o600 })
  await mkdir(join(worktreePath, '.codex'), { recursive: true })
  await writeFile(join(worktreePath, '.codex', 'config.toml'), `[mcp_servers.${MCP_SERVER_NAME}]\nurl = ${JSON.stringify(url)}\n`, { mode: 0o600 })
}

/** Adds the MCP files to the repository's shared `info/exclude`, which every worktree of the checkout reads. */
async function excludeFromGit(worktreePath: string): Promise<void> {
  const common = await git(worktreePath, 'rev-parse', '--git-common-dir')
  const file = join(isAbsolute(common) ? common : resolve(worktreePath, common), 'info', 'exclude')
  const current = await readFile(file, 'utf8').catch(() => '')
  const missing = EXCLUDED.filter(line => !current.split('\n').includes(line))
  if (!missing.length) return
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, `${current && !current.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`)
}

/**
 * Whether `branch` still exists in the checkout at `root` and is not in `into` (`git merge-base --is-ancestor` exits
 * non-zero), for the review list. A branch that is gone, or a checkout git cannot read, is not waiting for review.
 */
export async function unmerged(root: string, branch: string, into: string): Promise<boolean> {
  try { await git(root, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`) } catch { return false }
  try { await git(root, 'merge-base', '--is-ancestor', `refs/heads/${branch}`, into); return false } catch { return true }
}
