/**
 * The panel's New project form (src/mcp/attention-app.ts) and `superagent_new_project_options` (src/app/new-project.ts).
 * The options are read from a temp workspace with a catalogue and a projects.json; the page's own script runs against a
 * stand-in DOM of its elements, first with a scripted fetch (Create's arguments, the result, a refusal, a failure part way,
 * the refresh leaving the form alone), then against the HTTP API of a real service with a T3Cli stand-in.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { goodName, NAME_RULE, newProjectOptions, PART_WAY, type NewProjectOptions, type Step, type T3Cli } from '../src/app/new-project.ts'
import { ATTENTION_URI, attentionPage, MCP_APP_MIME, NEW_PROJECT_URI, newProjectPage } from '../src/mcp/attention-app.ts'
import { checkout, data, mcp, until } from './harness.ts'
import { setup, type Setup } from './two-projects.ts'

const scratch = mkdtempSync(join(tmpdir(), 'superagent-panel-new-project-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
/** Git's environment for the tool: a global config of the test's own with an identity, and no system config. */
function gitEnv(): NodeJS.ProcessEnv {
  const config = join(scratch, 'gitconfig')
  writeFileSync(config, '[user]\n\tname = Test Operator\n\temail = operator@example.test\n')
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' }
  for (const name of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete env[name]
  return env
}

const folderEntry = (path: string) => ({ path, purpose: `${path}.`, flow: 'Notes.', modules: [], notes: '', related: [], kind: 'project-folder',
  checked_on: '2026-10-04', head: null, branch: null, had_local_changes: null, map: `${path}/REPO_MAP.md`, manifests: [], existing_docs: [], readme_created: true })
const gitEntry = (path: string) => ({ path, purpose: `${path}.`, flow: 'Things happen.', modules: [], notes: 'Notes.', related: [], kind: 'git-repository',
  checked_on: '2026-10-04', head: 'abc', branch: 'main', had_local_changes: false, map: `${path}/REPO_MAP.md`, manifests: [], existing_docs: [],
  readme_created: false, git_checked_on: '2026-10-31' })
const INDEX = ['# Coding repository index', '', '## Repository and project catalog', '',
  '### PERSONAL', '', '| Project guide | Kind | Function | Main modules / where to look |', '|---|---|---|---|',
  '| [PERSONAL/automix](PERSONAL/automix/REPO_MAP.md) | project-folder | DJ mixes. | `src`: Code |', '',
  '## Maintain this index', '', 'Keep it current.', ''].join('\n')

interface Env extends Setup { catalogue: string; client: Client; added: string[] }
let open: Env | undefined
afterEach(async () => { await open?.client.close(); await open?.made.close(); open = undefined })

/**
 * A workspace whose catalogue files projects under PERSONAL, FAMILY, COMMON, ARCHIVE (denied by default), NDC (denied by
 * projects.json), LINK (a symlink to PERSONAL), MISSING (not on disk) and gadgets (a git checkout), with widgets catalogued
 * at the top level. EMPTY is a folder the catalogue files nothing under.
 */
async function start(options: { catalogue?: false; beforeStep?: (step: Step) => void } = {}): Promise<Env> {
  const { dir } = checkout('widgets')
  checkout('gadgets', dir)
  for (const group of ['PERSONAL', 'FAMILY', 'COMMON', 'ARCHIVE', 'NDC', 'EMPTY']) mkdirSync(join(dir, group))
  symlinkSync(join(dir, 'PERSONAL'), join(dir, 'LINK'))
  const catalogue = join(dir, 'repositories.json')
  const entries = [folderEntry('ARCHIVE/old'), folderEntry('COMMON/tools'), folderEntry('FAMILY/photos'), folderEntry('LINK/x'), folderEntry('MISSING/y'),
    folderEntry('NDC/bardash'), folderEntry('PERSONAL/automix'), folderEntry('gadgets/tool'), gitEntry('widgets')]
  writeFileSync(catalogue, `${JSON.stringify({ workspace: dir, scope: '9 mapped entries: 1 Git repositories, 0 linked worktrees and 8 additional '
    + 'project or reference folders.', repositories: entries }, null, 2)}\n`)
  writeFileSync(join(dir, 'REPOSITORIES.md'), INDEX)
  const added: string[] = []
  let made!: Setup
  const cli: T3Cli = {
    problem: () => undefined,
    async addProject(root, title) {
      added.push(root)
      const id = `p-new-${added.length}`
      made.t3.addProject({ id, workspaceRoot: root, title })
      return `Added project ${id} (${title}) at ${root}.`
    },
  }
  made = await setup({ dir, ...options.catalogue === false ? {} : { catalogue }, projects: { 'NDC/': { access: 'deny' } },
    newProject: { cli, env: gitEnv(), listWaitMs: 200, ...options.beforeStep ? { beforeStep: options.beforeStep } : {} } })
  const client = await mcp(`${made.made.base}/mcp/console/console-secret`)
  open = Object.assign(made, { catalogue, client, added })
  return open
}

describe('superagent_new_project_options', () => {
  it('offers the top-level folders the catalogue files projects under, leaving out denied, linked, missing and git folders', async () => {
    const env = await start()
    const options = await env.made.runtime.newProjectOptions()
    expect(options).toEqual({ enabled: true, workspace: realpathSync(env.dir), groups: ['COMMON', 'FAMILY', 'PERSONAL'], top_level: true,
      name_rule: `A folder name must ${NAME_RULE}` })
    // The MCP tool, which the panel uses as an MCP App, gives the same.
    const tool = await env.client.callTool({ name: 'superagent_new_project_options', arguments: {} })
    expect(data(tool)).toEqual(options)
    // A top-level folder that is catalogued itself is a project, not a group, even when the catalogue files entries below it.
    mkdirSync(join(env.dir, 'TOOLS'))
    const listed = JSON.parse(readFileSync(env.catalogue, 'utf8')) as { repositories: unknown[] }
    listed.repositories.push(folderEntry('TOOLS'), folderEntry('TOOLS/sub'))
    writeFileSync(env.catalogue, `${JSON.stringify(listed, null, 2)}\n`)
    expect((await env.made.runtime.newProjectOptions()).groups).toEqual(['COMMON', 'FAMILY', 'PERSONAL'])
    // A workspace that is itself a git checkout can take a new project nowhere: the tool refuses a folder inside a checkout.
    execFileSync('git', ['init', '-q', env.dir])
    expect(await env.made.runtime.newProjectOptions()).toMatchObject({ enabled: true, groups: [], top_level: false })
  })

  it('says new projects are off, and how to turn them on, without a catalogue', async () => {
    const env = await start({ catalogue: false })
    const options = await env.made.runtime.newProjectOptions()
    expect(options).toMatchObject({ enabled: false, groups: [], top_level: false })
    expect(options.why).toContain('No catalogue is configured')
    expect(options.enable).toContain('SUPERAGENT_CATALOGUE')
  })

  it('warns when the t3 CLI cannot run, since every Create would be refused', async () => {
    const env = await start()
    const options = await newProjectOptions({ catalogue: env.catalogue, projects: env.made.runtime.projects,
      cli: { problem: () => 'No t3 here.', addProject: () => Promise.reject(new Error('no')) }, env: gitEnv() })
    expect(options).toMatchObject({ enabled: true, warning: 'No t3 here.' })
  })
})

/** A stand-in element: the properties the page sets, each write logged by element id, and its listeners. */
interface Node { value: string; innerHTML: string; textContent: string; hidden: boolean; disabled: boolean; listeners: Record<string, ((event: unknown) => unknown)[]> }
interface Page {
  nodes: Record<string, Node>
  /** Each write as `<id>.<property>`, in order. */
  writes: string[]
  /** The callbacks the page gave setInterval, with their period. */
  timers: { run: () => unknown; ms: number }[]
  helpers: { nameProblem(name: string): string; folderOf(group: string, name: string): string; refresh?: () => Promise<void> }
  /** The theme the page set on its root element. */
  theme: () => string | undefined
  /** The height the stand-in body has now: more with the form shown, and more again with a longer result. */
  height: () => number
}

/**
 * A page's script run against a stand-in of its own elements (no DOM library; none is in package.json). `fetch` serves the
 * panel's HTTP API; `parent` and `window` stand in for t3code's side of the MCP Apps postMessage protocol.
 */
function load(html: string, globals: { fetch?: unknown; parent?: unknown; window?: unknown; resizeObserver?: true }): Page {
  const script = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'))
  const writes: string[] = []
  const nodes: Record<string, Node> = {}
  // A ResizeObserver stand-in: each write to an element may change the body's size, so every observer hears of it after the write.
  const observers: (() => void)[] = []
  const resized = () => { for (const observer of observers) queueMicrotask(observer) }
  for (const [, id, rest] of html.matchAll(/<\w+ (?:[^>]* )?id="([^"]+)"([^>]*)>/g)) {
    const state: Record<string, unknown> = { value: '', innerHTML: '', textContent: '', hidden: / hidden/.test(rest ?? ''), disabled: false }
    const node = { listeners: {} as Node['listeners'], addEventListener(type: string, listener: (event: unknown) => unknown) {
      (node.listeners[type] ??= []).push(listener) } } as unknown as Node
    for (const key of Object.keys(state)) {
      Object.defineProperty(node, key, { get: () => state[key], set: value => { writes.push(`${id}.${key}`); state[key] = value; resized() }, enumerable: true })
    }
    nodes[id!] = node
  }
  const timers: Page['timers'] = []
  const dataset: Record<string, string> = {}
  const height = () => 50 + (nodes['np-form']?.hidden === false ? 600 : 20) + Math.ceil((nodes['np-result']?.innerHTML.length ?? 0) / 8)
  const body = { getBoundingClientRect: () => ({ height: height() + 0.4 }) }
  const document = { getElementById: (id: string) => nodes[id], addEventListener() {}, documentElement: { dataset }, body }
  const ResizeObserver = globals.resizeObserver
    ? class { constructor(private readonly run: () => void) {} observe(target: unknown) { expect(target).toBe(body); observers.push(() => this.run()) } }
    : undefined
  const helpers = new Function('document', 'window', 'fetch', 'setInterval', 'parent', 'ResizeObserver',
    `${script}\nreturn { nameProblem, folderOf, refresh: typeof refresh === 'function' ? refresh : undefined }`)(
    document, globals.window ?? { addEventListener() {} }, globals.fetch, (run: () => unknown, ms: number) => { timers.push({ run, ms }); return timers.length },
    globals.parent, ResizeObserver) as Page['helpers']
  return { nodes, writes, timers, helpers, theme: () => dataset.theme, height }
}

/** The panel page, with the New project form below the queue, reaching the service through `fetch`. */
const runPage = (fetch: (url: string, init: RequestInit) => Promise<unknown>) => load(attentionPage('panel', '/panel/console-secret'), { fetch })

/** A tool result as t3code hands it to an MCP App. */
type ToolResult = { isError?: boolean; content?: { type: string; text?: string }[]; structuredContent?: Record<string, unknown> }
/**
 * The New project MCP App against a stand-in host: it answers `ui/initialize` with a dark theme and runs each `tools/call`
 * with `tool`, as t3code passes it to the console MCP server; a `tool` that throws is a JSON-RPC error from the host.
 * `calls` collects every tools/call, `notified` every notification the page sent and `sizes` the heights it gave in
 * `ui/notifications/size-changed`. The page's body has a ResizeObserver unless `resizeObserver` is false.
 */
function runApp(tool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>, options: { resizeObserver?: false } = {}) {
  const calls: { name: string; arguments: Record<string, unknown> }[] = []
  const notified: string[] = []
  const sizes: number[] = []
  let listener: ((event: { data: unknown }) => void) | undefined
  const window = { addEventListener: (type: string, handler: typeof listener) => { if (type === 'message') listener = handler } }
  type Message = { id?: number; method: string; params: { name: string; arguments: Record<string, unknown>; height?: number } }
  const parent = { postMessage(message: Message, origin: string) {
    expect(origin).toBe('*')
    if (message.id === undefined) {
      notified.push(message.method)
      if (message.method === 'ui/notifications/size-changed') sizes.push(message.params.height!)
      return
    }
    void (async () => {
      // postMessage delivers later, never during the call.
      await new Promise(resolve => setTimeout(resolve, 0))
      let answer: Record<string, unknown>
      if (message.method === 'ui/initialize') answer = { result: { protocolVersion: '2026-01-26', hostContext: { theme: 'dark' } } }
      else if (message.method === 'tools/call') {
        calls.push(message.params)
        answer = await tool(message.params.name, message.params.arguments).then(result => ({ result }),
          (error: unknown) => ({ error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }))
      } else answer = { error: { code: -32601, message: `no ${message.method}` } }
      listener!({ data: { jsonrpc: '2.0', id: message.id, ...answer } })
    })()
  } }
  return { ...load(newProjectPage('app'), { parent, window, ...options.resizeObserver === false ? {} : { resizeObserver: true as const } }), calls, notified, sizes }
}
/** A tool result like the console server's `ok`. */
const toolOk = (value: Record<string, unknown>): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value })
const toolRefused = (text: string): ToolResult => ({ isError: true, content: [{ type: 'text', text }] })

const reply = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) })
const OPTIONS: NewProjectOptions = { enabled: true, workspace: '/w', groups: ['COMMON', 'FAMILY', 'PERSONAL'], top_level: true, name_rule: `A folder name must ${NAME_RULE}` }
const MADE = { key: 'PERSONAL/garden', status: 'ready', project_id: 'p-new-1', title: 'garden', root: '/w/PERSONAL/garden', head: '0123456789abcdef',
  branch: 'main', catalogue: 'added', index: 'added', scope: 'updated: 10 mapped entries', backups: ['/s/catalogue-backups/repositories.json.x'],
  manual_step: 'In T3 Code, open the settings of the project "garden" and turn off PR watching and "continue threads after server update".',
  job: 'j1', request: { trigger_id: 'console:new-project:j1', filed_in: 'PERSONAL/garden', status: 'accepted', result: 'accepted T-1234abcd in PERSONAL/garden (from main)' } }

/** The page with a scripted service: `answers` are the replies to superagent_new_project in turn; `sent` collects its arguments. */
function scripted(options: unknown = OPTIONS) {
  const sent: Record<string, unknown>[] = []
  const answers: (ReturnType<typeof reply> | Promise<ReturnType<typeof reply>>)[] = []
  let tickets = 0
  const page = runPage(async (_url, init) => {
    const body = JSON.parse(String(init.body)) as { name: string; arguments: Record<string, unknown> }
    if (body.name === 'superagent_attention') {
      tickets++
      return reply(200, { tickets: [{ id: `t${tickets}`, short: `T-${tickets}`, title: `Ticket ${tickets}`, stage: 'person/answer', question: 'Which?' }], alerts: [] })
    }
    if (body.name === 'superagent_new_project_options') return reply(200, options)
    if (body.name === 'superagent_new_project') { sent.push(body.arguments); return answers.shift() ?? reply(500, { error: 'no answer scripted' }) }
    return reply(404, { error: 'unknown action' })
  })
  return { ...page, sent, answers }
}
const fill = (page: Page, values: Partial<Record<'group' | 'name' | 'purpose' | 'title' | 'notes' | 'request', string>>) => {
  for (const [key, value] of Object.entries(values)) page.nodes[`np-${key}`]!.value = value
}
const submit = (page: Page) => page.nodes['np-form']!.listeners.submit![0]!({ preventDefault() {} })

describe('the panel\'s New project form', () => {
  it('is on the panel below the attention list, and on its own page for the MCP App, but not in the attention App', async () => {
    const panel = attentionPage('panel', '/panel/console-secret')
    expect(panel.indexOf('id="np-form"')).toBeGreaterThan(panel.indexOf('id="list"'))
    const form = newProjectPage('app')
    expect(form).not.toContain('id="list"')
    // The attention App stays the queue only: the console's form is superagent_new_project_form.
    expect(attentionPage('app')).not.toContain('np-form')
    for (const html of [panel, form]) {
      for (const id of ['np-group', 'np-name', 'np-purpose', 'np-title', 'np-notes', 'np-request', 'np-create']) expect(html).toContain(`id="${id}"`)
      // One self-contained page: no script, style or font from elsewhere, and the look's light and dark colours.
      expect(html).not.toMatch(/<script src|<link /)
      expect(html).toContain(':root[data-theme=dark]{')
      expect(html).toContain('@media (prefers-color-scheme:dark)')
      // A long workspace path wraps rather than widening the form past a phone's width (seen at 390 px in a browser).
      expect(html).toContain('form.np{display:grid;grid-template-columns:minmax(0,1fr);')
    }
    const env = await start()
    const page = await fetch(`${env.made.base}/panel/console-secret`)
    expect(await page.text()).toBe(panel)
  })

  it('checks a repo name as superagent_new_project does', () => {
    const { helpers } = scripted()
    const names = ['garden', 'Garden 2', 'a.b_c+d-e', ' padded ', '.hidden', '-dash', 'a:b', 'x.lock', 'ends.', 'a/b', 'ünï', 'x'.repeat(100), 'x'.repeat(101), '']
    for (const name of names) expect(helpers.nameProblem(name) === '', name).toBe(!!name.trim() && goodName(name.trim()))
    expect(helpers.nameProblem('.hidden')).toBe(`".hidden" cannot be a folder name: ${NAME_RULE}`)
    expect(helpers.folderOf('PERSONAL', ' garden ')).toBe('PERSONAL/garden')
    expect(helpers.folderOf('/', 'garden')).toBe('garden')
  })

  it('posts superagent_new_project with the group and name as the folder, shows progress, then what was made', async () => {
    const page = scripted()
    await until(() => page.nodes['np-form']!.hidden === false, 'the form')
    expect(page.nodes['np-off']!.hidden).toBe(true)
    expect(page.nodes['np-group']!.innerHTML).toBe('<option value="">Choose a group</option><option value="COMMON">COMMON/</option>'
      + '<option value="FAMILY">FAMILY/</option><option value="PERSONAL">PERSONAL/</option><option value="/">The top level of the workspace</option>')
    expect(page.nodes['np-rule']!.textContent).toBe(`A folder name must ${NAME_RULE}`)
    fill(page, { group: 'PERSONAL', name: ' garden ', purpose: ' Plan the vegetable garden by season. ', title: '  ', notes: 'Beds are numbered from the gate.',
      request: 'Write a planting plan for spring' })
    page.nodes['np-form']!.listeners.input![0]!({})
    expect(page.nodes['np-folder']!.textContent).toBe('PERSONAL/garden')
    let answer!: (value: ReturnType<typeof reply>) => void
    page.answers.push(new Promise(resolve => { answer = resolve }))
    submit(page)
    expect(page.nodes['np-create']!.disabled).toBe(true)
    expect(page.nodes['np-create']!.textContent).toMatch(/^Creating… \d+ s$/)
    expect(page.nodes['np-result']!.innerHTML).toContain('Creating PERSONAL/garden')
    expect(page.sent).toEqual([{ folder: 'PERSONAL/garden', purpose: 'Plan the vegetable garden by season.', notes: 'Beds are numbered from the gate.',
      request: 'Write a planting plan for spring' }])
    answer(reply(200, MADE))
    const html = await until(() => page.nodes['np-result']!.innerHTML.includes('Created') && page.nodes['np-result']!.innerHTML, 'the result')
    for (const text of ['Created PERSONAL/garden</strong>, status ready', 'Folder: /w/PERSONAL/garden', 'first commit 0123456', '&quot;garden&quot; (p-new-1)',
      'repositories.json: added; scope line updated', 'REPOSITORIES.md: added', 'First request: accepted T-1234abcd in PERSONAL/garden (from main)',
      'Left to you:</strong> In T3 Code, open the settings of the project &quot;garden&quot; and turn off PR watching']) expect(html).toContain(text)
    expect(html).not.toContain('Warnings')
    expect(page.nodes['np-create']!.disabled).toBe(false)
    expect(page.nodes['np-create']!.textContent).toBe('Create')
  })

  it('shows warnings, a refusal and a failure part way plainly, escaping what the service says', async () => {
    const page = scripted()
    await until(() => page.nodes['np-form']!.hidden === false, 'the form')
    fill(page, { group: '/', name: 'garden', purpose: 'Plan it.' })
    page.answers.push(reply(200, { ...MADE, key: 'garden', status: 'no-git', why: 'Not <a> checkout.', index: 'not changed: no heading.', repeated: true,
      request: { refused: 'Project garden is no-git.' } }))
    submit(page)
    let html = await until(() => page.nodes['np-result']!.innerHTML.includes('Created') && page.nodes['np-result']!.innerHTML, 'the result')
    expect(page.sent.at(-1)).toEqual({ folder: 'garden', purpose: 'Plan it.' })
    for (const text of ['This finished a job an earlier Create started.', 'Warnings:', 'Its status is no-git: Not &lt;a&gt; checkout.',
      'REPOSITORIES.md was not changed: no heading.', 'The first request was refused: Project garden is no-git.']) expect(html).toContain(text)

    page.answers.push(reply(400, { error: 'garden is in the catalogue already, as <b>garden</b>.' }))
    submit(page)
    html = await until(() => page.nodes['np-result']!.innerHTML.includes('Not created') && page.nodes['np-result']!.innerHTML, 'the refusal')
    expect(html).toContain('This Create changed nothing.')
    expect(html).toContain('garden is in the catalogue already, as &lt;b&gt;garden&lt;/b&gt;.')
    expect(html).not.toContain('{&quot;error')

    page.answers.push(reply(400, { error: `stopped before register ${PART_WAY}` }))
    submit(page)
    html = await until(() => page.nodes['np-result']!.innerHTML.includes('Stopped part way') && page.nodes['np-result']!.innerHTML, 'the failure')
    expect(html).toContain('Press Create again with the same values to finish the job; nothing is made twice.')

    // A name the tool would refuse is not sent.
    fill(page, { name: '.hidden' })
    page.nodes['np-form']!.listeners.input![0]!({})
    expect(page.nodes['np-bad']!.textContent).toContain('".hidden" cannot be a folder name')
    expect(page.nodes['np-folder']!.textContent).toBe('none yet')
    const before = page.sent.length
    submit(page)
    expect(page.nodes['np-result']!.innerHTML).toContain('&quot;.hidden&quot; cannot be a folder name')
    fill(page, { group: '', name: 'garden' })
    submit(page)
    expect(page.nodes['np-result']!.innerHTML).toContain('Choose a group.')
    fill(page, { group: 'FAMILY', purpose: ' ' })
    submit(page)
    expect(page.nodes['np-result']!.innerHTML).toContain('Give the purpose')
    expect(page.sent).toHaveLength(before)
  })

  it('leaves what is typed alone when the list refreshes', async () => {
    const page = scripted()
    await until(() => page.nodes['np-form']!.hidden === false && page.nodes.list!.innerHTML.includes('Ticket 1'), 'the form and the list')
    const values = { group: 'FAMILY', name: 'album', purpose: 'Sort the photos.', title: 'Album', notes: 'Scans first.', request: 'List the boxes' }
    fill(page, values)
    const typed = page.writes.length
    const timer = page.timers.find(item => item.ms === 15_000)!
    await timer.run()
    await until(() => page.nodes.list!.innerHTML.includes('Ticket 2'), 'the refreshed list')
    expect(page.writes.slice(typed).filter(write => write.startsWith('np-'))).toEqual([])
    for (const [key, value] of Object.entries(values)) expect(page.nodes[`np-${key}`]!.value).toBe(value)
  })

  it('tells a reply that is not a refusal apart from one, and sends one Create at a time', async () => {
    const page = scripted()
    await until(() => page.nodes['np-form']!.hidden === false, 'the form')
    fill(page, { group: 'PERSONAL', name: 'garden', purpose: 'Plan it.' })
    // A 500 is not the tool refusing: the job may have run on, so it is not "Not created".
    page.answers.push(reply(500, { error: 'The service stopped.' }))
    submit(page)
    let html = await until(() => page.nodes['np-result']!.innerHTML.includes('No answer came back') && page.nodes['np-result']!.innerHTML, 'the failure')
    expect(html).not.toContain('Not created')
    expect(html).toContain('The service stopped.')

    // A second submit while the first is running sends nothing more.
    let answer!: (value: ReturnType<typeof reply>) => void
    page.answers.push(new Promise(resolve => { answer = resolve }))
    const before = page.sent.length
    submit(page)
    submit(page)
    expect(page.sent).toHaveLength(before + 1)
    answer(reply(200, MADE))
    await until(() => page.nodes['np-result']!.innerHTML.includes('Created'), 'the result')
    expect(page.sent).toHaveLength(before + 1)
  })

  it('says a first request the Router has not decided yet is normal, and how to follow it', async () => {
    const page = scripted()
    await until(() => page.nodes['np-form']!.hidden === false, 'the form')
    fill(page, { group: 'PERSONAL', name: 'garden', purpose: 'Plan it.', request: 'Write a plan' })
    page.answers.push(reply(200, { ...MADE, request: { trigger_id: 'console:new-project:j1', filed_in: 'PERSONAL/garden', status: 'pending',
      result: 'pending: console:new-project:j1', next: 'The Router has not decided yet, which is normal: check superagent_attention.' } }))
    submit(page)
    const html = await until(() => page.nodes['np-result']!.innerHTML.includes('Created') && page.nodes['np-result']!.innerHTML, 'the result')
    expect(html).toContain('First request: filed in PERSONAL/garden, not decided yet. That is normal: the Router decides in a moment')
    expect(html).toContain('superagent_ticket with console:new-project:j1')
    expect(html).not.toContain('Warnings')
  })

  it('shows the options\' warning above Create, and a notice when no folder can take a new project', async () => {
    const warned = scripted({ ...OPTIONS, warning: 'Git has no <user.email>: set it, then Create.' })
    await until(() => warned.nodes['np-form']!.hidden === false, 'the form')
    expect(warned.nodes['np-warn']!.textContent).toBe('Git has no <user.email>: set it, then Create.')

    const none = scripted({ ...OPTIONS, groups: [], top_level: false })
    const off = await until(() => none.nodes['np-off']!.textContent.includes('No folder') && none.nodes['np-off']!.textContent, 'the notice')
    expect(off).toContain('No folder of /w can take a new project')
    expect(none.nodes['np-form']!.hidden).toBe(true)
    expect(none.nodes['np-off']!.hidden).toBe(false)
  })

  it('says why new projects are off, and how to turn them on, in place of the form', async () => {
    const page = scripted({ enabled: false, why: 'No catalogue is configured, and new projects are added to it.', enable: 'Set SUPERAGENT_CATALOGUE <here>.',
      groups: [], top_level: false, name_rule: '' })
    const off = await until(() => page.nodes['np-off']!.innerHTML.includes('off') && page.nodes['np-off']!.innerHTML, 'the notice')
    expect(off).toBe('<strong>New projects are off.</strong> No catalogue is configured, and new projects are added to it. Set SUPERAGENT_CATALOGUE &lt;here&gt;.')
    expect(page.nodes['np-form']!.hidden).toBe(true)
  })
})

describe('the New project form as an MCP App in the console thread', () => {
  it('is registered like superagent_attention, with its own UI resource, and leaves superagent_attention as it was', async () => {
    const env = await start()
    const { tools } = await env.client.listTools()
    const form = tools.find(tool => tool.name === 'superagent_new_project_form')!
    expect(form._meta).toEqual({ ui: { resourceUri: NEW_PROJECT_URI }, 'ui/resourceUri': NEW_PROJECT_URI })
    expect(form.annotations).toMatchObject({ readOnlyHint: true })
    expect(Object.keys(form.inputSchema.properties ?? {})).toEqual([])
    const attention = tools.find(tool => tool.name === 'superagent_attention')!
    expect(attention._meta).toEqual({ ui: { resourceUri: ATTENTION_URI }, 'ui/resourceUri': ATTENTION_URI })
    expect(attention.description).toMatch(/^What waits for a person, first:/)

    const { resources } = await env.client.listResources()
    expect(resources.map(item => [item.uri, item.mimeType])).toEqual(expect.arrayContaining([[ATTENTION_URI, MCP_APP_MIME], [NEW_PROJECT_URI, MCP_APP_MIME]]))
    expect((await env.client.readResource({ uri: NEW_PROJECT_URI })).contents).toEqual([{ uri: NEW_PROJECT_URI, mimeType: MCP_APP_MIME, text: newProjectPage('app') }])
    expect((await env.client.readResource({ uri: ATTENTION_URI })).contents).toEqual([{ uri: ATTENTION_URI, mimeType: MCP_APP_MIME, text: attentionPage('app') }])

    // The tool's own result tells the console agent the form is shown and Create calls superagent_new_project itself.
    const shown = await env.client.callTool({ name: 'superagent_new_project_form', arguments: {} })
    expect(shown.isError).toBeFalsy()
    expect(data(shown)).toMatchObject({ enabled: true, groups: ['COMMON', 'FAMILY', 'PERSONAL'], top_level: true })
    expect(String(data(shown).form)).toContain('Its Create button calls superagent_new_project itself')
    expect(env.added).toEqual([])
  })

  it('creates a project through tools/call to the console server, with no model between the form and the tool', async () => {
    const env = await start()
    const app = runApp(async (name, args) => await env.client.callTool({ name, arguments: args }) as ToolResult)
    await until(() => app.nodes['np-form']!.hidden === false, `the form (${app.nodes['np-off']!.textContent})`)
    expect(app.theme()).toBe('dark')
    expect(app.notified[0]).toBe('ui/notifications/initialized')
    expect(app.nodes['np-group']!.innerHTML).toBe('<option value="">Choose a group</option><option value="COMMON">COMMON/</option>'
      + '<option value="FAMILY">FAMILY/</option><option value="PERSONAL">PERSONAL/</option><option value="/">The top level of the workspace</option>')
    fill(app, { group: 'PERSONAL', name: 'garden', purpose: 'Plan the vegetable garden.', title: 'Garden plan', notes: 'Beds are numbered from the gate.' })
    submit(app)
    expect(app.nodes['np-create']!.disabled).toBe(true)
    const html = await until(() => app.nodes['np-result']!.innerHTML.includes('Created') && app.nodes['np-result']!.innerHTML,
      `the result (${app.nodes['np-result']!.innerHTML})`, 30_000)
    expect(app.calls).toEqual([{ name: 'superagent_new_project_options', arguments: {} },
      { name: 'superagent_new_project', arguments: { folder: 'PERSONAL/garden', purpose: 'Plan the vegetable garden.', title: 'Garden plan',
        notes: 'Beds are numbered from the gate.' } }])
    expect(html).toContain('Created PERSONAL/garden</strong>, status ready')
    expect(html).toContain('&quot;Garden plan&quot; (p-new-1)')
    expect(html).toContain('turn off PR watching and &quot;continue threads after server update&quot;')
    expect(app.nodes['np-create']!.disabled).toBe(false)
    const root = join(realpathSync(env.dir), 'PERSONAL', 'garden')
    expect(env.added).toEqual([root])
    expect(execFileSync('git', ['-C', root, 'branch', '--show-current'], { encoding: 'utf8' }).trim()).toBe('main')
    expect(readFileSync(join(env.dir, 'REPOSITORIES.md'), 'utf8')).toContain('[PERSONAL/garden](PERSONAL/garden/REPO_MAP.md)')
  }, 60_000)

  it('shows a refusal, a failure part way and an answer the host lost, escaping what comes back', async () => {
    const answers: (() => Promise<ToolResult>)[] = [
      async () => toolRefused('PERSONAL/garden is in the catalogue already, as <b>garden</b>.'),
      async () => toolRefused(`stopped before <register> ${PART_WAY}`),
      () => Promise.reject(new Error('The host closed <the> call.')),
      async () => toolOk({ ...MADE, title: '<i>garden</i>' }),
    ]
    const app = runApp(async name => name === 'superagent_new_project_options' ? toolOk({ ...OPTIONS }) : answers.shift()!())
    await until(() => app.nodes['np-form']!.hidden === false, `the form (${app.nodes['np-off']!.textContent})`)
    fill(app, { group: 'PERSONAL', name: 'garden', purpose: 'Plan it.' })
    const result = (text: string) => until(() => app.nodes['np-result']!.innerHTML.includes(text) && app.nodes['np-result']!.innerHTML, text)

    submit(app)
    let html = await result('Not created')
    expect(html).toContain('This Create changed nothing.')
    expect(html).toContain('as &lt;b&gt;garden&lt;/b&gt;.')
    submit(app)
    html = await result('Stopped part way')
    expect(html).toContain('Press Create again with the same values to finish the job; nothing is made twice.')
    expect(html).toContain('stopped before &lt;register&gt;')
    submit(app)
    html = await result('No answer came back')
    expect(html).toContain('press Create again with the same values to finish it or to see what it made.')
    expect(html).toContain('The host closed &lt;the&gt; call.')
    submit(app)
    html = await result('Created')
    expect(html).toContain('&quot;&lt;i&gt;garden&lt;/i&gt;&quot; (p-new-1)')
    expect(html).not.toContain('<i>')
    // Each Create sent the same arguments, so a repeat finishes what an earlier one started.
    expect(app.calls.slice(1).map(item => item.arguments)).toEqual(Array(4).fill({ folder: 'PERSONAL/garden', purpose: 'Plan it.' }))
  })

  it('gives T3 Code its height after it starts, when the form fills, and when a result renders, so the frame fits it', async () => {
    let answer!: (result: ToolResult) => void
    const app = runApp(async name => name === 'superagent_new_project_options' ? toolOk({ ...OPTIONS })
      : await new Promise<ToolResult>(resolve => { answer = resolve }))
    // The stand-in body is a fraction of a pixel taller than `height`, which the page rounds up.
    const shown = () => app.height() + 1
    await until(() => app.nodes['np-form']!.hidden === false && app.sizes.at(-1) === shown(), 'the form\'s height')
    // T3 Code draws an App 320 px high until it hears otherwise; the first height comes right after ui/notifications/initialized.
    expect(app.notified.slice(0, 2)).toEqual(['ui/notifications/initialized', 'ui/notifications/size-changed'])
    expect(app.sizes[0]).toBe(71)
    const form = app.sizes.at(-1)!
    expect(form).toBeGreaterThan(640)
    fill(app, { group: 'PERSONAL', name: 'garden', purpose: 'Plan it.' })
    submit(app)
    await until(() => !!answer, 'the call')
    answer(toolOk({ ...MADE }))
    await until(() => app.nodes['np-result']!.innerHTML.includes('Created') && app.sizes.at(-1) === shown(), 'the result\'s height')
    expect(app.sizes.at(-1)).toBeGreaterThan(form)
    // A height is sent only when it changes, in whole pixels.
    expect(app.sizes.filter((height, at) => height === app.sizes[at - 1])).toEqual([])
    expect(app.sizes.every(Number.isInteger)).toBe(true)
  })

  it('gives its height once without a ResizeObserver', async () => {
    const app = runApp(async () => toolOk({ ...OPTIONS }), { resizeObserver: false })
    await until(() => app.nodes['np-form']!.hidden === false, 'the form')
    await until(() => app.sizes.length > 0, 'a height')
    expect(app.sizes).toHaveLength(1)
  })

  it('says nothing was made when T3 Code declines to run the call, as when the operator declines its permission prompt', async () => {
    const answers: (() => Promise<ToolResult>)[] = [
      () => Promise.reject(new Error('Declined by the user.')),
      () => Promise.reject(new Error('T3 could not ask for approval here.')),
      () => Promise.reject(new Error('Too many requests in flight.')),
    ]
    const app = runApp(async name => name === 'superagent_new_project_options' ? toolOk({ ...OPTIONS }) : answers.shift()!())
    await until(() => app.nodes['np-form']!.hidden === false, 'the form')
    fill(app, { group: 'PERSONAL', name: 'garden', purpose: 'Plan it.' })
    const result = (text: string) => until(() => app.nodes['np-result']!.innerHTML.includes(text) && app.nodes['np-result']!.innerHTML, text)
    submit(app)
    let html = await result('Declined by the user.')
    expect(html).toContain('<strong>Not created.</strong> The permission prompt in T3 Code was declined, so superagent_new_project did not run and nothing was made.')
    expect(html).not.toContain('No answer came back')
    for (const text of ['T3 could not ask for approval here.', 'Too many requests in flight.']) {
      submit(app)
      html = await result(text)
      expect(html).toContain('<strong>Not created.</strong> T3 Code did not run superagent_new_project, so nothing was made.')
      expect(html).not.toContain('No answer came back')
    }
  })

  it('says why new projects are off, and how to turn them on, in place of the form', async () => {
    const env = await start({ catalogue: false })
    const app = runApp(async (name, args) => await env.client.callTool({ name, arguments: args }) as ToolResult)
    const off = await until(() => app.nodes['np-off']!.innerHTML.includes('off') && app.nodes['np-off']!.innerHTML, 'the notice')
    expect(off).toContain('<strong>New projects are off.</strong> No catalogue is configured')
    expect(off).toContain('Set SUPERAGENT_CATALOGUE')
    expect(app.nodes['np-form']!.hidden).toBe(true)
    expect(app.calls.map(item => item.name)).toEqual(['superagent_new_project_options'])
  })
})

describe('the panel\'s HTTP API for a new project', () => {
  it('creates the project from POST /panel/<token>/action, and from the page\'s own script, and refuses a wrong token', async () => {
    const env = await start()
    const base = env.made.base
    const post = (token: string, name: string, args: Record<string, unknown>) => fetch(`${base}/panel/${token}/action`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, arguments: args }) })

    const refused = await post('wrong-token', 'superagent_new_project', { folder: 'PERSONAL/garden', purpose: 'Plan the garden.' })
    expect(refused.status).toBe(401)
    expect(existsSync(join(env.dir, 'PERSONAL', 'garden'))).toBe(false)
    expect(env.added).toEqual([])

    const response = await post('console-secret', 'superagent_new_project', { folder: 'PERSONAL/garden', purpose: 'Plan the garden.' })
    expect(response.status).toBe(200)
    const made = await response.json() as Record<string, unknown>
    const root = join(realpathSync(env.dir), 'PERSONAL', 'garden')
    expect(made).toMatchObject({ key: 'PERSONAL/garden', status: 'ready', root, catalogue: 'added', index: 'added' })
    expect(execFileSync('git', ['-C', root, 'log', '--format=%s'], { encoding: 'utf8' }).trim()).toBe('Start PERSONAL/garden')
    expect(env.t3.projects.some(project => project.workspaceRoot === root)).toBe(true)
    expect(readFileSync(env.catalogue, 'utf8')).toContain('"path": "PERSONAL/garden"')

    // A denied folder is refused with the tool's text, as a 400 the page shows as a refusal.
    const denied = await post('console-secret', 'superagent_new_project', { folder: 'ARCHIVE/garden', purpose: 'Plan the garden.' })
    expect(denied.status).toBe(400)
    expect((await denied.json() as { error: string }).error).toContain('denied by default (ARCHIVE/)')

    // The page's script against this service: the options, then Create, then the result.
    const page = runPage((url, init) => fetch(base + url, init))
    await until(() => page.nodes['np-form']!.hidden === false, `the form (${page.nodes['np-off']!.textContent})`)
    expect(page.nodes['np-group']!.innerHTML).toContain('<option value="FAMILY">FAMILY/</option>')
    fill(page, { group: 'FAMILY', name: 'album', purpose: 'Sort the photos.', request: 'List the boxes' })
    submit(page)
    const html = await until(() => page.nodes['np-result']!.innerHTML.includes('Created') && page.nodes['np-result']!.innerHTML,
      `the result (${page.nodes['np-result']!.innerHTML})`, 30_000)
    expect(html).toContain('Created FAMILY/album</strong>, status ready')
    expect(html).toMatch(/First request: accepted T-\w+ in FAMILY\/album/)
    expect(html).toContain('turn off PR watching and &quot;continue threads after server update&quot;')
    expect(existsSync(join(env.dir, 'FAMILY', 'album', '.git'))).toBe(true)

    // The same Create again finds the job done and makes nothing twice.
    submit(page)
    await until(() => page.nodes['np-result']!.innerHTML.includes('This finished a job an earlier Create started.'), 'the repeated result', 30_000)
    expect(env.added.filter(path => path.endsWith('album'))).toHaveLength(1)
  }, 60_000)

  it('says a failure part way can be finished by pressing Create again, and it then finishes', async () => {
    let failAt: Step | undefined = 'register'
    const env = await start({ beforeStep: step => { if (step === failAt) { failAt = undefined; throw new Error(`stopped before ${step}`) } } })
    const page = runPage((url, init) => fetch(env.made.base + url, init))
    await until(() => page.nodes['np-form']!.hidden === false, 'the form')
    fill(page, { group: 'COMMON', name: 'kit', purpose: 'Shared kit.' })
    submit(page)
    await until(() => page.nodes['np-result']!.innerHTML.includes('Stopped part way'), `the failure (${page.nodes['np-result']!.innerHTML})`, 30_000)
    expect(page.nodes['np-result']!.innerHTML).toContain('stopped before register')
    submit(page)
    await until(() => page.nodes['np-result']!.innerHTML.includes('Created COMMON/kit'), `the result (${page.nodes['np-result']!.innerHTML})`, 30_000)
    expect(page.nodes['np-result']!.innerHTML).toContain('This finished a job an earlier Create started.')
    expect(env.added).toHaveLength(1)
  }, 60_000)
})
