/* Defaults for a NEW form's settings. Relative imports only: the list page and
 * the builder import this on the client, the create API on the server.
 *
 * settings.createContact gates whether a submission from someone not yet in
 * the CRM creates a contact (api/public/[slug]/submit/route.ts). With no
 * contact, no sequence or automation starts for that sign-up, so a new form
 * that captures an email defaults to ON. An explicit true/false is always
 * kept, and existing forms are never rewritten (only form creation applies
 * these defaults). */

type FieldLike = { type?: unknown; crm_mapping?: unknown; crmMapping?: unknown } | null | undefined

/** Same test the public submit route uses to find the email field. */
export function formCapturesEmail(fields: readonly FieldLike[] | null | undefined): boolean {
  if (!Array.isArray(fields)) return false
  return fields.some((f) => !!f && (f.type === 'email' || f.crm_mapping === 'contact.email' || f.crmMapping === 'primary_email'))
}

/** Settings for a form being created: createContact defaults to ON when the
 * form captures an email and the caller did not choose. */
export function withNewFormDefaults(settings: unknown, fields: readonly FieldLike[] | null | undefined): Record<string, unknown> {
  let parsed: unknown = settings
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) } catch { parsed = null }
  }
  const out: Record<string, unknown> = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...(parsed as Record<string, unknown>) } : {}
  if (typeof out.createContact !== 'boolean' && formCapturesEmail(fields)) out.createContact = true
  return out
}

/** A blank form in the builder: contact creation starts ON, so the email
 * field the user adds captures sign-ups without a second trip to Settings. */
export const BLANK_FORM_SETTINGS = {
  submitLabel: 'Submit',
  successMessage: 'Thank you for your submission!',
  createContact: true,
} as const
