/*
 * Group-ownership signals on a prospect's own website (Launch Pad shortlist
 * check, 2026-09-25). A member who asks for independent businesses must not
 * be handed chain or consolidator locations labelled "independent": the final
 * production run delivered four corporate-owned vet clinics as "Independent,
 * strong fit" on nothing but the Google Maps category.
 *
 * Two kinds of evidence, both quotable:
 *   - TEXT on the site: "Part of Lakefield Veterinary Group", "a member of the
 *     X family", "X family of hospitals", a copyright line naming a different
 *     group;
 *   - TEMPLATE signatures in the raw HTML: networks run every location on one
 *     web platform whose asset and class names carry the network's name
 *     (NVA sites repeat "nva-para", "nva-anchor", "/nva-desert-dog…jpg"). A
 *     signature counts only when it repeats (MIN_SIGNATURE_HITS), so one
 *     stray mention (a blog post about VCA, a referral to BluePearl ER) does
 *     not mark a clinic as owned.
 * The registry is deliberately short and per vertical; the AI check reads the
 * site too, and anything it asserts must quote the page (verify.ts).
 */

export type OwnershipHint = { kind: 'text' | 'template'; org: string; quote: string }

export const MIN_SIGNATURE_HITS = 5

type Signature = { org: string; pattern: RegExp }

/** Web-platform signatures of multi-location owners (raw, lower-cased HTML). */
export const TEMPLATE_SIGNATURES: Signature[] = [
  { org: 'National Veterinary Associates (NVA)', pattern: /\bnva-(?:para|anchor|list-item|heading|button|[a-z]+-(?:dog|cat))/g },
  { org: 'VCA Animal Hospitals', pattern: /\bvca(?:hospitals|antech|-hospital|_hospital)\b/g },
  { org: 'Banfield Pet Hospital', pattern: /\bbanfield(?:\.com|-pet|_pet)/g },
  { org: 'BluePearl', pattern: /\bbluepearlvet\.com/g },
  { org: 'Thrive Pet Healthcare', pattern: /\bthrivepetcare\.com|\bthrive-pet/g },
  { org: 'PetVet Care Centers', pattern: /\bpetvetcarecenters\.com|\bpetvet-/g },
  { org: 'Mission Pet Health', pattern: /\bmissionpethealth\.com/g },
  { org: 'Pathway Vet Alliance', pattern: /\bpathwayvets?\.com/g },
  { org: 'Southern Veterinary Partners', pattern: /\bsouthernvetpartners\.com/g },
  { org: 'Lakefield Veterinary Group', pattern: /\blakefieldvet(?:erinary)?group\.com|\blakefield-vet/g },
  { org: 'AmeriVet Partners', pattern: /\bamerivet\.com/g },
  { org: 'Heartland Dental', pattern: /\bheartland\.com\/|\bheartlanddental/g },
  { org: 'The Aspen Group (Aspen Dental, Lovet)', pattern: /\baspendental\.com|\blovetpet\.com/g },
  { org: 'Pacific Dental Services', pattern: /\bpacificdentalservices\.com/g },
]

const GROUP_WORD = '(?:Group|Partners|Associates|Alliance|Network|Family|Holdings|Health|Healthcare|Care Centers|Companies|Brands)'
const ORG = `([A-Z][\\w&'.-]*(?:\\s+(?:of\\s+|the\\s+|&\\s+)?[A-Z][\\w&'.-]*){0,5})`

const TEXT_PATTERNS: RegExp[] = [
  // Keywords in either case ("© 2026 Part of Lakefield Veterinary Group"),
  // the organisation itself capitalised.
  new RegExp(`\\b(?:[Aa]\\s+|[Pp]roud(?:ly)?\\s+)?(?:[Pp]art|[Mm]ember|[Aa]ffiliate|PART|MEMBER)\\s+(?:of|OF)\\s+(?:[Tt]he\\s+)?${ORG}`, 'g'),
  new RegExp(`\\b${ORG}\\s+family\\s+of\\s+(?:hospitals|practices|clinics|locations|companies|brands)\\b`, 'g'),
  new RegExp(`©\\s*(?:copyright\\s*)?(?:\\d{4}\\s*[-–]?\\s*)?(?:\\d{4}\\s*)?${ORG}`, 'gi'),
]

function tokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !['the', 'and', 'inc', 'llc', 'ltd', 'pllc'].includes(t))
}

/** Whether an organisation named on the site is someone other than the business itself. */
function otherThan(org: string, businessName: string): boolean {
  const own = new Set(tokens(businessName))
  const theirs = tokens(org)
  if (theirs.length === 0) return false
  return theirs.filter((t) => !own.has(t)).length > theirs.length / 2
}

/** Text-only hints: an organisation other than the business, named as its
 *  owner or network. Memberships of professional associations ("member of the
 *  American Animal Hospital Association") are not ownership and are skipped. */
export function textOwnershipHints(text: string, businessName: string): OwnershipHint[] {
  const out: OwnershipHint[] = []
  for (const pattern of TEXT_PATTERNS) {
    pattern.lastIndex = 0
    for (const m of text.matchAll(pattern)) {
      // End the organisation at its last group word ("Lakefield Veterinary
      // Group Manage Consent" is "Lakefield Veterinary Group").
      const captured = m[1]?.trim() ?? ''
      const cut = [...captured.matchAll(new RegExp(`\\b${GROUP_WORD}\\b`, 'g'))].pop()
      if (!cut) continue
      const org = captured.slice(0, (cut.index ?? 0) + cut[0].length).trim()
      if (/\b(Association|Society|Chamber|Board|Council|College|Academy|Institute|Bureau|Federation)\b/.test(org)) continue
      if (!otherThan(org, businessName)) continue
      const at = m.index ?? 0
      out.push({ kind: 'text', org, quote: text.slice(Math.max(0, at - 20), Math.min(text.length, at + m[0].length + 20)).trim() })
    }
  }
  return dedupe(out)
}

export function templateOwnershipHints(rawHtml: string): OwnershipHint[] {
  const out: OwnershipHint[] = []
  for (const sig of TEMPLATE_SIGNATURES) {
    sig.pattern.lastIndex = 0
    const hits = [...rawHtml.matchAll(sig.pattern)]
    if (hits.length >= MIN_SIGNATURE_HITS) {
      const sample = [...new Set(hits.map((h) => h[0]))].slice(0, 3).join(', ')
      out.push({ kind: 'template', org: sig.org, quote: `site built on ${sig.org}'s web platform (${hits.length} markers such as ${sample})` })
    }
  }
  return out
}

export function ownershipHints(site: { rawHtml: string; fullText?: string; pages: Array<{ text: string }> }, businessName: string): OwnershipHint[] {
  const text = site.fullText || site.pages.map((p) => p.text).join(' \n ')
  return dedupe([...templateOwnershipHints(site.rawHtml), ...textOwnershipHints(text, businessName)])
}

function dedupe(rows: OwnershipHint[]): OwnershipHint[] {
  const seen = new Set<string>()
  return rows.filter((row) => {
    const key = `${row.kind}:${row.org.toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
