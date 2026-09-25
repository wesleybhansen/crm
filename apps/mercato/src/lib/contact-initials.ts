/**
 * Avatar initials from a display name, using letters and digits only, so a
 * prefix like "[e2e]" or "(VIP)" does not turn into "[A" (QA 2026-09-25 #18).
 * Words with no letter or digit are skipped; "[e2e] Alice Qatest" gives "AQ"
 * (a tag-like bracketed prefix is dropped when a real name follows it).
 */
const BRACKETED_PREFIX_RE = /^\s*(?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\})\s*/u

export function contactInitials(name: string | null | undefined, max = 2, fallback = '?'): string {
  let text = typeof name === 'string' ? name.trim() : ''
  // Strip leading bracketed tags while something remains after them.
  let stripped = text
  while (BRACKETED_PREFIX_RE.test(stripped)) {
    const next = stripped.replace(BRACKETED_PREFIX_RE, '')
    if (!/[\p{L}\p{N}]/u.test(next)) break
    stripped = next
  }
  text = stripped
  const letters: string[] = []
  for (const word of text.split(/\s+/)) {
    const m = /[\p{L}\p{N}]/u.exec(word)
    if (m) letters.push(m[0].toLocaleUpperCase())
    if (letters.length >= max) break
  }
  return letters.length ? letters.join('') : fallback
}
