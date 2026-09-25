/**
 * A tool that finished but reports its own failure (`{ success: false, ... }`),
 * e.g. call_api relaying a downstream 4xx/5xx. MCP clients only see failures
 * flagged `isError`, so these came back looking like successes (MCP sweep
 * 2026-09-25). The payload (status code, error, details) is kept as is.
 */
export function isToolFailurePayload(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) && (value as { success?: unknown }).success === false
}

/** MCP content for a tool's successful execution result. */
export function mcpContentForResult(result: unknown): { content: Array<{ type: 'text'; text: string }>; isError?: true } {
  const content = [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }]
  return isToolFailurePayload(result) ? { content, isError: true } : { content }
}
