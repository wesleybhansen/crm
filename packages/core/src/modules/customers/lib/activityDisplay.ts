/* Display helpers for contact activities.
 *
 * Some activities are logged by the system (a form submission, a survey
 * response) rather than typed in by a person. Their type is a machine value
 * ("form_submission") with no entry in the workspace's activity-type
 * dictionary, and older rows stored the answers as a JSON body, which the
 * decryption layer hands back as an object. These helpers turn both into
 * plain text for the Activities tab.
 *
 * Relative imports only. */

const KNOWN_TYPE_LABELS: Record<string, string> = {
  form_submission: 'Form submission',
  survey_response: 'Survey response',
  email_sent: 'Email sent',
  email_received: 'Email received',
  booking_created: 'Booking',
  event_registration: 'Event registration',
  course_enrollment: 'Course enrollment',
}

/** "form_submission" -> "Form submission"; unknown machine values are turned
 * into words the same way. Values that already read as words are kept. */
export function humanizeActivityType(type: string | null | undefined): string {
  const raw = typeof type === 'string' ? type.trim() : ''
  if (!raw) return ''
  const known = KNOWN_TYPE_LABELS[raw.toLowerCase()]
  if (known) return known
  if (!/[_-]/.test(raw) && /\s|[A-Z]/.test(raw)) return raw
  const words = raw.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

const HIDDEN_KEYS = new Set(['funnel_sid', 'funnel_step', 'funnel_slug'])

function valueText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.map(valueText).filter(Boolean).join(', ')
  if (typeof value === 'object') {
    try { return JSON.stringify(value) } catch { return '' }
  }
  return String(value).trim()
}

/** Plain text for an activity subject or body. Strings pass through; an
 * object (a stored JSON body) becomes one "key: value" line per answer. */
export function formatActivityText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    const text = valueText(value)
    return text || null
  }
  if (typeof value === 'object') {
    const lines: string[] = []
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key.startsWith('_') || HIDDEN_KEYS.has(key)) continue
      const text = valueText(entry)
      if (!text) continue
      lines.push(`${key}: ${text}`)
    }
    return lines.length ? lines.join('\n') : null
  }
  return null
}
