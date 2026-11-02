/**
 * `superagent connect` signs the super agent in to t3code once; `superagent` (no command) starts it next to a running
 * `t3 serve`. See README.md, "Run it".
 */
import { join, resolve } from 'node:path'
import { Runtime } from './app/runtime.ts'
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
  let token = config.t3Token
  if (!token) {
    const saved = await loadToken(config.tokenFile)
    if (!saved) throw new Error('Not signed in to T3 Code: run `npm run connect`, or set T3_MCP_TOKEN.')
    const left = daysLeft(saved)
    if (left <= 0) throw new Error(`The T3 Code sign-in expired on ${saved.expiresAt}: run \`npm run connect\` again.`)
    if (left < 3) log(`the T3 Code sign-in expires on ${saved.expiresAt}; run \`npm run connect\` again before then`)
    token = saved.token
  }
  const t3 = new McpT3Client({ url: config.t3Url, token })
  const projects = await t3.listProjects()
  const project = config.projectId
    ? projects.find(item => item.id === config.projectId)
    : projects.find(item => resolve(item.workspaceRoot) === config.projectRoot)
  if (!project) throw new Error(`No T3 Code project ${config.projectId ?? `at ${config.projectRoot}`}. Add the folder as a project in T3 Code first.`)

  const runtime = new Runtime(config, t3, { id: project.id, root: config.projectRoot })
  const http = await startHttp(runtime, config.port)
  runtime.start()
  await runtime.ensureConsole()
  await runtime.ensureWatchdog().catch(error => log(`starting the Watchdog failed: ${error instanceof Error ? error.message : String(error)}`))
  log(`ready: router ${config.router.kind}${config.github ? `, GitHub ${config.repository} as ${config.github.login}` : ''}; `
    + `console ${runtime.console?.link ?? runtime.console?.threadId}, panel ${runtime.panelUrl()}`)

  const shutdown = async () => {
    http.close()
    await runtime.stop()
    await t3.close()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

const command = process.argv[2]
const work = command === 'connect' ? signIn() : command === undefined || command === 'start' ? run()
  : Promise.reject(new Error(`Unknown command ${command}: use \`connect\` or \`start\`.`))
work.catch(error => {
  log(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
