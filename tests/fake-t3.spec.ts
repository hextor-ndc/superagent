/** The in-memory t3code itself: its scratch threads get real folders, and none of them outlive the test that made them. */
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeT3, removeAllScratch } from './fake-t3.ts'

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
