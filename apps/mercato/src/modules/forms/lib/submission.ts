/* Server-side rules for a public form submission.
 *
 * The public page validates in the browser too, but a script, an old cached
 * page or a direct POST skips that, so the submit route checks every answer
 * again before anything is stored. Messages are plain English: the page shows
 * them next to the field named in `field`.
 *
 * Relative imports only. */

export type PublicFormField = {
  id: string
  type?: string
  label?: string
  required?: boolean
  options?: string[]
  validation?: { min?: unknown; max?: unknown } & Record<string, unknown>
}

export type SubmissionValidationResult =
  | { ok: true }
  | { ok: false; field: string; error: string }

// Same shape the page checks in the browser: something@something.tld, no spaces.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const LAYOUT_TYPES = new Set(['section', 'page_break'])

export function isValidEmail(value: unknown): value is string {
  return typeof value === 'string' && EMAIL_PATTERN.test(value.trim())
}

function isEmptyAnswer(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim().length === 0
  if (Array.isArray(value)) return value.every((v) => isEmptyAnswer(v))
  return false
}

function fieldName(field: PublicFormField): string {
  const label = typeof field.label === 'string' ? field.label.trim() : ''
  return label || 'This field'
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim().length) {
    const n = Number(value.trim())
    return Number.isFinite(n) ? n : null
  }
  return null
}

export function validateFormSubmission(
  fields: PublicFormField[],
  data: Record<string, unknown>,
): SubmissionValidationResult {
  for (const field of Array.isArray(fields) ? fields : []) {
    if (!field || typeof field.id !== 'string') continue
    if (field.type && LAYOUT_TYPES.has(field.type)) continue
    const value = data[field.id]
    const empty = isEmptyAnswer(value)

    if (empty) {
      if (field.required) {
        return { ok: false, field: field.id, error: `${fieldName(field)} is required.` }
      }
      continue
    }

    if (field.type === 'email') {
      if (!isValidEmail(value)) {
        return {
          ok: false,
          field: field.id,
          error: 'Enter a valid email address, like name@example.com.',
        }
      }
    }

    if (field.type === 'number') {
      const n = toNumber(value)
      if (n === null) {
        return { ok: false, field: field.id, error: `${fieldName(field)} must be a number.` }
      }
      const min = toNumber(field.validation?.min)
      const max = toNumber(field.validation?.max)
      if (min !== null && n < min) {
        return { ok: false, field: field.id, error: `${fieldName(field)} must be ${min} or more.` }
      }
      if (max !== null && n > max) {
        return { ok: false, field: field.id, error: `${fieldName(field)} must be ${max} or less.` }
      }
    }
  }
  return { ok: true }
}

const INTERNAL_KEYS = new Set(['funnel_sid', 'funnel_step', 'funnel_slug'])
const MAX_VALUE_LENGTH = 300
const MAX_SUMMARY_LENGTH = 2000

function answerText(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (Array.isArray(value)) return value.map(answerText).filter(Boolean).join(', ')
  if (typeof value === 'object') {
    try { return JSON.stringify(value) } catch { return '' }
  }
  return String(value).trim()
}

/** One "Label: answer" line per answered field, in form order, for the
 * contact's activity entry. Unknown keys (not on the form any more) follow,
 * with the key as the label. Internal keys are left out. */
export function summarizeFormSubmission(
  fields: PublicFormField[],
  data: Record<string, unknown>,
): string {
  const lines: string[] = []
  const seen = new Set<string>()
  for (const field of Array.isArray(fields) ? fields : []) {
    if (!field || typeof field.id !== 'string') continue
    if (field.type && LAYOUT_TYPES.has(field.type)) continue
    seen.add(field.id)
    const text = answerText(data[field.id])
    if (!text) continue
    lines.push(`${fieldName(field)}: ${text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH)}...` : text}`)
  }
  for (const [key, value] of Object.entries(data || {})) {
    if (seen.has(key) || key.startsWith('_') || INTERNAL_KEYS.has(key)) continue
    const text = answerText(value)
    if (!text) continue
    lines.push(`${key}: ${text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH)}...` : text}`)
  }
  const out = lines.join('\n')
  return out.length > MAX_SUMMARY_LENGTH ? `${out.slice(0, MAX_SUMMARY_LENGTH)}...` : out
}
