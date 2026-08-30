import { load } from 'cheerio'
import { safeFetch, SsrfError } from '../../../../lib/safe-fetch'
import type { Candidate, CandidateEvidence, CandidateIdentity } from '../adapters/types'
import {
  canonicalOpportunityUrl,
  demonstratedOpportunityLocation,
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
const PARTICIPATION_TERMS =
  /\b(?:attend(?:ance)?|join(?:ing)?|membership|meetings?|open to|participat\w*|register|registration|required|rules?|volunteer)\b/i
const RELEVANT_PAGE_TEXT =
  /\b(?:attend|buyer|buying|calendar|community|event|home|homeowner|house|housing|join|market|meeting|meetings|membership|neighbou?rhood|participat|public|register|registration|resident|rules?|seller|selling|workshop)\b/i

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

function pageEvidence(html: string): {
  excerpt: string
  participation: string | null
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
  const relevant = sentences.filter((value) => RELEVANT_PAGE_TEXT.test(value)).slice(0, 5)
  const participation = sentences.find((value) => PARTICIPATION_TERMS.test(value)) ?? null
  return {
    title,
    excerpt: boundedText([title, ...relevant].filter(Boolean).join('. ')),
    participation: participation ? boundedText(participation, 360) : null,
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

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  let page = { excerpt: '', participation: null as string | null, title: null as string | null }
  try {
    if (contentType.includes('html') || contentType.includes('text/plain') || contentType === '') {
      page = pageEvidence(await boundedResponseText(response))
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

  if (page.excerpt && sensitiveConsumerOpportunityReasons(page.excerpt).length > 0) {
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

  const requestedLocation = candidate.identity.provider_location ?? null
  const demonstratedLocation = page.excerpt && requestedLocation
    ? demonstratedOpportunityLocation(page.excerpt, requestedLocation)
    : null
  const currentDescription = candidate.identity.audience_description?.trim() ?? ''
  const description = boundedText(
    [currentDescription, page.excerpt && !currentDescription.includes(page.excerpt) ? page.excerpt : '']
      .filter(Boolean)
      .join(' '),
    1_200,
  )
  const finalUrl = canonicalOpportunityUrl([response.url, canonical]) ?? canonical
  const evidence: CandidateEvidence = {
    claim: 'Noli verified that the returned public destination responded successfully and retained a bounded evidence excerpt.',
    source_url: finalUrl,
    observed_at: observedAt,
    confidence: page.excerpt ? 0.86 : 0.72,
    detail: {
      validator: OPPORTUNITY_DESTINATION_VALIDATION_VERSION,
      http_status: response.status,
      content_type: contentType || null,
      page_title: page.title,
      content_excerpt: page.excerpt || null,
      observed_participation_excerpt: page.participation,
    },
  }
  return {
    candidate: withValidation(candidate, {
      urls: [finalUrl],
      access_type: candidate.identity.access_type === 'ticketed' ? 'ticketed' : 'public',
      destination_validation_status: 'verified_public',
      destination_validated_at: observedAt,
      destination_http_status: response.status,
      audience_description: description || candidate.identity.audience_description,
      location: candidate.identity.location ?? demonstratedLocation,
      participation_rules: page.participation ?? candidate.identity.participation_rules,
      participation_rules_status: page.participation ? 'observed' : candidate.identity.participation_rules_status,
    }, evidence),
    outcome: 'verified',
  }
}
