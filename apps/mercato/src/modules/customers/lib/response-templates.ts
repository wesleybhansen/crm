/* Saved reply templates (table response_templates): input validation and the
 * placeholder fill shared by the email composer and the Customer Service
 * queue. Pure; no imports. */

export const RESPONSE_TEMPLATE_LIMITS = { name: 120, subject: 300, body: 10000, category: 40 } as const

export type ResponseTemplateValues = {
  name: string
  subject: string | null
  body_text: string
  category: string
}

export function normalizeResponseTemplateInput(
  raw: unknown,
): { ok: true; value: ResponseTemplateValues } | { ok: false; error: string } {
  const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const subject = typeof body.subject === 'string' ? body.subject.trim() : ''
  const text = typeof body.bodyText === 'string' ? body.bodyText.trim() : ''
  const category = typeof body.category === 'string' && body.category.trim() ? body.category.trim() : 'general'

  if (!name) return { ok: false, error: 'Give the template a name.' }
  if (!text) return { ok: false, error: 'Write the template text.' }
  if (name.length > RESPONSE_TEMPLATE_LIMITS.name) return { ok: false, error: `Keep the name under ${RESPONSE_TEMPLATE_LIMITS.name} characters.` }
  if (subject.length > RESPONSE_TEMPLATE_LIMITS.subject) return { ok: false, error: `Keep the subject under ${RESPONSE_TEMPLATE_LIMITS.subject} characters.` }
  if (text.length > RESPONSE_TEMPLATE_LIMITS.body) return { ok: false, error: `Keep the text under ${RESPONSE_TEMPLATE_LIMITS.body} characters.` }
  if (category.length > RESPONSE_TEMPLATE_LIMITS.category) return { ok: false, error: 'Use a shorter category.' }

  return { ok: true, value: { name, subject: subject || null, body_text: text, category } }
}

/** Fill {{firstName}}, {{name}} and {{email}} with the contact's details. */
export function fillResponseTemplate(text: string, contact: { name?: string | null; email?: string | null }): string {
  const name = (contact.name || '').trim()
  const firstName = name.split(/\s+/)[0] || ''
  return text
    .replace(/\{\{\s*firstName\s*\}\}/g, firstName)
    .replace(/\{\{\s*name\s*\}\}/g, name)
    .replace(/\{\{\s*email\s*\}\}/g, (contact.email || '').trim())
}
