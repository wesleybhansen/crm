/**
 * In-memory contact search.
 *
 * display_name / primary_email / primary_phone are encrypted at rest with a
 * random IV, so `ILIKE '%term%'` in SQL can never match an encrypted row.
 * Search callers load a bounded, org-scoped candidate set, decrypt it, and
 * filter here. The bound keeps the cost predictable; callers report when it
 * was hit so a miss is never silent.
 *
 * No imports: safe anywhere.
 */

/** How many of an organization's most recent contacts a search scans. */
export const CONTACT_SEARCH_CANDIDATE_LIMIT = 2000

export function contactMatchesSearch(
  row: { display_name?: unknown; primary_email?: unknown; primary_phone?: unknown },
  term: string,
  opts: { phone?: boolean } = {},
): boolean {
  const needle = term.trim().toLowerCase()
  if (!needle) return true
  const text = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : '')
  if (text(row.display_name).includes(needle)) return true
  if (text(row.primary_email).includes(needle)) return true
  if (opts.phone) {
    const digits = needle.replace(/\D/g, '')
    if (digits.length >= 3 && typeof row.primary_phone === 'string' && row.primary_phone.replace(/\D/g, '').includes(digits)) {
      return true
    }
  }
  return false
}
