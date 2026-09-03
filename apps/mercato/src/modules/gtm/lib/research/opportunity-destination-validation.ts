import { load } from 'cheerio'
import { safeFetch, SsrfError } from '../../../../lib/safe-fetch'
import type { Candidate, CandidateEvidence, CandidateIdentity } from '../adapters/types'
import {
  canonicalOpportunityUrl,
  demonstratedOpportunityLocation,
  inactiveDestinationText,
  resolveOpportunityEventStart,
  sensitiveConsumerOpportunityReasons,
} from './opportunity-quality'
import {
  OPPORTUNITY_DESTINATION_VALIDATION_MAX_BODY_BYTES,
  OPPORTUNITY_DESTINATION_VALIDATION_MAX_REDIRECTS,
  OPPORTUNITY_DESTINATION_VALIDATION_TIMEOUT_MS,
  OPPORTUNITY_DESTINATION_VALIDATION_VERSION,
} from './opportunity-destination-contract'

const MAX_RETAINED_EXCERPT_CHARS = 600
const SOCIAL_HOSTS = new Set([
  'facebook.com',
  'instagram.com',
  'linkedin.com',
  'reddit.com',
  'threads.com',
  'threads.net',
  'tiktok.com',
  'twitter.com',
  'x.com',
  'youtube.com',
])
// A sentence earns participation_rules_status 'observed' only when it
// describes who may take part or under which terms. Any mention of
// "register" or "join" on a page is not a rule; treating it as one let the
// actionability gate pass on marketing copy.
const PARTICIPATION_RULES =
  /\b(?:allow(?:ed|s|ing)?|permit(?:ted|s)?|open to|only|must|may (?:not )?(?:attend|join|participate|register|post|comment)|prohibit\w*|forbid\w*|not allowed|cannot|can't|welcome[sd]?|members? only|require[sd]?|restricted to|by invitation|invitation only|no (?:agents?|realtors?|brokers?|lenders?|solicit\w*|promot\w*|advertis\w*))\b/i
const PARTICIPATION_RESTRICTION =
  /\b(?:not allow(?:ed|ing)?|may not|must not|cannot|can't|prohibit(?:ed|s)?|forbid(?:den|s)?)\b.{0,100}\b(?:agents?|realtors?|brokers?|lenders?|industry professionals?|attend|participat|register|join)\w*\b|\b(?:agents?|realtors?|brokers?|lenders?|industry professionals?)\b.{0,100}\b(?:not allow(?:ed|ing)?|may not|must not|cannot|can't|prohibit(?:ed|s)?|forbid(?:den|s)?|attend|participat|register|join)\w*\b/i
const RELEVANT_PAGE_TEXT =
  /\b(?:attend|buyer|buying|calendar|community|event|home|homeowner|house|housing|join|market|meeting|meetings|membership|neighbou?rhood|participat|public|register|registration|resident|rules?|seller|selling|workshop)\b/i
// A page that answers 200 with a sign-in prompt is not a public destination.
const LOGIN_WALL =
  /\b(?:log ?in|sign ?in|sign up|create an account|join to see|members only|you must be logged in|login required|please log in|access denied)\b.{0,80}\b(?:to (?:see|view|read|continue|access|join)|required|this (?:post|page|content|group|discussion))\b|\b(?:log ?in|sign ?in) (?:to|or) (?:see|view|continue|join|sign up)\b/i
// Final URLs that are a site root, a search or listing index, or an auth page
// are not the requested destination even when they answer 200.
const NON_DESTINATION_PATH =
  /^\/(?:login|signin|sign-in|signup|sign-up|auth|account|accounts|search|events?|listings?|explore|discover|home|index(?:\.html?)?)?\/?$/i
const STREET_ADDRESS =
  /\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s){0,4}(?:st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|way|pkwy|parkway|hwy|highway|ct|court|pl|place|cir|circle|trl|trail)\b\.?/i
const US_ZIP = /\b\d{5}(?:-\d{4})?\b/
const US_STATE_WORD =
  '(?:A[LKZR]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY]|Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming)'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/*
 * Page-harvested geography must look like a venue or address, not a passing
 * mention. "Serving Austin, Dallas, Houston" on a national brokerage page is
 * not proof that a destination is in Austin; "in Austin, Texas", a street
 * address, or a zip code is.
 */
function venueLikeLocationSentence(sentence: string, requestedLocation: string): boolean {
  const primary = requestedLocation.split(',')[0]?.trim()
  if (!primary) return false
  const city = escapeRegExp(primary)
  const inCityState = new RegExp(`\\b(?:in|at|near|located in|held in)\\s+${city},?\\s+${US_STATE_WORD}\\b`, 'i')
  const cityStateZip = new RegExp(`\\b${city},?\\s+${US_STATE_WORD}\\.?,?\\s+\\d{5}\\b`, 'i')
  return inCityState.test(sentence)
    || cityStateZip.test(sentence)
    || (STREET_ADDRESS.test(sentence) && new RegExp(`\\b${city}\\b`, 'i').test(sentence))
    || (US_ZIP.test(sentence) && new RegExp(`\\b${city}\\b`, 'i').test(sentence))
}

function materiallyDifferentDestination(requested: URL, final: URL): boolean {
  const host = (url: URL) => url.hostname.toLowerCase().replace(/^www\./, '')
  const path = (url: URL) => url.pathname.replace(/\/+$/, '') || '/'
  if (host(requested) !== host(final)) return true
  const requestedPath = path(requested)
  const finalPath = path(final)
  if (requestedPath === finalPath) return false
  // Collapsed to the site root, or landed on a login/search/listing index.
  return finalPath === '/' || NON_DESTINATION_PATH.test(finalPath)
}

export type OpportunityDestinationValidationResult = {
  candidate: Candidate
  outcome: 'verified' | 'unavailable' | 'blocked' | 'unknown' | 'skipped_social'
}

export type OpportunityDestinationFetch = (
  url: string,
  init?: RequestInit,
  maxRedirects?: number,
) => Promise<Response>

function boundedText(value: string, max = MAX_RETAINED_EXCERPT_CHARS): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (compact.length <= max) return compact
  return `${compact.slice(0, max - 1).replace(/\s+\S*$/, '').trim()}…`
}

function socialDestination(url: URL): boolean {
  const hostname = url.hostname.toLowerCase().replace(/^www\./, '')
  return [...SOCIAL_HOSTS].some((host) => hostname === host || hostname.endsWith(`.${host}`))
}

async function boundedResponseText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > OPPORTUNITY_DESTINATION_VALIDATION_MAX_BODY_BYTES) {
    throw new RangeError('destination body exceeds the bounded validation ceiling')
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > OPPORTUNITY_DESTINATION_VALIDATION_MAX_BODY_BYTES) {
        await reader.cancel()
        throw new RangeError('destination body exceeds the bounded validation ceiling')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function pageEvidence(html: string, requestedLocation: string | null): {
  excerpt: string
  eventText: string
  location: string | null
  participation: string | null
  sensitive: boolean
  inactive: boolean
  loginWall: boolean
  title: string | null
} {
  const $ = load(html)
  $('script, style, noscript, svg, iframe, form, nav, footer').remove()
  const title = boundedText(
    $('meta[property="og:title"]').attr('content')
      ?? $('title').first().text()
      ?? $('h1').first().text(),
    180,
  ) || null
  const description = boundedText(
    $('meta[name="description"]').attr('content')
      ?? $('meta[property="og:description"]').attr('content')
      ?? '',
    300,
  )
  const main = boundedText(($('main').first().text() || $('article').first().text() || $('body').text()), 8_000)
  const sentences = `${description} ${main}`
    .split(/(?<=[.!?])\s+|\s*[|•·]\s*/)
    .map((value) => boundedText(value, 280))
    .filter((value) => value.length >= 12)
  const location = requestedLocation
    ? sentences.find((value) =>
        demonstratedOpportunityLocation(value, requestedLocation)
        && venueLikeLocationSentence(value, requestedLocation),
      ) ?? null
    : null
  const participation = sentences.find((value) => PARTICIPATION_RESTRICTION.test(value))
    ?? sentences.find((value) => PARTICIPATION_RULES.test(value))
    ?? null
  const relevant = sentences.filter((value) => RELEVANT_PAGE_TEXT.test(value))
  const selected = [location, participation, ...relevant]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 7)
  return {
    title,
    excerpt: boundedText([title, ...selected].filter(Boolean).join('. ')),
    eventText: `${description} ${main}`,
    location,
    participation: participation ? boundedText(participation, 360) : null,
    // Scan the bounded page body before selecting an excerpt. A sensitive
    // sentence may occur after the first visually relevant paragraph and must
    // still fail closed without being retained in the candidate record.
    sensitive: sensitiveConsumerOpportunityReasons(`${title ?? ''} ${description} ${main}`).length > 0,
    // Both scans run over the full bounded body, not the retained excerpt:
    // "This event has ended" or "Log in to see this post" rarely survives the
    // excerpt selection, which is exactly why a 2xx used to verify them.
    inactive: inactiveDestinationText(`${title ?? ''} ${description} ${main}`),
    loginWall: LOGIN_WALL.test(`${title ?? ''} ${description} ${main}`),
  }
}

function withValidation(
  candidate: Candidate,
  identityPatch: Partial<CandidateIdentity>,
  evidence?: CandidateEvidence,
): Candidate {
  return {
    ...candidate,
    identity: { ...candidate.identity, ...identityPatch },
    evidence: evidence ? [...candidate.evidence, evidence] : candidate.evidence,
  }
}

export async function validateOpportunityDestination(
  candidate: Candidate,
  options: {
    now?: () => Date
    fetchImpl?: OpportunityDestinationFetch
    timeoutMs?: number
  } = {},
): Promise<OpportunityDestinationValidationResult> {
  if (candidate.entity_kind !== 'opportunity') return { candidate, outcome: 'unknown' }
  const canonical = canonicalOpportunityUrl(candidate.identity.urls ?? [])
  if (!canonical) {
    return {
      candidate: withValidation(candidate, { destination_validation_status: 'blocked' }),
      outcome: 'blocked',
    }
  }
  const url = new URL(canonical)
  if (socialDestination(url)) return { candidate, outcome: 'skipped_social' }

  const now = options.now ?? (() => new Date())
  const observedAt = now().toISOString()
  let response: Response
  try {
    response = await (options.fetchImpl ?? safeFetch)(canonical, {
      method: 'GET',
      headers: {
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.8',
        'User-Agent': 'NoliDestinationValidator/1.0 (+https://noliai.com/terms)',
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? OPPORTUNITY_DESTINATION_VALIDATION_TIMEOUT_MS),
    }, OPPORTUNITY_DESTINATION_VALIDATION_MAX_REDIRECTS)
  } catch (error) {
    const blocked = error instanceof SsrfError
    return {
      candidate: withValidation(candidate, {
        access_type: 'unknown',
        destination_validation_status: blocked ? 'blocked' : 'unknown',
        destination_validated_at: observedAt,
      }),
      outcome: blocked ? 'blocked' : 'unknown',
    }
  }

  if (response.status === 404 || response.status === 410) {
    return {
      candidate: withValidation(candidate, {
        access_type: 'unknown',
        destination_validation_status: 'unavailable',
        destination_validated_at: observedAt,
        destination_http_status: response.status,
      }),
      outcome: 'unavailable',
    }
  }
  if (response.status === 401 || response.status === 403) {
    return {
      candidate: withValidation(candidate, {
        access_type: 'approval_required',
        destination_validation_status: 'unknown',
        destination_validated_at: observedAt,
        destination_http_status: response.status,
      }),
      outcome: 'unknown',
    }
  }
  if (!response.ok) {
    return {
      candidate: withValidation(candidate, {
        access_type: 'unknown',
        destination_validation_status: 'unknown',
        destination_validated_at: observedAt,
        destination_http_status: response.status,
      }),
      outcome: 'unknown',
    }
  }

  // A redirect that lands on a different host, the site root, or a
  // login/search/listing index means the requested destination is gone. The
  // requested canonical stays the identity; the final hop is evidence only.
  const finalUrl = canonicalOpportunityUrl([response.url, canonical]) ?? canonical
  let redirectedAway = false
  try {
    redirectedAway = materiallyDifferentDestination(url, new URL(finalUrl))
  } catch {
    redirectedAway = false
  }
  if (redirectedAway) {
    return {
      candidate: withValidation(candidate, {
        access_type: 'unknown',
        destination_validation_status: 'unavailable',
        destination_validated_at: observedAt,
        destination_http_status: response.status,
      }, {
        claim: 'Noli found that the returned public destination redirects away from the requested page.',
        source_url: canonical,
        observed_at: observedAt,
        confidence: 0.72,
        detail: {
          validator: OPPORTUNITY_DESTINATION_VALIDATION_VERSION,
          http_status: response.status,
          destination_final_url: finalUrl,
          redirect_outcome: 'materially_different_destination',
        },
      }),
      outcome: 'unavailable',
    }
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  const requestedLocation = candidate.identity.provider_location ?? null
  let page = {
    excerpt: '',
    eventText: '',
    location: null as string | null,
    participation: null as string | null,
    sensitive: false,
    inactive: false,
    loginWall: false,
    title: null as string | null,
  }
  try {
    if (contentType.includes('html') || contentType.includes('text/plain') || contentType === '') {
      page = pageEvidence(await boundedResponseText(response), requestedLocation)
    }
  } catch {
    return {
      candidate: withValidation(candidate, {
        access_type: 'unknown',
        destination_validation_status: 'unknown',
        destination_validated_at: observedAt,
        destination_http_status: response.status,
      }),
      outcome: 'unknown',
    }
  }

  if (page.sensitive) {
    return {
      candidate: withValidation(candidate, {
        access_type: 'unknown',
        destination_validation_status: 'blocked',
        destination_validated_at: observedAt,
        destination_http_status: response.status,
      }),
      outcome: 'blocked',
    }
  }
  if (page.inactive) {
    // Soft-404 / ended-event pages answer 200. The body says otherwise.
    return {
      candidate: withValidation(candidate, {
        access_type: 'unknown',
        destination_validation_status: 'unavailable',
        destination_validated_at: observedAt,
        destination_http_status: response.status,
      }, {
        claim: 'Noli found that the returned public destination reports it is no longer available.',
        source_url: canonical,
        observed_at: observedAt,
        confidence: 0.72,
        detail: {
          validator: OPPORTUNITY_DESTINATION_VALIDATION_VERSION,
          http_status: response.status,
          destination_final_url: finalUrl,
          page_title: page.title,
          inactive_destination: true,
        },
      }),
      outcome: 'unavailable',
    }
  }
  if (page.loginWall) {
    // "Log in to see this post" is an approval wall, never a verified public
    // destination; the qualifier routes approval_required to a hard fail.
    return {
      candidate: withValidation(candidate, {
        access_type: 'approval_required',
        destination_validation_status: 'unknown',
        destination_validated_at: observedAt,
        destination_http_status: response.status,
      }, {
        claim: 'Noli found that the returned destination requires a sign-in before its content is visible.',
        source_url: canonical,
        observed_at: observedAt,
        confidence: 0.72,
        detail: {
          validator: OPPORTUNITY_DESTINATION_VALIDATION_VERSION,
          http_status: response.status,
          destination_final_url: finalUrl,
          page_title: page.title,
          login_wall: true,
        },
      }),
      outcome: 'unknown',
    }
  }

  // Only a venue/address-like sentence (selected in pageEvidence) may write
  // the requested market into identity.location.
  const demonstratedLocation = page.location && requestedLocation ? requestedLocation : null
  const currentDescription = candidate.identity.audience_description?.trim() ?? ''
  const description = boundedText(
    [currentDescription, page.excerpt && !currentDescription.includes(page.excerpt) ? page.excerpt : '']
      .filter(Boolean)
      .join(' '),
    1_200,
  )
  const eventStart = candidate.identity.opportunity_kind === 'event'
    ? resolveOpportunityEventStart(candidate.identity.event_start_at, page.eventText, new Date(observedAt))
    : null
  const evidence: CandidateEvidence = {
    claim: 'Noli verified that the returned public destination responded successfully and retained a bounded evidence excerpt.',
    source_url: canonical,
    observed_at: observedAt,
    confidence: page.excerpt ? 0.86 : 0.72,
    detail: {
      validator: OPPORTUNITY_DESTINATION_VALIDATION_VERSION,
      http_status: response.status,
      content_type: contentType || null,
      page_title: page.title,
      content_excerpt: page.excerpt || null,
      observed_participation_excerpt: page.participation,
      // The requested canonical remains the identity; a same-page redirect
      // target is recorded here instead of overwriting identity.urls, so
      // expired pages that bounce to one landing page cannot dedupe together.
      destination_final_url: finalUrl,
    },
  }
  return {
    candidate: withValidation(candidate, {
      access_type: candidate.identity.access_type === 'ticketed' ? 'ticketed' : 'public',
      destination_validation_status: 'verified_public',
      destination_validated_at: observedAt,
      destination_http_status: response.status,
      audience_description: description || candidate.identity.audience_description,
      location: candidate.identity.location ?? demonstratedLocation,
      participation_rules: page.participation ?? candidate.identity.participation_rules,
      participation_rules_status: page.participation ? 'observed' : candidate.identity.participation_rules_status,
      event_start_at: eventStart?.toISOString() ?? candidate.identity.event_start_at,
    }, evidence),
    outcome: 'verified',
  }
}
