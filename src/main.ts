/** Starts the super agent next to a running `t3 serve`. See README.md, "Run it". */
import { loadConfig } from './config.ts'
import { Runtime } from './app/runtime.ts'
import { startHttp } from './http/server.ts'
import { McpT3Client } from './t3/client.ts'
import { resolve } from 'node:path'

async function main(): Promise<void> {
  const config = loadConfig()
  const t3 = new McpT3Client({ url: config.t3Url, token: config.t3Token })
  const projects = await t3.listProjects()
  const project = config.projectId
    ? projects.find(item => item.id === config.projectId)
    : projects.find(item => resolve(item.workspaceRoot) === config.projectRoot)
  if (!project) throw new Error(`No T3 Code project ${config.projectId ?? `at ${config.projectRoot}`}. Add the folder as a project in T3 Code first.`)

  const runtime = new Runtime(config, t3, { id: project.id, root: config.projectRoot })
  const http = await startHttp(runtime, config.port)
  runtime.start()
  await runtime.ensureConsole()
  config.log(`ready: console ${runtime.console?.link ?? runtime.console?.threadId}, panel ${runtime.panelUrl()}`)

  const shutdown = async () => {
    http.close()
    await runtime.stop()
    await t3.close()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

main().catch(error => {
  console.error(`[superagent] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
