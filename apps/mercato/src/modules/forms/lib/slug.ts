/* Form slug rules.
 *
 * A new form gets a slug from its name ("Untitled Form" -> untitled-form-x1y2).
 * While the form has never been published nobody can hold its link, so a
 * rename also renames the slug. Once it has been published the link may be
 * shared or embedded, so the slug stays put even if the form is renamed or
 * later unpublished.
 *
 * Relative imports only. */

function randomSuffix(): string {
  return Math.random().toString(36).substring(2, 6)
}

export function slugBase(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

/** Slug for a form name, with a short random suffix. */
export function slugifyFormName(text: string): string {
  const base = slugBase(text) || 'form'
  return `${base}-${randomSuffix()}`
}

export type SlugRuleForm = {
  name?: string | null
  status?: string | null
  published_at?: unknown
}

/** True when renaming `form` to `nextName` should give it a new slug. */
export function shouldRegenerateSlug(form: SlugRuleForm, nextName: unknown): boolean {
  if (typeof nextName !== 'string') return false
  const trimmed = nextName.trim()
  if (!trimmed) return false
  if (form.status === 'published') return false
  if (form.published_at !== null && form.published_at !== undefined && form.published_at !== '') return false
  return slugBase(trimmed) !== slugBase(form.name || '')
}
