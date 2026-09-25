/* Defaults for a field added in the form builder. Relative imports only. */

/** A new email field maps to the contact's email so a submission attaches to
 * (or creates) the right contact, unless another field already holds that
 * mapping. Other field types start unmapped. */
export function defaultCrmMappingFor(
  type: string,
  existing: Array<{ crm_mapping?: string }>,
): string | undefined {
  if (type !== 'email') return undefined
  if (existing.some((f) => f.crm_mapping === 'contact.email')) return undefined
  return 'contact.email'
}
