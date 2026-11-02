import { describe, expect, it } from 'vitest'
import { promptLink, pullRequestLink, withThreadLink } from '../src/t3/links.ts'

describe('links into t3code (point 4)', () => {
  it('builds prompt links in t3code\'s documented format', () => {
    expect(pullRequestLink('acme/widgets', 7, 'Fix the failing check')).toBe(
      'https://app.t3.codes/new?pr=acme%2Fwidgets%2F7&prompt=Fix+the+failing+check')
    const link = new URL(promptLink('x'.repeat(9000), { repository: 'acme/widgets', provider: 'codex' }))
    expect(link.searchParams.get('prompt')).toHaveLength(8000)
    expect(link.searchParams.get('repo')).toBe('acme/widgets')
  })
  it('appends the thread link once, and nothing without one', () => {
    expect(withThreadLink('Done.', 'https://app.t3.codes/t/1')).toBe('Done.\n\n[Open in T3 Code](https://app.t3.codes/t/1)')
    expect(withThreadLink('See https://app.t3.codes/t/1', 'https://app.t3.codes/t/1')).toBe('See https://app.t3.codes/t/1')
    expect(withThreadLink('Done.', undefined)).toBe('Done.')
  })
})
