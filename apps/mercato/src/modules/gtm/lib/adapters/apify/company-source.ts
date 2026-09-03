import {
  capabilityCovers,
  type AdapterCapability,
  type AdapterDescriptor,
  type AdapterResult,
  type Candidate,
  type CandidateIdentity,
  type SourceAdapter,
  type SourceSearchPlan,
} from '../types'
import { creditsFromUsd } from '../../credits/markup'
import {
  APIFY_ENABLED_ENV,
  APIFY_TERMS_VERSION_ENV,
  APIFY_TIMEOUT_MS_ENV,
  APIFY_TOKEN_ENVS,
  apifyCustomerUseApproved,
  apifyEnabled,
  apifyToken,
  resolveMaxChargeUsd,
} from './source'
import {
  APIFY_DEFAULT_TIMEOUT_MS,
  runActorSync,
  type ApifyFetchLike,
  type ApifyRunOutcome,
} from './client'

/*
 * Company-level firmographic source for the accepted-yield path.
 *
 * The selected HarvestAPI actor searches public LinkedIn company pages and
 * returns the fields our qualification profile can actually evaluate:
 * industry, employee count/range, website and structured locations. It is a
 * separate source adapter from the social-engagement and person-enrichment
 * actors because its request shape, billed events and evidence contract are
 * different.
 *
 * Contract evidence frozen 2026-08-22:
 * - actor/build: harvestapi/linkedin-company-search 0.0.17
 * - input schema: full mode, maxItems, searchQuery, locations, companySize,
 *   startPage and takePages
 * - conservative Free/Bronze pricing: $0.004 per full-company result plus a
 *   one-time $0.001 actor-start event
 * - official output sample: employeeCount, employeeCountRange, industries,
 *   locations, website and linkedinUrl
 *
 * The global Apify approval remains necessary, and this adapter adds a second
 * exact price-version gate. A token or the general Apify flag alone can never
 * activate a new marketplace actor.
 */

export const APIFY_COMPANY_SOURCE_ADAPTER_ID = 'apify-linkedin-company-search'
export const APIFY_COMPANY_SOURCE_ACTOR_ID = 'harvestapi/linkedin-company-search'
export const APIFY_COMPANY_SOURCE_BUILD = '0.0.17'
export const APIFY_COMPANY_SOURCE_SIGNAL = 'firmographic_match'
export const APIFY_COMPANY_SOURCE_MAX_BATCH = 100
export const APIFY_COMPANY_SOURCE_ACTOR_ENV = 'GTM_APIFY_ACTOR_LINKEDIN_COMPANY_SEARCH'
export const APIFY_COMPANY_PRICE_VERSION_ENV = 'GTM_APIFY_COMPANY_PRICE_VERSION'
export const APIFY_COMPANY_REQUIRED_PRICE_VERSION =
  'harvestapi-linkedin-company-search-0.0.17-free-bronze-2026-08-22'

// Free/Bronze public rate. Higher account tiers may be cheaper, but a quote
// must never depend on an unverified discount.
export const APIFY_COMPANY_FULL_RESULT_USD = 0.004
export const APIFY_COMPANY_ACTOR_START_USD = 0.001
// Express the fixed start event in the descriptor's single billable-unit
// vocabulary: $0.001 / $0.004 = 0.25 full-company units.
export const APIFY_COMPANY_START_UNITS =
  APIFY_COMPANY_ACTOR_START_USD / APIFY_COMPANY_FULL_RESULT_USD

const LINKEDIN_COMPANY_SIZES = new Set([
  '1-10',
  '11-50',
  '51-200',
  '201-500',
  '501-1000',
  '1001-5000',
  '5001-10000',
  '10001+',
])

type ApifyCompanyEnv = Record<string, string | undefined>

type CompanySourceRunActor = (
  actorId: string,
  input: Record<string, unknown>,
  options: {
    token: string
    build: string
    timeoutMs: number
    maxItems: number
    maxChargeUsd: number
    now: () => Date
  },
) => Promise<ApifyRunOutcome>

export type ApifyCompanySourceDeps = {
  env?: ApifyCompanyEnv
  now?: () => Date
  runActor?: CompanySourceRunActor
  fetchImpl?: ApifyFetchLike
}

function processEnv(): ApifyCompanyEnv {
  return process.env as unknown as ApifyCompanyEnv
}

function stringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value
    .filter((row): row is string => typeof row === 'string')
    .map((row) => row.trim())
    .filter(Boolean))].slice(0, limit)
}

function timeoutMs(env: ApifyCompanyEnv): number {
  const value = Number(env[APIFY_TIMEOUT_MS_ENV])
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : APIFY_DEFAULT_TIMEOUT_MS
}

function configuredActor(env: ApifyCompanyEnv): string {
  return (env[APIFY_COMPANY_SOURCE_ACTOR_ENV] ?? '').trim() || APIFY_COMPANY_SOURCE_ACTOR_ID
}

export function apifyCompanySourceApproved(env: ApifyCompanyEnv = processEnv()): boolean {
  return (
    apifyCustomerUseApproved(env) &&
    (env[APIFY_COMPANY_PRICE_VERSION_ENV] ?? '').trim() === APIFY_COMPANY_REQUIRED_PRICE_VERSION &&
    configuredActor(env) === APIFY_COMPANY_SOURCE_ACTOR_ID
  )
}

export function apifyCompanySourceEnabled(env: ApifyCompanyEnv = processEnv()): boolean {
  return apifyEnabled(env) && apifyToken(env) !== null && apifyCompanySourceApproved(env)
}

function capability(): AdapterCapability {
  return {
    signal_kind: APIFY_COMPANY_SOURCE_SIGNAL,
    entity_units: ['companies', 'company', 'accounts', 'locations'],
    geographies: ['US'],
    channels: [],
  }
}

export function apifyCompanySourceDescriptor(
  env: ApifyCompanyEnv = processEnv(),
): AdapterDescriptor {
  const approved = apifyCompanySourceApproved(env)
  return {
    contract_version: '2',
    adapter_id: APIFY_COMPANY_SOURCE_ADAPTER_ID,
    layer: 'source',
    capabilities: [capability()],
    constraints: {
      license: {
        status: approved ? 'approved' : 'provisional',
        terms_version: (env[APIFY_TERMS_VERSION_ENV] ?? '').trim() || 'unapproved',
        export: approved,
        customer_display: approved,
        outreach_allowed: approved,
        retention_days: 90,
      },
      rate_limits: { requests_per_minute: 30, concurrent: 2 },
      max_batch: APIFY_COMPANY_SOURCE_MAX_BATCH,
    },
    cost_model: {
      unit: 'full_company',
      quoted_credits_per_unit: creditsFromUsd(APIFY_COMPANY_FULL_RESULT_USD),
      price_version: (env[APIFY_COMPANY_PRICE_VERSION_ENV] ?? '').trim() || 'unapproved',
      // Even an empty result incurs the fixed actor-start event.
      pay_on_found: false,
    },
    evidence_policy: {
      source_url: 'required',
      observed_at: 'required',
      max_age_days: 30,
      min_confidence: 0.75,
    },
    ambiguity_contract: {
      timeout_is_ambiguous: true,
      receipt_fields: ['actor_id', 'run_id', 'item_count', 'actor_build'],
    },
    dsr: { deletion_supported: false },
  }
}

function trimQuery(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 300)
}

function quoted(value: string): string {
  return value.includes(' ') ? `"${value.replace(/"/g, '')}"` : value.replace(/"/g, '')
}

export function buildApifyCompanySearchInput(plan: SourceSearchPlan): Record<string, unknown> {
  const query = plan.provider_query ?? {}
  // Search breadth and qualification precision are separate contracts. A
  // broad provider term such as "dental" can find the candidate universe,
  // while exact company_keywords/exclusions decide whether each returned row
  // is actually a dental practice rather than a lab, consultant or vendor.
  const searchKeywords = stringArray(query.source_search_keywords, 5)
  const keywords = searchKeywords.length > 0
    ? searchKeywords
    : stringArray(query.company_keywords, 5)
  const industries = stringArray(query.industries, 5)
  const terms = keywords.length > 0 ? keywords : industries
  const searchQuery = trimQuery(
    terms.length > 0 ? terms.map(quoted).join(' OR ') : plan.query,
  )
  const locations = stringArray(query.locations, 20)
  const companySize = stringArray(query.employee_ranges, 8)
    .map((value) => value.replace(/\s*(?:employees?|people|staff)\s*/gi, '').trim())
    .filter((value) => LINKEDIN_COMPANY_SIZES.has(value))
  const cap = Math.max(1, Math.min(
    Math.floor(plan.max_candidates),
    APIFY_COMPANY_SOURCE_MAX_BATCH,
  ))
  const startPage = Math.max(1, Math.floor((plan.offset ?? 0) / 50) + 1)
  return {
    scraperMode: 'full',
    maxItems: cap,
    searchQuery,
    ...(locations.length > 0 ? { locations } : {}),
    ...(companySize.length > 0 ? { companySize } : {}),
    startPage,
    takePages: Math.max(1, Math.ceil(cap / 50)),
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

const CLAIM_TEXT_LIMIT = 120

/*
 * Provider strings that reach the evidence claim are bounded and quoted so a
 * crafted company name cannot read as an instruction to the drafting model,
 * which sees the claim verbatim (review 2026-09-02, M3/H9). The raw values
 * stay in evidence.detail, which never reaches a prompt.
 */
function claimText(value: string | null): string | null {
  if (!value) return null
  const compact = value.replace(/\s+/g, ' ').trim()
  if (!compact) return null
  return `"${Array.from(compact).slice(0, CLAIM_TEXT_LIMIT).join('').replace(/"/g, "'")}"`
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function safeHttpUrl(value: unknown): string | null {
  const raw = text(value)
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.toString()
  } catch {
    return null
  }
}

function domainFromUrl(value: string | null): string | null {
  if (!value) return null
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '') || null
  } catch {
    return null
  }
}

function employeeRange(value: unknown): string | null {
  const row = record(value)
  if (!row) return null
  const start = finiteNumber(row.start)
  const end = finiteNumber(row.end)
  if (start == null) return null
  return end == null ? `${start}+` : `${start}-${end}`
}

type LocationObservation = {
  location: string | null
  city: string | null
  region: string | null
  countryCode: string | null
}

function locationTokens(value: string): string[] {
  return value.toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((token) => token && !['us', 'usa', 'united', 'states'].includes(token))
}

function locationMatchesTarget(row: Record<string, unknown>, targets: string[]): boolean {
  const parsed = record(row.parsed)
  const observed = [
    text(parsed?.text), text(parsed?.city), text(parsed?.state),
    text(parsed?.countryFull), text(row.city), text(row.geographicArea), text(row.country),
  ].filter((value): value is string => Boolean(value)).join(' ')
  const observedTokens = new Set(locationTokens(observed))
  return targets.some((target) => {
    const targetTokens = locationTokens(target)
    return targetTokens.length > 0 && targetTokens.every((token) => observedTokens.has(token))
  })
}

function locationObservation(value: unknown, targetLocations: string[]): LocationObservation {
  const rows = Array.isArray(value) ? value.map(record).filter(Boolean) as Record<string, unknown>[] : []
  const unpack = (row: Record<string, unknown>) => {
    const parsed = record(row.parsed)
    return {
      row,
      parsed,
      countryCode: (text(parsed?.countryCode) ?? text(row.country))?.toUpperCase() ?? null,
    }
  }
  const unpacked = rows.map(unpack)
  // A full company can expose many offices. Prefer the returned office that
  // proves the frozen location filter; otherwise a headquarters elsewhere
  // can create a false rejection even though the provider returned the row
  // for its target-market office.
  const chosen = unpacked.find((entry) =>
    entry.countryCode === 'US' && locationMatchesTarget(entry.row, targetLocations))
    ?? unpacked.find((entry) => entry.countryCode === 'US' && entry.row.headquarter === true)
    ?? unpacked.find((entry) => entry.countryCode === 'US')
    ?? unpacked.find((entry) => entry.row.headquarter === true)
    ?? unpacked[0]
  if (!chosen) return { location: null, city: null, region: null, countryCode: null }
  const city = text(chosen.parsed?.city) ?? text(chosen.row.city)
  const region = text(chosen.parsed?.state) ?? text(chosen.row.geographicArea)
  const location = text(chosen.parsed?.text)
    ?? [city, region, text(chosen.parsed?.countryFull)].filter(Boolean).join(', ')
    ?? null
  return { location: location || null, city, region, countryCode: chosen.countryCode }
}

function industryNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(record).map((row) => text(row?.name)).filter((row): row is string => Boolean(row))
}

export function normalizeApifyCompanyItem(
  value: unknown,
  observedAt: string,
  targetLocations: string[] = [],
): Candidate | null {
  const row = record(value)
  if (!row) return null
  const name = text(row.name)
  const linkedinUrl = safeHttpUrl(row.linkedinUrl)
  if (!name || !linkedinUrl || !/^(?:www\.)?linkedin\.com$/i.test(new URL(linkedinUrl).hostname)) {
    return null
  }
  const website = safeHttpUrl(row.website) ?? safeHttpUrl(row.callToActionUrl)
  const domain = domainFromUrl(website)
  const count = finiteNumber(row.employeeCount)
  const range = employeeRange(row.employeeCountRange)
  const industries = industryNames(row.industries)
  const location = locationObservation(row.locations, targetLocations)
  const urls = [...new Set([linkedinUrl, website].filter((item): item is string => Boolean(item)))]
  const identity: CandidateIdentity = {
    name,
    domain,
    urls,
    location: location.location,
    // Frozen targeting provenance is deliberately distinct from the returned
    // office. The qualifier may use it to avoid a false hard rejection, but
    // never as result-level proof of geographic membership.
    provider_location: targetLocations[0] ?? null,
    city: location.city,
    region: location.region,
    country_code: location.countryCode,
    industry: industries.length > 0 ? industries.join(', ') : null,
    employee_count: count,
    employee_range: range,
    company_description: text(row.description),
  }
  // Fixed vocabulary; every provider string is bounded and quoted.
  const observed = [
    industries.length > 0 ? `industry ${claimText(industries.slice(0, 3).join(', '))}` : null,
    count != null ? `${count} employees` : range ? `${range} employees` : null,
    location.location ? `location ${claimText(location.location)}` : null,
  ].filter(Boolean).join(', ')
  return {
    entity_kind: 'company',
    identity,
    evidence: [{
      claim: observed
        ? `${claimText(name)} is currently listed on LinkedIn with ${observed}.`
        : `${claimText(name)} has a current public LinkedIn company page.`,
      source_url: linkedinUrl,
      observed_at: observedAt,
      confidence: 0.9,
      detail: {
        provider: 'apify',
        actor_id: APIFY_COMPANY_SOURCE_ACTOR_ID,
        actor_build: APIFY_COMPANY_SOURCE_BUILD,
        linkedin_company_id: text(row.id),
        page_verified: row.pageVerified === true,
        employee_count: count,
        employee_range: range,
        industries,
        location: location.location,
        company_name: name,
        // A company page has no publication time; never read retrieval time
        // as freshness (review 2026-09-02, H7).
        published_at_unknown: true,
      },
    }],
  }
}

function receipt(
  outcome: Pick<ApifyRunOutcome, 'actorId' | 'runId' | 'itemCount' | 'kind' | 'httpStatus' | 'requestUrl' | 'attemptedAt'>,
  extras: Record<string, unknown> = {},
) {
  return {
    actor_id: outcome.actorId,
    run_id: outcome.runId,
    item_count: outcome.itemCount,
    actor_build: APIFY_COMPANY_SOURCE_BUILD,
    provider_status: outcome.kind,
    http_status: outcome.httpStatus,
    request_url: outcome.requestUrl,
    attempted_at: outcome.attemptedAt,
    ...extras,
  }
}

function refusal(actorId: string, attemptedAt: string, error: string): AdapterResult<Candidate[]> {
  return {
    status: 'error',
    data: null,
    receipt: {
      actor_id: actorId,
      run_id: null,
      item_count: 0,
      actor_build: APIFY_COMPANY_SOURCE_BUILD,
      provider_status: 'disabled',
      attempted_at: attemptedAt,
    },
    cost_units: 0,
    error,
  }
}

export function createApifyCompanySourceAdapter(
  deps: ApifyCompanySourceDeps = {},
): SourceAdapter {
  const env = deps.env ?? processEnv()
  const now = deps.now ?? (() => new Date())
  const descriptor = apifyCompanySourceDescriptor(env)
  const runActor: CompanySourceRunActor = deps.runActor ?? ((actorId, input, options) =>
    runActorSync(actorId, input, {
      token: options.token,
      build: options.build,
      timeoutMs: options.timeoutMs,
      maxItems: options.maxItems,
      maxChargeUsd: options.maxChargeUsd,
      now: options.now,
      fetchImpl: deps.fetchImpl,
    }))

  return {
    descriptor,
    quote(plan) {
      const maxCandidates = Math.max(0, Math.min(
        Math.floor(plan.max_candidates),
        descriptor.constraints.max_batch,
      ))
      return {
        max_candidates: maxCandidates,
        provider_units: maxCandidates > 0 ? maxCandidates + APIFY_COMPANY_START_UNITS : 0,
        billable_unit: descriptor.cost_model.unit,
        expected_candidates: { low: 0, high: maxCandidates, basis: 'provider_quote' },
        quoted_credits_per_unit: descriptor.cost_model.quoted_credits_per_unit,
        estimated_credits_before_markup:
          (maxCandidates > 0 ? maxCandidates + APIFY_COMPANY_START_UNITS : 0) *
          descriptor.cost_model.quoted_credits_per_unit,
      }
    },
    async search(plan) {
      const attemptedAt = now().toISOString()
      const actorId = configuredActor(env)
      const coverage = capabilityCovers(descriptor, plan)
      if (!coverage.covered) {
        return refusal(actorId, attemptedAt, `unsupported_capability: ${coverage.reason ?? 'not covered'}`)
      }
      if (actorId !== APIFY_COMPANY_SOURCE_ACTOR_ID) {
        return refusal(actorId, attemptedAt, 'provider_disabled: company-source actor override is unapproved')
      }
      if (!apifyEnabled(env)) {
        return refusal(actorId, attemptedAt, `provider_disabled: ${APIFY_ENABLED_ENV} is not 'true'`)
      }
      const token = apifyToken(env)
      if (!token) {
        return refusal(actorId, attemptedAt, `provider_unconfigured: no Apify token configured (${APIFY_TOKEN_ENVS.join(' or ')})`)
      }
      if (!apifyCompanySourceApproved(env)) {
        return refusal(actorId, attemptedAt, 'provider_disabled: company-source terms or price version is unapproved')
      }
      const input = buildApifyCompanySearchInput(plan)
      const cap = input.maxItems as number
      if (!(input.searchQuery as string)) {
        return refusal(actorId, attemptedAt, 'bad_request: a bounded company search query is required')
      }
      const maxChargeUsd = resolveMaxChargeUsd(env, {
        maxItems: cap,
        planBudgetUsd: plan.max_charge_usd,
      })
      const outcome = await runActor(actorId, input, {
        token,
        build: APIFY_COMPANY_SOURCE_BUILD,
        timeoutMs: timeoutMs(env),
        maxItems: cap,
        maxChargeUsd,
        now,
      })
      const providerReceipt = (extras: Record<string, unknown> = {}) => receipt(outcome, {
        max_charge_usd: maxChargeUsd,
        scraper_mode: 'full',
        ...extras,
      })
      if (outcome.status === 'ambiguous') {
        return {
          status: 'ambiguous',
          data: null,
          receipt: providerReceipt(),
          cost_units: null,
          error: outcome.error ?? 'ambiguous provider outcome',
        }
      }
      if (outcome.status === 'error') {
        return {
          status: 'error',
          data: null,
          receipt: providerReceipt(),
          cost_units: 0,
          error: outcome.error ?? 'provider error',
        }
      }
      if (outcome.status === 'no_result') {
        return {
          status: 'no_result',
          data: null,
          receipt: providerReceipt({ actor_start_billed: true }),
          cost_units: APIFY_COMPANY_START_UNITS,
        }
      }
      const candidates = outcome.items
        .map((item) => normalizeApifyCompanyItem(
          item,
          outcome.attemptedAt,
          stringArray((plan.provider_query ?? {}).locations, 20),
        ))
        .filter((item): item is Candidate => item != null)
        .slice(0, cap)
      if (candidates.length === 0) {
        // Rows were billable but the frozen parser could not establish a
        // usable company identity. Park the operation rather than charging on
        // guessed data or refunding a provider bill we know may exist.
        return {
          status: 'ambiguous',
          data: null,
          receipt: providerReceipt({ parser_dropped_rows: outcome.itemCount }),
          cost_units: null,
          error: 'invalid_schema: provider rows contained no usable company identity',
        }
      }
      return {
        status: candidates.length < outcome.itemCount ? 'partial' : 'ok',
        data: candidates,
        receipt: providerReceipt({
          returned_count: candidates.length,
          parser_dropped_rows: Math.max(0, outcome.itemCount - candidates.length),
          actor_start_billed: true,
        }),
        // Actor invoices every returned full-company row plus one fixed start.
        cost_units: outcome.itemCount + APIFY_COMPANY_START_UNITS,
      }
    },
  }
}
