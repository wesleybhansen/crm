import {
  capabilityCovers,
  type AdapterCapability,
  type AdapterDescriptor,
  type AdapterResult,
  type Candidate,
  type CandidateIdentity,
} from '../types'
import { creditsFromUsd } from '../../credits/markup'
import {
  APIFY_CUSTOMER_USE_APPROVED_ENV,
  APIFY_ENABLED_ENV,
  APIFY_PRICE_VERSION_ENV,
  APIFY_REQUIRED_PRICE_VERSION,
  APIFY_REQUIRED_TERMS_VERSION,
  APIFY_TERMS_VERSION_ENV,
  APIFY_TIMEOUT_MS_ENV,
  APIFY_TOKEN_ENVS,
  apifyEnabled,
  apifyToken,
} from './source'
import {
  APIFY_DEFAULT_TIMEOUT_MS,
  runActorSync,
  type ApifyFetchLike,
  type ApifyRunOutcome,
} from './client'

export const APIFY_COMPANY_EMPLOYEES_ADAPTER_ID = 'apify-linkedin-company-employees'
export const APIFY_COMPANY_EMPLOYEES_ACTOR_ID = 'harvestapi/linkedin-company-employees'
export const APIFY_COMPANY_EMPLOYEES_SIGNAL = 'company_decision_maker'
export const APIFY_COMPANY_EMPLOYEES_ACTOR_ENV = 'GTM_APIFY_ACTOR_LINKEDIN_COMPANY_EMPLOYEES'
export const APIFY_COMPANY_EMPLOYEES_PRICE_VERSION_ENV =
  'GTM_APIFY_COMPANY_EMPLOYEES_PRICE_VERSION'
export const APIFY_COMPANY_EMPLOYEES_REQUIRED_PRICE_VERSION =
  'harvestapi-linkedin-company-employees-basic-min-0.05-2026-08-22'
// A Short-mode result does not reliably identify its source company when an
// Actor run contains more than one company. Keep one immutable company per
// operation so the echoed query can safely bind every accepted row.
export const APIFY_COMPANY_EMPLOYEES_MAX_COMPANIES = 1
export const APIFY_COMPANY_EMPLOYEES_MAX_PROFILES = 25
export const APIFY_COMPANY_EMPLOYEES_PROFILE_MODE = 'Short ($4 per 1k)'

export const APIFY_COMPANY_EMPLOYEES_BASIC_PROFILE_USD = 0.003
// The public price table says $3/1k Basic profiles while the actor input
// schema still labels Short mode $4/1k. Quote and settle at the higher bound
// until a canonical provider receipt resolves the discrepancy.
export const APIFY_COMPANY_EMPLOYEES_QUOTED_PROFILE_USD = 0.004
export const APIFY_COMPANY_EMPLOYEES_ACTOR_START_USD = 0.02
// The Actor metadata currently declares a $0.05 minimum
// `maxTotalChargeUsd`. A smaller reservation is rejected before a run starts,
// even when the start + requested profile events would cost less. Quote the
// provider-enforced ceiling so the canonical ledger always covers the hard
// cap sent to Apify; settlement still uses the actual start + returned rows.
export const APIFY_COMPANY_EMPLOYEES_MIN_CHARGE_USD = 0.05
const APIFY_MILLIDOLLAR_USD = 0.001
export const APIFY_COMPANY_EMPLOYEES_PROFILE_UNITS =
  APIFY_COMPANY_EMPLOYEES_QUOTED_PROFILE_USD / APIFY_MILLIDOLLAR_USD
export const APIFY_COMPANY_EMPLOYEES_START_UNITS =
  APIFY_COMPANY_EMPLOYEES_ACTOR_START_USD / APIFY_MILLIDOLLAR_USD
export const APIFY_COMPANY_EMPLOYEES_MIN_CHARGE_UNITS =
  APIFY_COMPANY_EMPLOYEES_MIN_CHARGE_USD / APIFY_MILLIDOLLAR_USD

type CompanyEmployeesEnv = Record<string, string | undefined>

export type DecisionMakerCompany = {
  candidate_id: string
  match_id: string
  name: string
  linkedin_url: string
  domain?: string | null
  selection_rank?: number
  // Numeric LinkedIn company ids observed by the upstream company source.
  // LinkedIn may return the same company as either a slug URL or a numeric
  // canonical URL, so both aliases must be frozen into the priced plan.
  linkedin_company_ids?: string[]
}

export function normalizeLinkedInCompanyIds(values: unknown[]): string[] {
  return [...new Set(values.flatMap((value) => {
    if (typeof value !== 'string') return []
    const id = value.trim()
    return /^\d+$/.test(id) ? [id] : []
  }))].sort().slice(0, 8)
}

export function linkedInCompanyIdsFromEvidence(
  rows: Array<{ providerRef?: Record<string, unknown> | null }>,
): string[] {
  return normalizeLinkedInCompanyIds(rows.map((row) => {
    const detail = row.providerRef?.detail
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null
    return (detail as Record<string, unknown>).linkedin_company_id
  }))
}

export type DecisionMakerResolvePlan = {
  signal_kind: typeof APIFY_COMPANY_EMPLOYEES_SIGNAL
  entity_unit: 'people'
  geography: 'US'
  companies: DecisionMakerCompany[]
  job_titles: string[]
  max_profiles: number
  max_charge_usd?: number
}

export type DecisionMakerObservation = {
  candidate: Candidate
  parent_company_url: string
  current_title: string
}

export type DecisionMakerQuote = {
  max_companies: number
  max_profiles: number
  provider_units: number
  billable_unit: string
  quoted_credits_per_unit: number
  estimated_credits_before_markup: number
}

export interface DecisionMakerAdapter {
  descriptor: AdapterDescriptor
  quote(plan: Omit<DecisionMakerResolvePlan, 'max_charge_usd'>): DecisionMakerQuote
  resolve(plan: DecisionMakerResolvePlan): Promise<AdapterResult<DecisionMakerObservation[]>>
}

type CompanyEmployeesRunActor = (
  actorId: string,
  input: Record<string, unknown>,
  options: {
    token: string
    timeoutMs: number
    maxItems: number
    maxChargeUsd: number
    now: () => Date
  },
) => Promise<ApifyRunOutcome>

export type ApifyCompanyEmployeesDeps = {
  env?: CompanyEmployeesEnv
  now?: () => Date
  runActor?: CompanyEmployeesRunActor
  fetchImpl?: ApifyFetchLike
}

function processEnv(): CompanyEmployeesEnv {
  return process.env as unknown as CompanyEmployeesEnv
}

function configuredActor(env: CompanyEmployeesEnv): string {
  return (env[APIFY_COMPANY_EMPLOYEES_ACTOR_ENV] ?? '').trim()
    || APIFY_COMPANY_EMPLOYEES_ACTOR_ID
}

function timeoutMs(env: CompanyEmployeesEnv): number {
  const value = Number(env[APIFY_TIMEOUT_MS_ENV])
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : APIFY_DEFAULT_TIMEOUT_MS
}

export function apifyCompanyEmployeesApproved(
  env: CompanyEmployeesEnv = processEnv(),
): boolean {
  return (
    env[APIFY_CUSTOMER_USE_APPROVED_ENV] === 'true'
    && (env[APIFY_TERMS_VERSION_ENV] ?? '').trim() === APIFY_REQUIRED_TERMS_VERSION
    && (env[APIFY_PRICE_VERSION_ENV] ?? '').trim() === APIFY_REQUIRED_PRICE_VERSION
    && (env[APIFY_COMPANY_EMPLOYEES_PRICE_VERSION_ENV] ?? '').trim()
      === APIFY_COMPANY_EMPLOYEES_REQUIRED_PRICE_VERSION
    && configuredActor(env) === APIFY_COMPANY_EMPLOYEES_ACTOR_ID
  )
}

export function apifyCompanyEmployeesEnabled(
  env: CompanyEmployeesEnv = processEnv(),
): boolean {
  return apifyEnabled(env) && apifyToken(env) !== null && apifyCompanyEmployeesApproved(env)
}

function capability(): AdapterCapability {
  return {
    signal_kind: APIFY_COMPANY_EMPLOYEES_SIGNAL,
    entity_units: ['people'],
    geographies: ['US'],
    channels: ['linkedin'],
  }
}

export function apifyCompanyEmployeesDescriptor(
  env: CompanyEmployeesEnv = processEnv(),
): AdapterDescriptor {
  const approved = apifyCompanyEmployeesApproved(env)
  return {
    contract_version: '2',
    adapter_id: APIFY_COMPANY_EMPLOYEES_ADAPTER_ID,
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
      rate_limits: { requests_per_minute: 30, concurrent: 1 },
      max_batch: APIFY_COMPANY_EMPLOYEES_MAX_PROFILES,
    },
    cost_model: {
      unit: 'apify_millidollar',
      quoted_credits_per_unit: creditsFromUsd(APIFY_MILLIDOLLAR_USD),
      price_version:
        (env[APIFY_COMPANY_EMPLOYEES_PRICE_VERSION_ENV] ?? '').trim() || 'unapproved',
      pay_on_found: false,
    },
    evidence_policy: {
      source_url: 'required',
      observed_at: 'required',
      max_age_days: 30,
      min_confidence: 0.8,
    },
    ambiguity_contract: {
      timeout_is_ambiguous: true,
      receipt_fields: ['actor_id', 'run_id', 'item_count', 'profile_mode'],
    },
    dsr: { deletion_supported: false },
  }
}

function distinctStrings(values: string[], limit: number): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, limit)
}

export function buildApifyCompanyEmployeesInput(
  plan: DecisionMakerResolvePlan,
): Record<string, unknown> {
  const companies = distinctStrings(
    plan.companies.map((company) => company.linkedin_url),
    APIFY_COMPANY_EMPLOYEES_MAX_COMPANIES,
  )
  const jobTitles = distinctStrings(plan.job_titles, 20)
  const maxItems = Math.max(1, Math.min(
    Math.floor(plan.max_profiles),
    APIFY_COMPANY_EMPLOYEES_MAX_PROFILES,
  ))
  return {
    profileScraperMode: APIFY_COMPANY_EMPLOYEES_PROFILE_MODE,
    maxItems,
    companies,
    jobTitles,
    companyBatchMode: 'all_at_once',
    startPage: 1,
    takePages: 1,
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

function safeLinkedInUrl(value: unknown, kind: 'person' | 'company'): string | null {
  const raw = text(value)
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (!/^(?:www\.)?linkedin\.com$/i.test(url.hostname)) return null
    const prefix = kind === 'person' ? '/in/' : '/company/'
    if (!url.pathname.toLowerCase().startsWith(prefix)) return null
    return url.toString()
  } catch {
    return null
  }
}

function normalizedCompanyUrl(value: string): string {
  const url = new URL(value)
  const pathname = url.pathname.replace(/\/+$/, '').toLowerCase()
  return `${url.hostname.toLowerCase().replace(/^www\./, '')}${pathname}`
}

function linkedInCompanyId(value: string): string | null {
  const url = new URL(value)
  const match = url.pathname.match(/^\/company\/(\d+)\/?$/i)
  return match?.[1] ?? null
}

function locationIdentity(value: unknown): Pick<CandidateIdentity, 'location' | 'city' | 'region' | 'country_code'> {
  const row = record(value)
  const parsed = record(row?.parsed)
  return {
    location: text(parsed?.text) ?? text(row?.linkedinText),
    city: text(parsed?.city),
    region: text(parsed?.state),
    country_code: text(parsed?.countryCode)?.toUpperCase() ?? null,
  }
}

type CurrentPosition = {
  title: string
  companyName: string
  companyUrl: string
}

function currentPositions(value: unknown): CurrentPosition[] {
  if (!Array.isArray(value)) return []
  return value.map(record).filter((row): row is Record<string, unknown> => row != null)
    .map((row) => ({
      title: text(row.position) ?? text(row.title) ?? '',
      companyName: text(row.companyName) ?? '',
      companyUrl: safeLinkedInUrl(row.companyLinkedinUrl, 'company') ?? '',
    }))
    .filter((row) => row.title)
}

function normalizedCompanyName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

function echoedCompanyUrls(row: Record<string, unknown>): string[] {
  const meta = record(row._meta)
  const query = record(meta?.query)
  const currentCompanies = Array.isArray(query?.currentCompanies)
    ? query.currentCompanies
    : []
  return distinctStrings(
    currentCompanies
      .map((value) => safeLinkedInUrl(value, 'company'))
      .filter((value): value is string => value != null),
    APIFY_COMPANY_EMPLOYEES_MAX_COMPANIES + 1,
  )
}

export function normalizeApifyCompanyEmployeeItem(
  value: unknown,
  observedAt: string,
  companies: DecisionMakerCompany[],
): DecisionMakerObservation | null {
  const row = record(value)
  if (!row) return null
  const profileUrl = safeLinkedInUrl(row.linkedinUrl, 'person')
  const firstName = text(row.firstName)
  const lastName = text(row.lastName)
  const name = text(row.fullName) ?? [firstName, lastName].filter(Boolean).join(' ').trim()
  if (!profileUrl || !name) return null

  // The live Actor contract echoes the submitted company query in `_meta`.
  // Short-mode rows are safe only when both the frozen plan and that echo
  // contain the same sole company. A batched echo can prove the batch but not
  // which company produced a particular person, so it is rejected.
  if (companies.length !== 1) return null
  const parent = companies[0]
  const echoed = echoedCompanyUrls(row)
  if (
    echoed.length !== 1
    || normalizedCompanyUrl(echoed[0]) !== normalizedCompanyUrl(parent.linkedin_url)
  ) return null

  const companyByUrl = new Map(
    companies.map((company) => [normalizedCompanyUrl(company.linkedin_url), company]),
  )
  const parentCompanyIds = new Set(
    normalizeLinkedInCompanyIds(parent.linkedin_company_ids ?? []),
  )
  const positions = currentPositions(row.currentPositions ?? row.currentPosition)
  const parentName = normalizedCompanyName(parent.name)
  const position = positions.find((entry) => {
    // Prefer the strongest field and never let a matching display name
    // override a contradictory URL. A numeric LinkedIn URL is also strong
    // when that id was frozen from the upstream company-source evidence.
    if (entry.companyUrl) {
      const companyId = linkedInCompanyId(entry.companyUrl)
      return companyByUrl.has(normalizedCompanyUrl(entry.companyUrl))
        || Boolean(companyId && parentCompanyIds.has(companyId))
    }
    return Boolean(
      entry.companyName && normalizedCompanyName(entry.companyName) === parentName,
    )
  }) ?? (
    positions.length === 1
    && !positions[0].companyUrl
    && !positions[0].companyName
      ? positions[0]
      : null
  )
  if (!position) return null
  const location = locationIdentity(row.location)
  const identity: CandidateIdentity = {
    name,
    company: parent.name,
    title: position.title,
    domain: parent.domain ?? null,
    urls: [profileUrl],
    location: location.location,
    city: location.city,
    region: location.region,
    country_code: location.country_code,
  }
  return {
    parent_company_url: parent.linkedin_url,
    current_title: position.title,
    candidate: {
      entity_kind: 'person',
      identity,
      evidence: [{
        claim: `${name} is currently listed as ${position.title} at ${parent.name}.`,
        source_url: profileUrl,
        observed_at: observedAt,
        confidence: 0.9,
        detail: {
          provider: 'apify',
          actor_id: APIFY_COMPANY_EMPLOYEES_ACTOR_ID,
          parent_company_candidate_id: parent.candidate_id,
          parent_company_match_id: parent.match_id,
          parent_company_url: parent.linkedin_url,
          current_title: position.title,
          company_binding: 'single_company_query_echo_with_alias_v2',
        },
      }],
    },
  }
}

function receipt(
  outcome: Pick<ApifyRunOutcome, 'actorId' | 'runId' | 'itemCount' | 'kind' | 'httpStatus' | 'requestUrl' | 'attemptedAt'>,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    actor_id: outcome.actorId,
    run_id: outcome.runId,
    item_count: outcome.itemCount,
    profile_mode: APIFY_COMPANY_EMPLOYEES_PROFILE_MODE,
    provider_status: outcome.kind,
    http_status: outcome.httpStatus,
    request_url: outcome.requestUrl,
    attempted_at: outcome.attemptedAt,
    ...extras,
  }
}

function refusal(
  actorId: string,
  attemptedAt: string,
  error: string,
): AdapterResult<DecisionMakerObservation[]> {
  return {
    status: 'error',
    data: null,
    receipt: {
      actor_id: actorId,
      run_id: null,
      item_count: 0,
      profile_mode: APIFY_COMPANY_EMPLOYEES_PROFILE_MODE,
      provider_status: 'disabled',
      attempted_at: attemptedAt,
    },
    cost_units: 0,
    error,
  }
}

export function createApifyCompanyEmployeesAdapter(
  deps: ApifyCompanyEmployeesDeps = {},
): DecisionMakerAdapter {
  const env = deps.env ?? processEnv()
  const now = deps.now ?? (() => new Date())
  const descriptor = apifyCompanyEmployeesDescriptor(env)
  const runActor: CompanyEmployeesRunActor = deps.runActor ?? ((actorId, input, options) =>
    runActorSync(actorId, input, {
      token: options.token,
      timeoutMs: options.timeoutMs,
      maxItems: options.maxItems,
      maxChargeUsd: options.maxChargeUsd,
      now: options.now,
      fetchImpl: deps.fetchImpl,
    }))

  return {
    descriptor,
    quote(plan) {
      const maxCompanies = Math.min(
        distinctStrings(plan.companies.map((company) => company.linkedin_url), 100).length,
        APIFY_COMPANY_EMPLOYEES_MAX_COMPANIES,
      )
      const maxProfiles = maxCompanies > 0
        ? Math.max(0, Math.min(Math.floor(plan.max_profiles), APIFY_COMPANY_EMPLOYEES_MAX_PROFILES))
        : 0
      const providerUnits = maxProfiles > 0
        ? Math.max(
            APIFY_COMPANY_EMPLOYEES_MIN_CHARGE_UNITS,
            APIFY_COMPANY_EMPLOYEES_START_UNITS
              + maxProfiles * APIFY_COMPANY_EMPLOYEES_PROFILE_UNITS,
          )
        : 0
      return {
        max_companies: maxCompanies,
        max_profiles: maxProfiles,
        provider_units: providerUnits,
        billable_unit: descriptor.cost_model.unit,
        quoted_credits_per_unit: descriptor.cost_model.quoted_credits_per_unit,
        estimated_credits_before_markup:
          providerUnits * descriptor.cost_model.quoted_credits_per_unit,
      }
    },
    async resolve(plan) {
      const attemptedAt = now().toISOString()
      const actorId = configuredActor(env)
      const coverage = capabilityCovers(descriptor, {
        signal_kind: plan.signal_kind,
        entity_unit: plan.entity_unit,
        geography: plan.geography,
        channel: 'linkedin',
      })
      if (!coverage.covered) {
        return refusal(actorId, attemptedAt, `unsupported_capability: ${coverage.reason ?? 'not covered'}`)
      }
      if (actorId !== APIFY_COMPANY_EMPLOYEES_ACTOR_ID) {
        return refusal(actorId, attemptedAt, 'provider_disabled: company-employees actor override is unapproved')
      }
      if (!apifyEnabled(env)) {
        return refusal(actorId, attemptedAt, `provider_disabled: ${APIFY_ENABLED_ENV} is not 'true'`)
      }
      const token = apifyToken(env)
      if (!token) {
        return refusal(
          actorId,
          attemptedAt,
          `provider_unconfigured: no Apify token configured (${APIFY_TOKEN_ENVS.join(' or ')})`,
        )
      }
      if (!apifyCompanyEmployeesApproved(env)) {
        return refusal(actorId, attemptedAt, 'provider_disabled: company-employees terms or price version is unapproved')
      }
      const input = buildApifyCompanyEmployeesInput(plan)
      const companies = input.companies as string[]
      const jobTitles = input.jobTitles as string[]
      const cap = input.maxItems as number
      if (plan.companies.length !== 1 || companies.length !== 1 || jobTitles.length === 0 || cap <= 0) {
        return refusal(actorId, attemptedAt, 'bad_request: exactly one company, job titles, and a profile cap are required')
      }
      const maxChargeUsd = Number(plan.max_charge_usd)
      if (!Number.isFinite(maxChargeUsd) || maxChargeUsd <= 0) {
        return refusal(actorId, attemptedAt, 'bad_request: a reservation-derived max charge is required')
      }
      const outcome = await runActor(actorId, input, {
        token,
        timeoutMs: timeoutMs(env),
        maxItems: cap,
        maxChargeUsd,
        now,
      })
      const providerReceipt = (extras: Record<string, unknown> = {}) => receipt(outcome, {
        max_charge_usd: maxChargeUsd,
        company_batch_mode: 'all_at_once',
        company_binding: 'single_company_query_echo_with_alias_v2',
        companies_submitted: companies.length,
        job_titles_submitted: jobTitles.length,
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
          cost_units: APIFY_COMPANY_EMPLOYEES_START_UNITS,
        }
      }
      const observations = outcome.items
        .map((item) => normalizeApifyCompanyEmployeeItem(item, outcome.attemptedAt, plan.companies))
        .filter((item): item is DecisionMakerObservation => item != null)
        .slice(0, cap)
      if (observations.length === 0) {
        return {
          status: 'ambiguous',
          data: null,
          receipt: providerReceipt({ parser_dropped_rows: outcome.itemCount }),
          cost_units: null,
          error: 'invalid_schema: provider rows contained no safely bound decision-maker identity',
        }
      }
      return {
        status: observations.length < outcome.itemCount ? 'partial' : 'ok',
        data: observations,
        receipt: providerReceipt({
          returned_count: observations.length,
          parser_dropped_rows: Math.max(0, outcome.itemCount - observations.length),
          actor_start_billed: true,
        }),
        cost_units: APIFY_COMPANY_EMPLOYEES_START_UNITS
          + outcome.itemCount * APIFY_COMPANY_EMPLOYEES_PROFILE_UNITS,
      }
    },
  }
}
