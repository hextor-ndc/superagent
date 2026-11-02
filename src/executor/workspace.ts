/**
 * Prepares a Ticket's worktree before its t3code thread starts: a plain `git worktree add` inside the project's checkout,
 * which t3code accepts for `existing_worktree` launches, plus this Ticket's own worker MCP configuration for Claude
 * (`.mcp.json`) and Codex (`.codex/config.toml`). Both files are kept out of git through `info/exclude`.
 */
import { execFile } from 'node:child_process'
import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
/** The MCP server name the worker's agent sees; its tools appear as `superagent` tools. */
export const MCP_SERVER_NAME = 'superagent'
const EXCLUDED = ['.mcp.json', '.codex/']

export interface PrepareInput {
  /** The t3code project's checkout. */
  projectRoot: string
  /** Where worktrees go, such as `<projectRoot>/../<name>-worktrees`. */
  worktreeRoot: string
  /** The Ticket's short name, also its branch's last path segment, which ties its pull requests to it. */
  name: string
  branchPrefix: string
  baseRef: string
  /** This Ticket's worker MCP URL, which carries its capability token. */
  mcpUrl: string
}
export interface Prepared { worktreePath: string; branch: string; created: boolean }

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024 })
  return stdout.trim()
}
const exists = (path: string) => access(path).then(() => true, () => false)

/** Creates the worktree once; a directory that exists counts as prepared, as in the prototype, and only its MCP files are rewritten. */
export async function prepareWorktree(input: PrepareInput): Promise<Prepared> {
  const worktreePath = join(input.worktreeRoot, input.name)
  const branch = `${input.branchPrefix}${input.name}`
  let created = false
  if (!await exists(worktreePath)) {
    await mkdir(input.worktreeRoot, { recursive: true })
    await git(input.projectRoot, 'worktree', 'add', '-b', branch, worktreePath, input.baseRef)
    created = true
  }
  await writeMcpConfig(worktreePath, input.mcpUrl)
  await excludeFromGit(worktreePath)
  return { worktreePath, branch, created }
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
