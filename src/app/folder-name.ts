/**
 * The rules for a new project's folder name and the sentence a failure part way ends with, shared by `superagent_new_project`
 * (src/app/new-project.ts) and the New project form (src/mcp/attention-app.ts), which writes `SEGMENT`, `NAME_RULE` and
 * `PART_WAY` into the page's script. It imports nothing, so the page's module pulls in no Node code with it.
 */

/** One folder name: letters, digits, spaces and `. _ + -`, not starting with a dot or a dash and not ending in a dot or a space. */
export const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9 ._+-]*$/
/** The rule for each folder name in a new project's path, as a refusal and the panel's New project form state it. */
export const NAME_RULE = 'use letters, digits, spaces and . _ + -, not starting with a dot or a dash, and not ending in a dot, a space or ".lock" '
  + '(at most 100 characters).'
/** Whether `part` may be one folder name in a new project's path. The panel's form checks the same rule in the page. */
export const goodName = (part: string): boolean => SEGMENT.test(part) && !/[. ]$/.test(part) && !part.endsWith('.lock') && part.length <= 100
/**
 * The sentence a failure after the checks ends with, once the job file is written: a call with the same arguments finishes
 * the job. The panel's form looks for it to tell a failure part way from a refusal.
 */
export const PART_WAY = 'It stopped part way: call superagent_new_project again with the same arguments to finish the job; nothing is added twice.'
