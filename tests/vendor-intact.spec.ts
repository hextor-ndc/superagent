/**
 * vendor/dsh is DeepSeek's core, vendored and never edited here (docs/multi-project-plan.md, D22). Every file under it,
 * with nothing excluded, is hashed and compared with tests/fixtures/vendor-dsh.sha256, which lives outside the vendored
 * tree so the tree gains no file. The manifest pins the tree as it was when the manifest was written; it does not show that
 * the tree equals the upstream commit in vendor/dsh/UPSTREAM plus the one change README "Develop" records.
 *
 * The bytes are compared as checked out, so .gitattributes marks vendor/dsh and the manifest `-text`: a clone with
 * core.autocrlf (Git for Windows' default) would otherwise get CRLF line endings and fail here with nothing edited.
 *
 * After a deliberate update of vendor/dsh, write the manifest again from the repository root with (on Windows, in Git Bash,
 * which has shasum):
 *
 *   (cd vendor/dsh && find . -type f | sed 's|^\./||' | LC_ALL=C sort | tr '\n' '\0' | xargs -0 shasum -a 256) > tests/fixtures/vendor-dsh.sha256
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const VENDOR = fileURLToPath(new URL('../vendor/dsh', import.meta.url))
const MANIFEST = fileURLToPath(new URL('./fixtures/vendor-dsh.sha256', import.meta.url))
const ROOT = fileURLToPath(new URL('..', import.meta.url))
/** Whether this tree is a git checkout; a copy without .git has no attributes to check. */
const inGit = (() => { try { execFileSync('git', ['-C', ROOT, 'rev-parse', '--git-dir'], { stdio: 'ignore' }); return true } catch { return false } })()

/** Every file under `dir` as `<sha256>  <path relative to dir>`, sorted by path, in the format `shasum -a 256` writes. */
function hashes(dir: string): string[] {
  const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter(entry => !entry.isDirectory())
  return files.map(entry => {
    const path = join(entry.parentPath, entry.name)
    // A symlink or other special file would not be hashed by its content here, so it counts as a change.
    const hash = entry.isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : `not a regular file`
    return { path: relative(dir, path), hash }
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(({ path, hash }) => `${hash}  ${path}`)
}

describe('vendor/dsh', () => {
  it('matches the manifest file for file, with no file added or removed', () => {
    const expected = readFileSync(MANIFEST, 'utf8').split('\n').filter(Boolean)
    const actual = hashes(VENDOR)
    // Listed apart so a failure names the files: changed ones appear in both lists, added and removed ones in one.
    expect({ unexpected: actual.filter(line => !expected.includes(line)), missing: expected.filter(line => !actual.includes(line)) })
      .toEqual({ unexpected: [], missing: [] })
    expect(actual).toEqual(expected)
  })

  it.skipIf(!inGit)('is checked out without line-ending conversion, as is the manifest', () => {
    const paths = [...hashes(VENDOR).map(line => join('vendor/dsh', line.slice(66))), 'tests/fixtures/vendor-dsh.sha256']
    const attributes = execFileSync('git', ['-C', ROOT, 'check-attr', 'text', '--', ...paths], { encoding: 'utf8' }).trim().split('\n')
    expect(attributes).toEqual(paths.map(path => `${path}: text: unset`))
  })

  it('notices a changed byte, an added dotfile and a removed file, in a copy of the tree', () => {
    const copy = mkdtempSync(join(tmpdir(), 'vendor-dsh-'))
    try {
      cpSync(VENDOR, copy, { recursive: true })
      const manifest = readFileSync(MANIFEST, 'utf8').split('\n').filter(Boolean)
      expect(hashes(copy)).toEqual(manifest)
      appendFileSync(join(copy, 'src', 'policy.ts'), ' ')
      writeFileSync(join(copy, 'prompts', '.hidden'), 'x')
      rmSync(join(copy, 'LICENSE'))
      const changed = hashes(copy)
      const paths = (lines: string[]) => lines.map(line => line.slice(66))
      expect(paths(changed.filter(line => !manifest.includes(line)))).toEqual(['prompts/.hidden', 'src/policy.ts'])
      expect(paths(manifest.filter(line => !changed.includes(line)))).toEqual(['LICENSE', 'src/policy.ts'])
    } finally { rmSync(copy, { recursive: true, force: true }) }
  })
})
