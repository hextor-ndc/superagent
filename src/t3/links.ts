/**
 * Point 4: links from GitHub and chat back into t3code. A Ticket's thread link comes from `t3_thread_launch`; prompt links
 * follow t3code's documented format (docs/user/prompt-links.md) and open a draft, never run anything.
 */
export const PROMPT_LINK_BASE = 'https://app.t3.codes/new'
/** At most this many characters of prompt, as t3code documents. */
const PROMPT_MAX = 8000

/** A link that opens the t3code thread linked to a pull request, with an optional draft prompt. */
export function pullRequestLink(repository: string, number: number, prompt?: string): string {
  const params = new URLSearchParams({ pr: `${repository}/${number}` })
  if (prompt) params.set('prompt', prompt.slice(0, PROMPT_MAX))
  return `${PROMPT_LINK_BASE}?${params}`
}

/** A link that opens a draft in the repository's most recent t3code project. */
export function promptLink(prompt: string, options: { repository?: string; provider?: string; model?: string } = {}): string {
  const params = new URLSearchParams({ prompt: prompt.slice(0, PROMPT_MAX) })
  if (options.repository) params.set('repo', options.repository)
  if (options.provider) params.set('provider', options.provider)
  if (options.model) params.set('model', options.model)
  return `${PROMPT_LINK_BASE}?${params}`
}

/**
 * Appends the "open in t3code" line to a message for a Channel. Chat messages keep to one short line, as the paper's
 * multi-channel rules ask; nothing is appended when the Ticket has no thread yet.
 */
export function withThreadLink(text: string, threadLink: string | undefined): string {
  if (!threadLink || text.includes(threadLink)) return text
  return `${text.trimEnd()}\n\n[Open in T3 Code](${threadLink})`
}
