/**
 * Guard against invented social proof in AI landing-page copy.
 *
 * The model likes to add numbers nobody gave it ("Join 500+ testers",
 * "Cut 15 hours a week", "98% of clients"). On a customer's public page
 * those are false claims made in their name. Two layers:
 *  1. NO_INVENTED_CLAIMS_RULE goes into every copy prompt.
 *  2. guardGeneratedSections() runs after generation and removes numeric
 *     proof claims whose number does not appear anywhere in what the user
 *     typed, then reports what it removed so the UI can say so.
 */
import type { GeneratedSection } from './types'

export const NO_INVENTED_CLAIMS_RULE = `- NEVER invent numbers, statistics, results, ratings, customer counts, time or money savings, or testimonials. Only use a number or a result if the user wrote it in the details above. If they gave none, describe the benefit in words ("spend your evenings on clients, not paperwork") instead of a made-up figure ("save 15 hours a week"). No "Join 500+ ...", no "98% of clients ...", no "3x more ..." unless those exact figures were supplied.`

export interface ClaimFlag {
  /** Where the claim was, e.g. "sections[0].subtitle". */
  path: string
  /** The matched claim text, e.g. "500+ testers". */
  claim: string
  action: 'removed-sentence' | 'removed-item' | 'removed-variant' | 'removed-phrase' | 'cleared-testimonials'
}

const AUDIENCE_NOUNS = [
  'customers', 'clients', 'users', 'members', 'students', 'testers', 'subscribers', 'people', 'businesses',
  'companies', 'teams', 'agents', 'founders', 'professionals', 'readers', 'downloads', 'reviews', 'brokers',
  'realtors', 'homeowners', 'families', 'creators', 'marketers', 'developers', 'owners', 'sellers', 'buyers',
  'coaches', 'consultants', 'freelancers', 'entrepreneurs', 'signups', 'sign-ups', 'attendees', 'patients',
  'investors', 'brands', 'agencies', 'shops', 'stores', 'leaders', 'managers', 'parents', 'listeners', 'fans',
]

const NUM = String.raw`\d[\d,]*(?:\.\d+)?`

/** Each pattern's first capture group is the number. */
const CLAIM_PATTERNS: RegExp[] = [
  // "500+ testers", "10,000 happy customers", "2k members"
  new RegExp(String.raw`(${NUM})\s*(?:k|K)?\s*\+?\s*(?:(?:happy|satisfied|active|beta|early|paying|real|busy|top|local|other|fellow)\s+){0,2}(?:${AUDIENCE_NOUNS.join('|')})\b`, 'gi'),
  // "join 500", "trusted by 1,200", "over 300"
  new RegExp(String.raw`\b(?:join(?:ed)?|trusted by|used by|loved by|chosen by|over|more than|nearly|almost)\s+(${NUM})\s*(?:k|K)?\+?`, 'gi'),
  // "98%", "40 percent"
  new RegExp(String.raw`(${NUM})\s*(?:%|percent\b)`, 'gi'),
  // "3x", "10X more"
  new RegExp(String.raw`\b(${NUM})\s*[xX]\b`, 'g'),
  // "save 15 hours", "cut 10+ hours a week", "get back 5 days"
  new RegExp(String.raw`\b(?:save[sd]?|saving|cut(?:s|ting)?|reclaim(?:s|ed)?|free(?:s|d)? up|get back|win back|reduc(?:e|es|ed|ing)|slash(?:es|ed)?)\b[^.!?\n]{0,30}?(${NUM})\s*\+?\s*(?:hours?|hrs?|minutes?|mins?|days?|weeks?|months?)\b`, 'gi'),
  // "$50k in revenue", "$1,200 more"
  new RegExp(String.raw`\$\s?(${NUM})\s*(?:k|m|million|thousand)?\+?\s+(?:in\s+)?(?:revenue|sales|saved|savings|profit|profits|commissions?|more|extra|additional|per month in)\b`, 'gi'),
  // "4.9 stars", "4.8/5", "5-star"
  new RegExp(String.raw`\b(\d(?:\.\d)?)\s*(?:\/\s*5\b|stars?\b|-star\b|out of 5\b)`, 'gi'),
  // "#1 rated"
  new RegExp(String.raw`#\s?(\d+)\b`, 'g'),
]

/** Figures that are plain wording, not a claim. */
const ALLOWED_PHRASES = /\b100\s*%\s*(?:free|secure|online|remote|private|yours|money[- ]back|risk[- ]free|refund|confidential|of your money)/i

function normalizeNumber(raw: string): string {
  const cleaned = raw.replace(/,/g, '').replace(/\.$/, '')
  const n = Number(cleaned)
  return Number.isFinite(n) ? String(n) : cleaned
}

/** Every number that appears in the user's own inputs. */
export function collectSourceNumbers(sources: unknown): Set<string> {
  const numbers = new Set<string>()
  const visit = (value: unknown) => {
    if (value == null) return
    if (typeof value === 'string' || typeof value === 'number') {
      const matches = String(value).match(/\d[\d,]*(?:\.\d+)?/g) || []
      for (const m of matches) numbers.add(normalizeNumber(m))
      return
    }
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (typeof value === 'object') Object.values(value as Record<string, unknown>).forEach(visit)
  }
  visit(sources)
  return numbers
}

/** Numeric proof claims in `text` whose number the user never supplied. */
export function findUnsourcedClaims(text: string, sourceNumbers: Set<string>): string[] {
  if (!text || !/\d/.test(text)) return []
  const claims: string[] = []
  for (const pattern of CLAIM_PATTERNS) {
    pattern.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = pattern.exec(text)) !== null) {
      const phrase = m[0]
      if (ALLOWED_PHRASES.test(text.slice(m.index, m.index + phrase.length + 20))) continue
      if (!sourceNumbers.has(normalizeNumber(m[1]))) claims.push(phrase.trim())
    }
  }
  return Array.from(new Set(claims))
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((s) => s.length > 0)
}

function tidy(text: string): string {
  return text
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/^[\s,;:.-]+/, '')
    .replace(/[\s,;:-]+$/, '')
    .trim()
}

/**
 * Remove unsourced claims from one string. Drops whole sentences when the
 * text has several; otherwise cuts the claim phrase out.
 */
function cleanString(text: string, sources: Set<string>, path: string, flags: ClaimFlag[]): string {
  const found = findUnsourcedClaims(text, sources)
  if (found.length === 0) return text
  const sentences = splitSentences(text)
  if (sentences.length > 1) {
    const kept = sentences.filter((s) => {
      const claims = findUnsourcedClaims(s, sources)
      for (const claim of claims) flags.push({ path, claim, action: 'removed-sentence' })
      return claims.length === 0
    })
    if (kept.length > 0) return kept.join(' ')
  }
  let out = text
  for (const claim of found) {
    flags.push({ path, claim, action: 'removed-phrase' })
    out = out.split(claim).join('')
  }
  return tidy(out)
}

const VARIANT_KEYS: Record<string, { selected: 'selectedHeadline' | 'selectedCta'; main: 'headline' | 'ctaText' }> = {
  headlineVariants: { selected: 'selectedHeadline', main: 'headline' },
  ctaVariants: { selected: 'selectedCta', main: 'ctaText' },
}

function cleanValue(value: unknown, sources: Set<string>, path: string, flags: ClaimFlag[]): unknown {
  if (typeof value === 'string') return cleanString(value, sources, path, flags)
  if (Array.isArray(value)) {
    const out: unknown[] = []
    value.forEach((item, i) => {
      const itemPath = `${path}[${i}]`
      // A list item whose title is a claim goes entirely; otherwise clean it.
      if (typeof item === 'string') {
        const claims = findUnsourcedClaims(item, sources)
        if (claims.length > 0) { claims.forEach((claim) => flags.push({ path: itemPath, claim, action: 'removed-item' })); return }
        out.push(item)
        return
      }
      if (item && typeof item === 'object') {
        const title = (item as Record<string, unknown>).title ?? (item as Record<string, unknown>).name
        const titleClaims = typeof title === 'string' ? findUnsourcedClaims(title, sources) : []
        if (titleClaims.length > 0) { titleClaims.forEach((claim) => flags.push({ path: itemPath, claim, action: 'removed-item' })); return }
      }
      out.push(cleanValue(item, sources, itemPath, flags))
    })
    return out
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = cleanValue(v, sources, `${path}.${k}`, flags)
    return out
  }
  return value
}

/** Section fields that carry prices the value-stack is asked to compute; not social proof. */
const PRICE_FIELDS = new Set(['price', 'priceNote', 'paymentPlan', 'totalValue'])

function guardSection(section: GeneratedSection, sources: Set<string>, path: string, flags: ClaimFlag[]): GeneratedSection {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(section as unknown as Record<string, unknown>)) {
    if (key === 'type' || PRICE_FIELDS.has(key) || key === 'valueItems' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value
      continue
    }
    const variant = VARIANT_KEYS[key]
    if (variant && Array.isArray(value)) {
      const kept = value.filter((v, i) => {
        const claims = typeof v === 'string' ? findUnsourcedClaims(v, sources) : []
        claims.forEach((claim) => flags.push({ path: `${path}.${key}[${i}]`, claim, action: 'removed-variant' }))
        return claims.length === 0
      })
      out[key] = kept
      continue
    }
    out[key] = cleanValue(value, sources, `${path}.${key}`, flags)
  }

  // Variant lists may have shrunk: point the selection at a clean variant,
  // preferring one over a headline that had to be cut apart.
  for (const [listKey, { selected, main }] of Object.entries(VARIANT_KEYS)) {
    const list = out[listKey]
    if (!Array.isArray(list)) continue
    const originalMain = (section as unknown as Record<string, unknown>)[main]
    const mainHadClaim = typeof originalMain === 'string' && findUnsourcedClaims(originalMain, sources).length > 0
    if (mainHadClaim && list.length > 0) out[main] = list[0]
    const mainNow = out[main]
    const idx = list.indexOf(mainNow)
    if (idx >= 0) out[selected] = idx
    else delete out[selected]
  }
  return out as unknown as GeneratedSection
}

export interface GuardInputs {
  /** Everything the user typed: business context, offer answers, instructions. */
  sources: unknown
  /** True when the user supplied testimonials / results / credentials. */
  hasSocialProof: boolean
}

/**
 * Remove invented numeric claims (and, with no social proof supplied, any
 * testimonials) from generated sections. Returns the cleaned sections plus
 * what was removed.
 */
export function guardGeneratedSections(sections: GeneratedSection[], inputs: GuardInputs): { sections: GeneratedSection[]; flags: ClaimFlag[] } {
  const sources = collectSourceNumbers(inputs.sources)
  const flags: ClaimFlag[] = []
  const cleaned = (sections || []).map((section, i) => {
    if (!section || typeof section !== 'object') return section
    let s = guardSection(section, sources, `sections[${i}]`, flags)
    if (s.type === 'testimonials' && !inputs.hasSocialProof && Array.isArray(s.items) && s.items.length > 0) {
      flags.push({ path: `sections[${i}].items`, claim: `${s.items.length} testimonial(s)`, action: 'cleared-testimonials' })
      s = { ...s, items: [] }
    }
    return s
  })
  return { sections: cleaned, flags }
}

/** Offer answers that count as the user supplying proof. */
export function hasSocialProofInput(offerAnswers: Record<string, string> | undefined | null): boolean {
  if (!offerAnswers) return false
  return ['socialProof', 'credentials', 'results', 'testimonials'].some((k) => typeof offerAnswers[k] === 'string' && offerAnswers[k].trim().length > 0)
}

/** Plain-English note for the UI, or null when nothing was removed. */
export function describeRemovedClaims(flags: ClaimFlag[]): string | null {
  if (flags.length === 0) return null
  const n = flags.length
  return `We removed ${n} ${n === 1 ? 'claim' : 'claims'} (numbers, results or testimonials) that you didn't give us, so the page doesn't promise anything you can't back up. Add real figures in your answers if you have them.`
}
