/**
 * Human label for a contact's `source` column.
 *
 * Leads created through the AMS-to-CRM marketing channel are tagged with
 * the 'marketing' source category (onboarding audit, 2026-09-16; see
 * `packages/core/src/modules/customers/commands/people.ts`'s
 * deriveSourceFromInput and `lib/sourceTagging.ts`'s SourceCategory union).
 * Everything else keeps its raw source string as-is: this only rewrites
 * the one category that needs a friendlier, owner-facing label in the
 * contacts list and detail view. Pure and dependency-free so it is safe to
 * import from a client component.
 */
export function contactSourceLabel(source: string | null | undefined): string | null {
  if (!source) return null
  const category = source.split(':')[0]
  return category === 'marketing' ? 'From your marketing system' : null
}
