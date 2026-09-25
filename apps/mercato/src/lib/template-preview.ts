/**
 * Draft previews show a merge tag's value instead of the raw tag: the
 * dashboard's first follow-up draft read "Hi {{first_name}}," (QA 2026-09-25
 * #16). The recipient's first name fills it, or "there" when the draft has no
 * recipient yet ("Hi there,"). Other tags are left as they are; the send path
 * fills them per recipient.
 */
const FIRST_NAME_TAG_RE = /\{\{\s*(?:entity\.|contact\.)?(?:first_name|firstName|firstname)\s*\}\}/g

export function previewFirstNameTags(text: string | null | undefined, firstName?: string | null, fallback = 'there'): string {
  const name = typeof firstName === 'string' && firstName.trim() ? firstName.trim() : fallback
  return (text ?? '').replace(FIRST_NAME_TAG_RE, name)
}
