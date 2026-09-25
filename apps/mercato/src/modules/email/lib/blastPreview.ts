/**
 * Blast helpers shared by the Email Marketing page and the test-send API.
 * Kept dependency-free so both sides (and tests) can import it.
 */
export type PreviewSample = { firstName: string; name: string; email: string }

export const PREVIEW_SAMPLE: PreviewSample = { firstName: 'John', name: 'John Smith', email: 'john@example.com' }

/** Fill {{firstName}}, {{name}} and {{email}}, the same way for the subject and the body. */
export function fillBlastVariables(text: string, sample: PreviewSample = PREVIEW_SAMPLE): string {
  return (text || '')
    .replace(/\{\{\s*firstName\s*\}\}/g, sample.firstName)
    .replace(/\{\{\s*name\s*\}\}/g, sample.name)
    .replace(/\{\{\s*email\s*\}\}/g, sample.email)
}

const EMAIL_RE = /^[^\s@<>(),;:"[\]]+@[^\s@<>(),;:"[\]]+\.[^\s@<>(),;:"[\]]{2,}$/

/**
 * A test goes to exactly one address. Returns the trimmed address, or null
 * when it is missing, malformed or a list.
 */
export function parseTestRecipient(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 254) return null
  return EMAIL_RE.test(trimmed) ? trimmed : null
}

/** The message to show when a blast request fails; never an empty string. */
export function blastErrorMessage(data: unknown, fallback: string): string {
  if (data && typeof data === 'object') {
    const err = (data as { error?: unknown }).error
    if (typeof err === 'string' && err.trim()) return err.trim()
  }
  return fallback
}
