import { configDefaults, defineConfig } from 'vitest/config'

// Claude Code keeps agent worktrees of this repository under .claude/worktrees; their copies of the suites are not ours to run.
export default defineConfig({ test: { exclude: [...configDefaults.exclude, '.claude/**'] } })
