import crypto from 'node:crypto'

/**
 * Blind search tokens for encrypted contact, company and deal fields.
 *
 * Names, emails, phones and deal titles are AES-GCM envelopes at rest with a
 * random IV, so SQL can never compare them. Search instead runs on a side
 * table of keyed hashes (customer_search_tokens): every searchable field is
 * normalized, cut into tokens, and each token is stored only as
 *
 *   token_hash = HMAC-SHA256(search_key, token)
 *   search_key = HKDF-SHA256(tenant data key, info = SEARCH_KEY_INFO)
 *
 * The search key is per tenant and derived from the tenant data key under a
 * distinct purpose label, so it is never the encryption key itself and the
 * same word in two tenants hashes differently. A query is normalized the same
 * way, each term is HMAC'd, and SQL matches hashes. No plaintext token is
 * ever stored or logged.
 *
 * Leakage, stated plainly (this is the tradeoff every blind index makes):
 * - Equality: within one tenant, two rows that share a token share its hash.
 *   Someone with read access to the table (but not the key) can tell that two
 *   contacts share a first name, an email domain or a phone suffix, and can
 *   group rows by that.
 * - Frequency: hash counts follow token frequency. Common names and prefixes
 *   ("jo", "gmail.com") stand out, and with outside knowledge of name
 *   distributions a frequent hash can be guessed.
 * - Shape: the number of tokens per field roughly reveals value length (edge
 *   prefixes are capped at MAX_PREFIX_LENGTH, which bounds it), and the
 *   plaintext `field` column says which field a hash came from.
 * - Across tenants nothing links: keys differ, so hashes differ.
 * Without the tenant key the hashes cannot be reversed by dictionary, which is
 * exactly what the old unkeyed SHA-256 search_tokens allowed.
 *
 * Token namespaces (the prefix before ':' is hashed along with the token):
 *   w:  word edge prefixes (2..12 chars) of names, titles, email local-part
 *       words and domain labels
 *   e:  a complete, normalized email address
 *   d:  a normalized domain (email domain, company domain, website host)
 *   lp: edge prefixes of a whole email local part that contains punctuation
 *       ("john.smith"), so a dotted query matches it
 *   p:  phone digits: the full number and its last 4 / 7 / 10 digits
 *
 * Only node:crypto: safe for worker bundles and the standalone backfill script.
 */

export const SEARCH_KEY_INFO = 'noli:crm:customer-search-index:v1'
export const MIN_TOKEN_LENGTH = 2
export const MAX_PREFIX_LENGTH = 12
/** Upper bound on query terms, so one pasted paragraph cannot build a huge SQL filter. */
export const MAX_QUERY_TERMS = 8
const PHONE_SUFFIXES = [4, 7, 10] as const
const MIN_PHONE_DIGITS = 4

export type SearchFieldKind = 'text' | 'email' | 'phone' | 'domain'

/** Lowercase, Unicode-compatibility fold, diacritics removed. Punctuation kept. */
export function foldText(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
}

/** Words of a folded string: runs of letters/digits, at least MIN_TOKEN_LENGTH code points. */
export function splitWords(value: string): string[] {
  return foldText(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => Array.from(w).length >= MIN_TOKEN_LENGTH)
}

/** Edge prefixes MIN_TOKEN_LENGTH..min(len, MAX_PREFIX_LENGTH), by code point. */
export function edgePrefixes(word: string): string[] {
  const chars = Array.from(word)
  const out: string[] = []
  const max = Math.min(chars.length, MAX_PREFIX_LENGTH)
  for (let i = MIN_TOKEN_LENGTH; i <= max; i++) out.push(chars.slice(0, i).join(''))
  return out
}

/** The longest stored prefix of a word: what a query term is matched on. */
export function capPrefix(word: string): string {
  return Array.from(word).slice(0, MAX_PREFIX_LENGTH).join('')
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function normalizeEmailForSearch(value: string): string | null {
  const v = foldText(value.trim())
  return EMAIL_RE.test(v) ? v : null
}

/** Host of a domain or URL: scheme, credentials, port, path and a leading www. removed. */
export function normalizeDomainForSearch(value: string): string | null {
  let v = foldText(value.trim())
  if (!v) return null
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  v = v.replace(/^[^/@]*@/, '')
  v = v.split(/[/?#]/)[0] ?? ''
  v = v.replace(/:\d+$/, '').replace(/^www\./, '').replace(/\.$/, '')
  return /^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+$/u.test(v) ? v : null
}

export function phoneDigitsForSearch(value: string): string {
  return value.replace(/\D/g, '')
}

function wordTokens(value: string): string[] {
  const out: string[] = []
  for (const word of splitWords(value)) for (const p of edgePrefixes(word)) out.push(`w:${p}`)
  return out
}

function emailTokens(value: string): string[] {
  const email = normalizeEmailForSearch(value)
  if (!email) return wordTokens(value)
  const at = email.lastIndexOf('@')
  const local = email.slice(0, at)
  const domain = email.slice(at + 1)
  const out = [`e:${email}`, `d:${domain}`, ...wordTokens(local), ...wordTokens(domain)]
  if (/[^\p{L}\p{N}]/u.test(local)) for (const p of edgePrefixes(local)) out.push(`lp:${p}`)
  return out
}

function domainTokens(value: string): string[] {
  const domain = normalizeDomainForSearch(value)
  if (!domain) return wordTokens(value)
  return [`d:${domain}`, ...wordTokens(domain)]
}

function phoneTokens(value: string): string[] {
  const digits = phoneDigitsForSearch(value)
  if (digits.length < MIN_PHONE_DIGITS) return []
  const out = [`p:${digits}`]
  for (const n of PHONE_SUFFIXES) if (digits.length > n) out.push(`p:${digits.slice(-n)}`)
  return out
}

/** Plaintext tokens for one field value (deduplicated). Never stored: callers hash them. */
export function tokensForField(kind: SearchFieldKind, value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return []
  let tokens: string[]
  switch (kind) {
    case 'email': tokens = emailTokens(value); break
    case 'phone': tokens = phoneTokens(value); break
    case 'domain': tokens = domainTokens(value); break
    default: tokens = wordTokens(value)
  }
  return Array.from(new Set(tokens))
}

/** One AND-ed query term: it matches a row when ANY of its candidate tokens is present. */
export type SearchTerm = { candidates: string[] }

const PHONE_QUERY_RE = /^[+\d\s().\-/]+$/
const DOMAIN_LIKE_RE = /^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+$/u

function phoneCandidates(digits: string): string[] {
  const out = [`p:${digits}`]
  if (digits.length > 10) out.push(`p:${digits.slice(-10)}`)
  return out
}

function wordTerm(word: string): SearchTerm {
  const candidates = [`w:${capPrefix(word)}`]
  if (/^\d+$/.test(word) && word.length >= MIN_PHONE_DIGITS) candidates.push(...phoneCandidates(word))
  return { candidates }
}

function localPartTerms(local: string): SearchTerm[] {
  const folded = foldText(local)
  if (!folded) return []
  if (/[^\p{L}\p{N}]/u.test(folded)) {
    return Array.from(folded).length >= MIN_TOKEN_LENGTH ? [{ candidates: [`lp:${capPrefix(folded)}`] }] : []
  }
  return Array.from(folded).length >= MIN_TOKEN_LENGTH ? [wordTerm(folded)] : []
}

/**
 * Normalize a free-text query into AND-ed terms, the same way stored values
 * are tokenized. Every term must match (AND); a term matches when any of its
 * candidates does. Terms shorter than MIN_TOKEN_LENGTH are dropped, so "j"
 * alone compiles to no terms and matches nothing.
 */
export function compileSearchQuery(query: string): SearchTerm[] {
  const raw = (query ?? '').trim()
  if (!raw) return []
  const terms: SearchTerm[] = []

  // A whole query that looks like a phone number ("+1 (555) 123-4567") is one term.
  if (PHONE_QUERY_RE.test(raw)) {
    const digits = phoneDigitsForSearch(raw)
    if (digits.length >= MIN_PHONE_DIGITS) {
      terms.push({ candidates: [...phoneCandidates(digits), `w:${capPrefix(digits)}`] })
      return terms
    }
  }

  for (const piece of raw.split(/\s+/)) {
    if (!piece) continue
    if (piece.includes('@')) {
      const email = normalizeEmailForSearch(piece)
      if (email) { terms.push({ candidates: [`e:${email}`] }); continue }
      const at = piece.indexOf('@')
      const local = piece.slice(0, at)
      const rest = piece.slice(at + 1)
      if (!local) {
        const domain = normalizeDomainForSearch(rest)
        if (domain) terms.push({ candidates: [`d:${domain}`] })
        else for (const w of splitWords(rest)) terms.push(wordTerm(w))
        continue
      }
      terms.push(...localPartTerms(local))
      for (const w of splitWords(rest)) terms.push(wordTerm(w))
      continue
    }
    const folded = foldText(piece)
    if (DOMAIN_LIKE_RE.test(folded) && /\p{L}/u.test(folded)) {
      // "acme.com" (a domain) or "john.smith" (a dotted local part).
      terms.push({ candidates: [`d:${folded}`, `lp:${capPrefix(folded)}`] })
      continue
    }
    for (const w of splitWords(piece)) terms.push(wordTerm(w))
  }

  const seen = new Set<string>()
  const unique: SearchTerm[] = []
  for (const t of terms) {
    const key = [...t.candidates].sort().join('|')
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(t)
  }
  return unique.slice(0, MAX_QUERY_TERMS)
}

/** Per-tenant search key: HKDF over the tenant data key with its own purpose label. */
export function deriveSearchKey(tenantDekBase64: string): Buffer {
  const ikm = Buffer.from(tenantDekBase64, 'base64')
  return Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), Buffer.from(SEARCH_KEY_INFO, 'utf8'), 32))
}

export function hashSearchToken(key: Buffer, token: string): string {
  return crypto.createHmac('sha256', key).update(token, 'utf8').digest('hex')
}

/** Hash each term's candidates: one array of hashes per AND-ed term. */
export function hashSearchTerms(key: Buffer, terms: SearchTerm[]): string[][] {
  return terms.map((t) => Array.from(new Set(t.candidates.map((c) => hashSearchToken(key, c)))))
}
