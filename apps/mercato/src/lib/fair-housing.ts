/*
 * Fair Housing copy screen (heuristic, NOT legal advice).
 *
 * Ported from the hub's listing-copy guard (noli-platform
 * apps/hub/src/lib/cos/guards/fair-housing.ts) so CRM-side drafts that reach a
 * realtor's clients get the same screen. Mail must not steer or imply a
 * preference based on a protected class (race, color, religion, sex,
 * disability, familial status, national origin, plus CA additions such as
 * source of income).
 *
 * Tuned for personal notes, where false positives cost a draft the owner
 * wanted, so these hub rules are narrowed (2026-09-25 review, M9, adds the
 * last three):
 *  - "must be able to" (ordinary English in a note) is dropped; "able-bodied"
 *    stays.
 *  - bare "gender" ("congrats on the gender reveal") is dropped; "male/female
 *    only/preferred" and "gender preferred/required" stay.
 *  - religious words that equal the recipient's own name ("Hi Christian")
 *    are ignored via `ignoreNames`.
 *  - "bachelor's degree" / "Bachelor of Science" are education, not status.
 *  - "quiet neighborhood" describes noise, not who lives there.
 *  - a religious word in an organisation's name ("Catholic Charities").
 * And it catches what it used to miss: "55+ community", "kid-free", "No
 * Section-8", and look-alike spellings ("N0 kids", Cyrillic letters), since
 * the rules read a normalised copy of the text (normalizeForScreening).
 * GTM public replies keep their own stricter screen (gtm/lib/post-replies.ts).
 *
 * Pure and dependency-free: safe for routes and worker bundles alike.
 */

type Rule = { pattern: RegExp; reason: string; suggestion?: string }

// Organisations whose names carry a religious word ("Catholic Charities",
// "Jewish Family Service") are not a religious reference to a home or area.
const RELIGIOUS_ORG = String.raw`(?!\s+(?:charities|charity|university|college|hospital|medical|health|relief|social\s+services?|community\s+services?|family\s+services?|federation|foundation))`

const RULES: Rule[] = [
  { pattern: /\bno\s+(kids|children|child)\b/i, reason: 'Familial status: excludes children.', suggestion: 'Describe the space, not who may live there.' },
  { pattern: /\b(kid|kids|child|children)[-\s]?free\b/i, reason: 'Familial status: excludes children.', suggestion: 'Describe the space, not who may live there.' },
  { pattern: /\b(perfect|ideal|great)\s+for\s+(a\s+)?(family|families|couples?|singles?|professionals?)\b/i, reason: 'Steers by familial/marital status.', suggestion: 'Describe features (e.g. "spacious layout") not the ideal occupant.' },
  { pattern: /\b(adults?\s+only|mature\s+(person|couple|adults?))\b/i, reason: 'Familial status / age limitation.' },
  // Housing for older persons is lawful only with a verified exemption; the
  // claim is always worth a human look.
  { pattern: /(?:\b(?:55|62)\s*\+|\b(?:55|62)\s+(?:and|&)\s+(?:over|older|up)\b|\bseniors?\s+only\b|\bage[-\s]restricted\b)/i, reason: 'Age/familial status: an older-persons housing claim needs a verified exemption.' },
  // "bachelor's degree" / "Bachelor of Science" are education, not marital status.
  { pattern: /\bbachelor(?:s|['\u2019]s)?\b(?!(?:s|['\u2019]s?)?\s*(?:degree|of\s+(?:arts|science|fine|business|laws?|education|nursing|engineering|music|applied)))/i, reason: 'Implies preference by marital/familial status.' },
  { pattern: /\bempty\s*nesters?\b/i, reason: 'Implies preference by marital/familial status.' },
  { pattern: /\b(walking\s+distance|close|near|next)\s+to\s+(a\s+|the\s+)?(church|synagogue|mosque|temple)\b/i, reason: 'Religious steering.', suggestion: 'Reference distance to generic amenities, not places of worship.' },
  { pattern: new RegExp(String.raw`\b(christian|catholic|jewish|muslim|hindu)\b` + RELIGIOUS_ORG, 'i'), reason: 'Religious reference.' },
  // "quiet" describes noise, not people: HUD treats it as a factual feature.
  { pattern: /\b(safe|exclusive|integrated|traditional)\s+(neighborhood|neighbourhood|community|area)\b/i, reason: '"Safe/exclusive/integrated" can imply racial/economic steering.', suggestion: 'State verifiable facts, not subjective neighborhood character.' },
  { pattern: /\bno\s+(section[-\s]*8|sec\.?\s*8|vouchers?|housing\s+(assistance|choice)|hud)\b/i, reason: 'Source-of-income (protected in CA).' },
  { pattern: /\b(handicap|crippled)\b/i, reason: 'Disability: outdated/derogatory term.', suggestion: 'Use "accessible" and describe accessibility features factually.' },
  { pattern: /\bable[-\s]?bodied\b/i, reason: 'Disability limitation.' },
  { pattern: /\b(english[-\s]speaking|americans?\s+only|no\s+foreigners?)\b/i, reason: 'National-origin discrimination.' },
  { pattern: /\b(male|female)\s+(only|preferred)\b|\bgender\s+(preferred|required|only)\b/i, reason: 'Sex discrimination.' },
  { pattern: /\bnear\s+(a\s+)?(country\s+club|private\s+club)\b/i, reason: 'Can imply exclusionary steering.' },
]

// Look-alike letters (Cyrillic, Greek) and full-width forms map to Latin so a
// homoglyph cannot slip a term past the screen.
const HOMOGLYPHS: Record<string, string> = {
  '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c', '\u0443': 'y', '\u0445': 'x',
  '\u0456': 'i', '\u0458': 'j', '\u04bb': 'h', '\u0501': 'd', '\u051b': 'q', '\u051d': 'w',
  '\u0410': 'A', '\u0412': 'B', '\u0415': 'E', '\u041a': 'K', '\u041c': 'M', '\u041d': 'H', '\u041e': 'O',
  '\u0420': 'P', '\u0421': 'C', '\u0422': 'T', '\u0425': 'X', '\u0406': 'I',
  '\u03bf': 'o', '\u03b1': 'a', '\u03b5': 'e', '\u03b9': 'i', '\u03ba': 'k', '\u03bd': 'v', '\u03c1': 'p',
  '\u03c4': 't', '\u03c5': 'u', '\u039f': 'O', '\u0391': 'A', '\u0395': 'E', '\u0399': 'I', '\u039a': 'K',
  '\u039c': 'M', '\u039d': 'N', '\u03a1': 'P', '\u03a4': 'T', '\u03a7': 'X',
}
// Digits used as letters inside a word ("N0 kids", "k1ds"). Only digits that
// sit next to a letter are mapped, so "Section 8" and "55+" keep their digits.
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' }

/**
 * The text the rules read: Unicode-normalised (NFKC), zero-width characters
 * removed, look-alike letters mapped to Latin and letter-adjacent digits read
 * as letters. Exported for the GTM public-reply screen.
 */
export function normalizeForScreening(text: string): string {
  let out = String(text ?? '').normalize('NFKC').replace(/[\u200b-\u200d\u2060\ufeff\u00ad]/g, '')
  out = out.replace(/[\u0370-\u03ff\u0400-\u052f]/g, (ch) => HOMOGLYPHS[ch] ?? ch)
  out = out.replace(/[0-9@$]+/g, (run, offset: number, whole: string) => {
    const before = whole[offset - 1] ?? ''
    const after = whole[offset + run.length] ?? ''
    if (!/[a-z]/i.test(before) && !/[a-z]/i.test(after)) return run
    return run.replace(/[0-9@$]/g, (ch) => LEET[ch] ?? ch)
  })
  return out
}

export type FairHousingFinding = { term: string; reason: string; suggestion?: string }
export type FairHousingResult = { ok: boolean; findings: FairHousingFinding[] }

/** Words of the recipient's name, lowercased, for the name exemption. */
function nameWords(names: Array<string | null | undefined>): Set<string> {
  const out = new Set<string>()
  for (const name of names) {
    for (const word of String(name ?? '').toLowerCase().split(/[^a-z]+/)) if (word) out.add(word)
  }
  return out
}

export function lintFairHousing(
  text: string,
  options: { ignoreNames?: Array<string | null | undefined> } = {},
): FairHousingResult {
  const ignore = nameWords(options.ignoreNames ?? [])
  const findings: FairHousingFinding[] = []
  const screened = normalizeForScreening(text)
  for (const rule of RULES) {
    const global = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`)
    for (const m of screened.matchAll(global)) {
      if (ignore.has(m[0].toLowerCase())) continue
      findings.push({ term: m[0], reason: rule.reason, suggestion: rule.suggestion })
      break
    }
  }
  return { ok: findings.length === 0, findings }
}

/** One line for the owner: what was flagged and why. Null when clean. */
export function fairHousingAdvisory(findings: FairHousingFinding[]): string | null {
  if (!findings.length) return null
  return (
    'Fair Housing review needed: ' +
    findings.map((f) => `"${f.term}" (${f.reason})`).join('; ') +
    '. This is an automated flag, not legal advice.'
  )
}
