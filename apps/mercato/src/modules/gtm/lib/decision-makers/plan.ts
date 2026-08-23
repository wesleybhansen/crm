import type { GtmPlay, GtmResearchRun } from '../../data/entities'
import type {
  DecisionMakerAdapter,
  DecisionMakerCompany,
} from '../adapters/apify/company-employees'
import {
  APIFY_COMPANY_EMPLOYEES_MAX_COMPANIES,
  APIFY_COMPANY_EMPLOYEES_MAX_PROFILES,
  APIFY_COMPANY_EMPLOYEES_SIGNAL,
  normalizeLinkedInCompanyIds,
} from '../adapters/apify/company-employees'
import { creditsForUnits, defaultMarkupMultiplier } from '../credits/markup'
import { descriptorHash, immutableHash } from '../research/plan'
import { normalizeCompanyWebsite } from '../enrich/company-domain'

const GENERIC_TITLES = ['Owner', 'Founder', 'CEO', 'President', 'Managing Partner', 'Principal']

function compactText(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
}

export function normalizeDecisionMakerTitles(values: string[]): string[] {
  const byKey = new Map<string, string>()
  for (const value of values) {
    const title = compactText(value).slice(0, 60)
    if (!title) continue
    const key = title.toLowerCase()
    if (!byKey.has(key)) byKey.set(key, title)
    if (byKey.size === 12) break
  }
  return [...byKey.values()]
}

export function recommendedDecisionMakerTitles(play: Pick<GtmPlay, 'audience' | 'likelyBuyer'>): string[] {
  const context = `${compactText(play.audience)} ${compactText(play.likelyBuyer)}`.toLowerCase()
  if (/dent(?:al|ist)|orthodont|practice owner/.test(context)) {
    return ['Practice Owner', 'Owner', 'Founder', 'Principal Dentist', 'Managing Dentist']
  }
  if (/real estate|realtor|broker/.test(context)) {
    return ['Broker Owner', 'Managing Broker', 'Owner', 'Founder']
  }
  if (/agency|marketing firm|creative firm/.test(context)) {
    return ['Agency Owner', 'Founder', 'CEO', 'President']
  }
  if (/law firm|attorney|legal practice/.test(context)) {
    return ['Managing Partner', 'Partner', 'Owner', 'Founder']
  }
  return [...GENERIC_TITLES]
}

export type DecisionMakerPlan = {
  schema_version: '5'
  plan_hash: string
  available: boolean
  run_id: string
  play_id: string
  workspace_id: string
  companies: DecisionMakerCompany[]
  company_count: number
  total_company_count: number
  processed_company_count: number
  remaining_company_count: number
  company_position: number | null
  attempt: number
  job_titles: string[]
  max_profiles: number
  adapter_id: string
  provider_units: number
  billable_unit: string
  quoted_credits_per_unit: number
  maximum_credits: number
  price_version: string
  terms_version: string
  descriptor_hash: string
  note: string
}

export type DecisionMakerOperationProjection = {
  localStatusMirror?: string | null
  settledAt?: Date | string | null
  receipt?: Record<string, unknown> | null
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function receiptPlan(operation: DecisionMakerOperationProjection): Record<string, unknown> | null {
  return record(operation.receipt?.decision_maker_plan)
}

function receiptCompanyIds(operation: DecisionMakerOperationProjection): string[] {
  const values = receiptPlan(operation)?.company_candidate_ids
  return Array.isArray(values)
    ? values.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : []
}

export function hasUnresolvedDecisionMakerOperations(
  operations: DecisionMakerOperationProjection[],
): boolean {
  return operations.some((operation) => (
    operation.localStatusMirror === 'provider_started'
    || operation.localStatusMirror === 'reconciliation_required'
  ))
}

export function processedDecisionMakerCompanyIds(
  operations: DecisionMakerOperationProjection[],
): Set<string> {
  const processed = new Set<string>()
  for (const operation of operations) {
    if (
      operation.localStatusMirror !== 'charged'
      && operation.localStatusMirror !== 'partially_charged'
    ) continue
    if (!operation.settledAt) continue
    const plan = receiptPlan(operation)
    const schemaVersion = Number(plan?.schema_version)
    if (!Number.isFinite(schemaVersion) || schemaVersion < 3) continue
    const companyIds = receiptCompanyIds(operation)
    if (companyIds.length === 1) processed.add(companyIds[0])
  }
  return processed
}

export function decisionMakerAttemptForCompany(
  operations: DecisionMakerOperationProjection[],
  candidateId: string | null,
): number {
  if (!candidateId) return 1
  let latestAttempt = 0
  for (const operation of operations) {
    const plan = receiptPlan(operation)
    if (Number(plan?.schema_version) < 4) continue
    if (receiptCompanyIds(operation)[0] !== candidateId) continue
    const attempt = Number(plan?.attempt)
    if (Number.isInteger(attempt) && attempt > latestAttempt) latestAttempt = attempt
  }
  return latestAttempt + 1
}

export function buildDecisionMakerPlan(args: {
  run: Pick<GtmResearchRun, 'id' | 'playId' | 'workspaceId'>
  companies: DecisionMakerCompany[]
  play: Pick<GtmPlay, 'audience' | 'likelyBuyer'>
  adapter: DecisionMakerAdapter
  jobTitles?: string[] | null
  maxProfiles?: number | null
  markupMultiplier?: number
  processedCompanyIds?: Iterable<string>
  attempt?: number
}): DecisionMakerPlan {
  const rankedCompanies = args.companies
    .map((company, index) => ({
      ...company,
      selection_rank: Number.isInteger(company.selection_rank) && Number(company.selection_rank) >= 0
        ? Number(company.selection_rank)
        : index,
      linkedin_company_ids: normalizeLinkedInCompanyIds(company.linkedin_company_ids ?? []),
      domain: normalizeCompanyWebsite(company.domain)?.companyDomain ?? null,
    }))
    .sort((left, right) => (
      left.selection_rank - right.selection_rank
      || left.candidate_id.localeCompare(right.candidate_id)
    ))
  const eligibleCompanyIds = new Set(rankedCompanies.map((company) => company.candidate_id))
  const processedCompanyIds = new Set(
    [...(args.processedCompanyIds ?? [])].filter((candidateId) => eligibleCompanyIds.has(candidateId)),
  )
  const companies = rankedCompanies
    .filter((company) => !processedCompanyIds.has(company.candidate_id))
    .slice(0, APIFY_COMPANY_EMPLOYEES_MAX_COMPANIES)
  const remainingCompanyCount = Math.max(0, rankedCompanies.length - processedCompanyIds.size)
  const attempt = Number.isSafeInteger(args.attempt) && Number(args.attempt) > 0
    ? Number(args.attempt)
    : 1
  const requestedTitles = normalizeDecisionMakerTitles(args.jobTitles ?? [])
  const jobTitles = requestedTitles.length > 0
    ? requestedTitles
    : recommendedDecisionMakerTitles(args.play)
  const defaultProfiles = Math.min(
    APIFY_COMPANY_EMPLOYEES_MAX_PROFILES,
    Math.max(1, companies.length * 3),
  )
  const maxProfiles = companies.length > 0
    ? Math.max(1, Math.min(
        Math.floor(args.maxProfiles ?? defaultProfiles),
        APIFY_COMPANY_EMPLOYEES_MAX_PROFILES,
      ))
    : 0
  const quote = args.adapter.quote({
    signal_kind: APIFY_COMPANY_EMPLOYEES_SIGNAL,
    entity_unit: 'people',
    geography: 'US',
    companies,
    job_titles: jobTitles,
    max_profiles: maxProfiles,
  })
  const descriptor = args.adapter.descriptor
  const license = descriptor.constraints.license
  const available = (
    license.status === 'approved'
    && license.export
    && license.customer_display
    && license.outreach_allowed
    && companies.length > 0
    && jobTitles.length > 0
    && quote.provider_units > 0
  )
  const descriptorDigest = descriptorHash(descriptor)
  const markup = args.markupMultiplier ?? defaultMarkupMultiplier()
  const maximumCredits = available
    ? creditsForUnits(
        quote.provider_units,
        quote.quoted_credits_per_unit,
        markup,
      )
    : 0
  const frozen = {
    schema_version: '5' as const,
    run_id: args.run.id,
    play_id: args.run.playId,
    workspace_id: args.run.workspaceId,
    companies,
    attempt,
    job_titles: jobTitles,
    max_profiles: maxProfiles,
    adapter_id: descriptor.adapter_id,
    provider_units: quote.provider_units,
    billable_unit: quote.billable_unit,
    quoted_credits_per_unit: quote.quoted_credits_per_unit,
    markup_multiplier: markup,
    price_version: descriptor.cost_model.price_version,
    terms_version: license.terms_version,
    descriptor_hash: descriptorDigest,
  }
  return {
    schema_version: frozen.schema_version,
    plan_hash: immutableHash(frozen),
    available,
    run_id: frozen.run_id,
    play_id: frozen.play_id,
    workspace_id: frozen.workspace_id,
    companies,
    company_count: companies.length,
    total_company_count: rankedCompanies.length,
    processed_company_count: processedCompanyIds.size,
    remaining_company_count: remainingCompanyCount,
    company_position: companies[0] ? companies[0].selection_rank + 1 : null,
    attempt,
    job_titles: jobTitles,
    max_profiles: maxProfiles,
    adapter_id: frozen.adapter_id,
    provider_units: frozen.provider_units,
    billable_unit: frozen.billable_unit,
    quoted_credits_per_unit: frozen.quoted_credits_per_unit,
    maximum_credits: maximumCredits,
    price_version: frozen.price_version,
    terms_version: frozen.terms_version,
    descriptor_hash: frozen.descriptor_hash,
    note: companies.length > 0
      ? 'One company is checked at a time so every person stays attributable. Basic profile discovery creates named people only; verified email remains a separate gate.'
      : 'Every eligible accepted company in this run has been checked for this lead set.',
  }
}
