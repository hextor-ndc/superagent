/** A tool result with both a text block, which every provider reads, and structured content. */
export function ok(value: unknown) {
  const structured = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { value }
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], structuredContent: structured }
}
