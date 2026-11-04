/**
 * `superagent connect` signs the super agent in to t3code once; `superagent` (no command) starts it next to a running
 * `t3 serve`. See README.md, "Run it".
 */
import { join } from 'node:path'
import { ProjectRegistry } from './app/projects.ts'
import { Runtime } from './app/runtime.ts'
import { acquireLock, ensureConsoleToken } from './app/state-files.ts'
import { loadConfig, stateDir } from './config.ts'
import { startHttp } from './http/server.ts'
import { McpT3Client } from './t3/client.ts'
import { connect, daysLeft, loadToken, saveToken } from './t3/connect.ts'

const log = (message: string) => console.error(`[superagent] ${message}`)

async function signIn(): Promise<void> {
  const url = process.env.T3_MCP_URL ?? 'http://127.0.0.1:3773/mcp'
  const saved = await connect({ mcpUrl: url })
  const file = join(stateDir(), 't3-token.json')
  await saveToken(file, saved)
  log(`signed in to ${saved.url} until ${saved.expiresAt}; the token is in ${file}`)
}

async function run(): Promise<void> {
  const config = loadConfig()
  // Before anything else: two instances on one database would both resume every active ticket.
  const lock = acquireLock(config.stateDir)
  process.once('exit', lock.release)
  config.consoleToken = ensureConsoleToken(config.stateDir, config.consoleToken)
  let token = config.t3Token
  if (!token) {
    const saved = await loadToken(config.tokenFile)
    if (!saved) throw new Error('Not signed in to T3 Code: run `npm run connect`, or set T3_MCP_TOKEN.')
    const left = daysLeft(saved)
    if (left <= 0) throw new Error(`The T3 Code sign-in expired on ${saved.expiresAt}: run \`npm run connect\` again.`)
    if (left < 3) log(`the T3 Code sign-in expires on ${saved.expiresAt}; run \`npm run connect\` again before then`)
    token = saved.token
  }
  const t3 = new McpT3Client({ url: config.t3Url, token, ...(config.model ? { modelSelection: config.model } : {}) })
  const projects = await ProjectRegistry.load({ t3, stateDir: config.stateDir, legacy: config.legacy, catalogue: config.catalogue,
    projectsFile: config.projectsFile, log: config.log })
  logProjects(projects)
  // A configured project that does not resolve fails the start, as before; GitHub needs it for its repository.
  if (config.legacy && !projects.legacy()) throw new Error(projects.legacyProblem() ?? 'The project SUPERAGENT_PROJECT_ROOT names is not ready.')
  if (config.github && !projects.legacy()) throw new Error('GitHub needs the project its repository belongs to: set SUPERAGENT_PROJECT_ROOT and SUPERAGENT_REPOSITORY.')

  const runtime = new Runtime(config, t3, projects)
  await runtime.prepare()
  const http = await startHttp(runtime, config.port)
  runtime.start()
  await runtime.ensureConsole()
  await runtime.ensureWatchdog().catch(error => log(`starting the Watchdog failed: ${error instanceof Error ? error.message : String(error)}`))
  log(`ready: router ${config.router.kind}${config.github ? `, GitHub ${runtime.workProject?.repository} as ${config.github.login}` : ''}; `
    + `work in ${runtime.workProject ? runtime.workProject.key : 'no project (requests are refused)'}; `
    + `console ${runtime.console?.link ?? runtime.console?.threadId}, panel ${runtime.panelUrl()}`)

  const shutdown = async () => {
    http.close()
    await runtime.stop()
    await t3.close()
    lock.release()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

/** Every T3 Code project with its status and why, then the counts, catalogued folders included, and the ready ones. */
function logProjects(projects: ProjectRegistry): void {
  const registered = projects.list().filter(entry => entry.id)
  for (const entry of registered) log(`project ${entry.key} (${entry.id}): ${entry.status}${entry.legacy ? ', legacy' : ''}${entry.reason ? `: ${entry.reason}` : ''}`)
  log(`projects: ${projects.summary()}; ready: ${projects.ready().map(entry => `${entry.key} at ${entry.root}`).join('; ') || 'none'}`)
}

const command = process.argv[2]
const work = command === 'connect' ? signIn() : command === undefined || command === 'start' ? run()
  : Promise.reject(new Error(`Unknown command ${command}: use \`connect\` or \`start\`.`))
work.catch(error => {
  log(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
