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
 * wanted, so three hub rules are narrowed:
 *  - "must be able to" (ordinary English in a note) is dropped; "able-bodied"
 *    stays.
 *  - bare "gender" ("congrats on the gender reveal") is dropped; "male/female
 *    only/preferred" and "gender preferred/required" stay.
 *  - religious words that equal the recipient's own name ("Hi Christian")
 *    are ignored via `ignoreNames`.
 * GTM public replies keep their own stricter screen (gtm/lib/post-replies.ts).
 *
 * Pure and dependency-free: safe for routes and worker bundles alike.
 */

type Rule = { pattern: RegExp; reason: string; suggestion?: string }

const RULES: Rule[] = [
  { pattern: /\bno\s+(kids|children)\b/i, reason: 'Familial status: excludes children.', suggestion: 'Describe the space, not who may live there.' },
  { pattern: /\b(perfect|ideal|great)\s+for\s+(a\s+)?(family|families|couples?|singles?|professionals?)\b/i, reason: 'Steers by familial/marital status.', suggestion: 'Describe features (e.g. "spacious layout") not the ideal occupant.' },
  { pattern: /\b(adults?\s+only|mature\s+(person|couple|adults?))\b/i, reason: 'Familial status / age limitation.' },
  { pattern: /\b(bachelor|empty\s*nester)s?\b/i, reason: 'Implies preference by marital/familial status.' },
  { pattern: /\bwalking\s+distance\s+to\s+(church|synagogue|mosque|temple)\b/i, reason: 'Religious steering.', suggestion: 'Reference distance to generic amenities, not places of worship.' },
  { pattern: /\b(christian|catholic|jewish|muslim|hindu)\b/i, reason: 'Religious reference.' },
  { pattern: /\b(safe|quiet|exclusive|integrated|traditional)\s+(neighborhood|community|area)\b/i, reason: '"Safe/exclusive/integrated" can imply racial/economic steering.', suggestion: 'State verifiable facts, not subjective neighborhood character.' },
  { pattern: /\bno\s+(section\s*8|vouchers?|housing\s+assistance)\b/i, reason: 'Source-of-income (protected in CA).' },
  { pattern: /\b(handicap|crippled)\b/i, reason: 'Disability: outdated/derogatory term.', suggestion: 'Use "accessible" and describe accessibility features factually.' },
  { pattern: /\bable[-\s]?bodied\b/i, reason: 'Disability limitation.' },
  { pattern: /\b(english[-\s]speaking|americans?\s+only|no\s+foreigners?)\b/i, reason: 'National-origin discrimination.' },
  { pattern: /\b(male|female)\s+(only|preferred)\b|\bgender\s+(preferred|required|only)\b/i, reason: 'Sex discrimination.' },
  { pattern: /\bnear\s+(a\s+)?(country\s+club|private\s+club)\b/i, reason: 'Can imply exclusionary steering.' },
]

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
  for (const rule of RULES) {
    const global = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`)
    for (const m of String(text ?? '').matchAll(global)) {
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
