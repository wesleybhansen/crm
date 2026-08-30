import {
  GtmAuditEvent,
  GtmCandidate,
  GtmCandidateMatch,
  GtmProviderOperation,
  GtmResearchRun,
} from '../../data/entities'
import type { CampaignEm, GtmCtx } from '../campaign/build'

/**
 * Aggregate opportunity-quality telemetry only. This diagnostic deliberately
 * never returns candidate identities, URLs, provider receipts, play text, or
 * free-form human notes.
 */
export const OPPORTUNITY_QUALITY_CANDIDATE_CAP = 5_000
export const OPPORTUNITY_QUALITY_OPERATION_CAP = 2_000
export const OPPORTUNITY_QUALITY_RUN_CAP = 1_000
export const OPPORTUNITY_QUALITY_AUDIT_CAP = 5_000

const KNOWN_REVIEW_REASONS = new Set([
  'manual_review_rejected',
  'missing_public_destination',
  'outside_play_geography',
  'public_destination_inaccessible',
  'public_destination_expired',
  'outside_signal_recency_window',
  'opportunity_audience_mismatch',
  'opportunity_intent_mismatch',
  'opportunity_not_relevant_to_play',
  'realtor_false_positive',
  'below_fit_threshold',
  'insufficient_decisive_fit_data',
  'required_criterion_mismatch',
  'required_criterion_unknown',
])

const DEAD_REASONS = new Set([
  'missing_public_destination',
  'public_destination_inaccessible',
  'public_destination_expired',
])
const STALE_REASONS = new Set([
  'public_destination_expired',
  'outside_signal_recency_window',
])

type ProviderAccumulator = {
  source: string
  opportunities: number
  accepted: number
  review: number
  rejected: number
  humanUsefulAccepted: number
  humanRejected: number
  chargedCredits: number
  deadDestinations: number
  staleDestinations: number
  parserInputRows: number
  parserDroppedRows: number
  keywordFilteredRows: number
  rawCandidatesFound: number
  duplicatesSkipped: number
}

export type OpportunityQualitySourceRow = ProviderAccumulator & {
  costCreditsPerUsefulOpportunity: number | null
  deadDestinationRate: number
  staleDestinationRate: number
  parserDropRate: number
  keywordFilterRate: number
  duplicateRate: number
}

export type OpportunityReviewReasonRow = {
  verdict: 'accepted' | 'rejected'
  reason: string
  count: number
}

export type OpportunityProviderDriftRow = {
  adapterId: string
  priceVersions: string[]
  descriptorHashes: string[]
  actorBuilds: string[]
  planSchemaVersions: string[]
  pricingDrift: boolean
  schemaDrift: boolean
}

type PlainObject = Record<string, unknown>

function object(value: unknown): PlainObject | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as PlainObject
    : null
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function count(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0
}

function emptySource(source: string): ProviderAccumulator {
  return {
    source,
    opportunities: 0,
    accepted: 0,
    review: 0,
    rejected: 0,
    humanUsefulAccepted: 0,
    humanRejected: 0,
    chargedCredits: 0,
    deadDestinations: 0,
    staleDestinations: 0,
    parserInputRows: 0,
    parserDroppedRows: 0,
    keywordFilteredRows: 0,
    rawCandidatesFound: 0,
    duplicatesSkipped: 0,
  }
}

function finalizeSource(row: ProviderAccumulator): OpportunityQualitySourceRow {
  return {
    ...row,
    costCreditsPerUsefulOpportunity:
      row.humanUsefulAccepted > 0 ? row.chargedCredits / row.humanUsefulAccepted : null,
    deadDestinationRate: rate(row.deadDestinations, row.opportunities),
    staleDestinationRate: rate(row.staleDestinations, row.opportunities),
    parserDropRate: rate(row.parserDroppedRows, row.parserInputRows),
    keywordFilterRate: rate(
      row.keywordFilteredRows,
      Math.max(0, row.parserInputRows - row.parserDroppedRows),
    ),
    duplicateRate: rate(row.duplicatesSkipped, row.rawCandidatesFound),
  }
}

function safeReviewReason(value: unknown): string {
  const reason = string(value)
  if (!reason) return 'no_reason_provided'
  return KNOWN_REVIEW_REASONS.has(reason) ? reason : 'custom_reason'
}

function operationReceiptCounts(operation: GtmProviderOperation): {
  input: number
  dropped: number
  keywordFiltered: number
  actorBuild: string | null
} {
  const receipt = object(operation.receipt)
  if (!receipt) return { input: 0, dropped: 0, keywordFiltered: 0, actorBuild: null }
  const dropped = count(receipt.parser_dropped_rows ?? receipt.dropped_items)
  const keywordFiltered = count(receipt.keyword_filtered_rows)
  const raw = count(receipt.raw_item_count)
  const returned = count(receipt.returned_count)
  const itemCount = count(receipt.item_count)
  return {
    input: raw > 0 ? raw : itemCount > 0 ? itemCount : returned + dropped + keywordFiltered,
    dropped,
    keywordFiltered,
    actorBuild: string(receipt.actor_build),
  }
}

function executionBatches(run: GtmResearchRun): PlainObject[] {
  const plan = object(run.providerPlan)
  const execution = object(plan?.execution)
  return array(execution?.batches).map(object).filter((row): row is PlainObject => Boolean(row))
}

function adapterPlan(run: GtmResearchRun): PlainObject[] {
  const plan = object(run.providerPlan)
  return array(plan?.adapterPlan).map(object).filter((row): row is PlainObject => Boolean(row))
}

function planSchemaVersion(run: GtmResearchRun): string {
  return String(object(run.providerPlan)?.schemaVersion ?? 'unknown')
}

function latestReviewByMatch(audits: GtmAuditEvent[]): Map<string, GtmAuditEvent> {
  const result = new Map<string, GtmAuditEvent>()
  for (const audit of audits) {
    if (!audit.objectId || result.has(audit.objectId)) continue
    result.set(audit.objectId, audit)
  }
  return result
}

export async function getOpportunityQualityDiagnostics(
  em: CampaignEm,
  ctx: Pick<GtmCtx, 'organizationId' | 'tenantId'>,
): Promise<{
  totals: OpportunityQualitySourceRow
  sources: OpportunityQualitySourceRow[]
  humanReviewReasons: OpportunityReviewReasonRow[]
  drift: { detected: boolean; providers: OpportunityProviderDriftRow[] }
  window: {
    candidateCap: number
    operationCap: number
    runCap: number
    auditCap: number
    truncated: boolean
  }
}> {
  const candidateWindow = await em.find(GtmCandidate, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    entityKind: 'opportunity',
    deletedAt: null,
  }, { orderBy: { createdAt: 'desc' }, limit: OPPORTUNITY_QUALITY_CANDIDATE_CAP + 1 })
  const candidates = candidateWindow.slice(0, OPPORTUNITY_QUALITY_CANDIDATE_CAP)
  const candidateIds = candidates.map((candidate) => candidate.id)
  const matchWindow = candidateIds.length > 0
    ? await em.find(GtmCandidateMatch, {
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        candidateId: { $in: candidateIds },
        deletedAt: null,
      }, { orderBy: { createdAt: 'desc' }, limit: OPPORTUNITY_QUALITY_CANDIDATE_CAP + 1 })
    : []
  const matches = matchWindow.slice(0, OPPORTUNITY_QUALITY_CANDIDATE_CAP)
  const runIds = [...new Set(matches.map((match) => match.researchRunId))]
  const runWindow = runIds.length > 0
    ? await em.find(GtmResearchRun, {
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        id: { $in: runIds },
        deletedAt: null,
      }, { orderBy: { createdAt: 'desc' }, limit: OPPORTUNITY_QUALITY_RUN_CAP + 1 })
    : []
  const runs = runWindow.slice(0, OPPORTUNITY_QUALITY_RUN_CAP)
  const operationWindow = runIds.length > 0
    ? await em.find(GtmProviderOperation, {
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        researchRunId: { $in: runIds },
        deletedAt: null,
      }, { orderBy: { createdAt: 'desc' }, limit: OPPORTUNITY_QUALITY_OPERATION_CAP + 1 })
    : []
  const operations = operationWindow.slice(0, OPPORTUNITY_QUALITY_OPERATION_CAP)
  const matchIds = matches.map((match) => match.id)
  const auditWindow = matchIds.length > 0
    ? await em.find(GtmAuditEvent, {
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        action: 'gtm.candidate_match.review_override',
        objectId: { $in: matchIds },
        deletedAt: null,
      }, { orderBy: { createdAt: 'desc' }, limit: OPPORTUNITY_QUALITY_AUDIT_CAP + 1 })
    : []
  const audits = auditWindow.slice(0, OPPORTUNITY_QUALITY_AUDIT_CAP)

  const operationById = new Map(operations.map((operation) => [operation.id, operation]))
  const operationByCanonicalId = new Map(
    operations.map((operation) => [operation.noliCoreOperationId, operation]),
  )
  const latestReview = latestReviewByMatch(audits)
  const sources = new Map<string, ProviderAccumulator>()
  const reasonCounts = new Map<string, OpportunityReviewReasonRow>()

  const sourceForMatch = (match: GtmCandidateMatch): string => {
    if (!match.providerOperationId) return 'unknown'
    return operationById.get(match.providerOperationId)?.provider || 'unknown'
  }
  const sourceRow = (source: string): ProviderAccumulator => {
    const row = sources.get(source) ?? emptySource(source)
    sources.set(source, row)
    return row
  }

  for (const match of matches) {
    const row = sourceRow(sourceForMatch(match))
    row.opportunities += 1
    if (match.fitStatus === 'accepted') row.accepted += 1
    else if (match.fitStatus === 'rejected') row.rejected += 1
    else row.review += 1
    if (match.rejectReason && DEAD_REASONS.has(match.rejectReason)) row.deadDestinations += 1
    if (match.rejectReason && STALE_REASONS.has(match.rejectReason)) row.staleDestinations += 1

    const review = latestReview.get(match.id)
    const metadata = object(review?.metadata)
    const verdict = metadata?.verdict === 'accepted' || metadata?.verdict === 'rejected'
      ? metadata.verdict
      : null
    if (!verdict) continue
    if (verdict === 'accepted' && match.fitStatus === 'accepted') row.humanUsefulAccepted += 1
    if (verdict === 'rejected' && match.fitStatus === 'rejected') row.humanRejected += 1
    const reason = verdict === 'accepted' ? 'accepted' : safeReviewReason(metadata?.reason)
    const key = `${verdict}\u0000${reason}`
    const reasonRow = reasonCounts.get(key) ?? { verdict, reason, count: 0 }
    reasonRow.count += 1
    reasonCounts.set(key, reasonRow)
  }

  for (const operation of operations) {
    const row = sourceRow(operation.provider || 'unknown')
    const receipt = operationReceiptCounts(operation)
    row.parserInputRows += receipt.input
    row.parserDroppedRows += receipt.dropped
    row.keywordFilteredRows += receipt.keywordFiltered
  }

  const drift = new Map<string, {
    priceVersions: Set<string>
    descriptorHashes: Set<string>
    actorBuilds: Set<string>
    planSchemaVersions: Set<string>
  }>()
  const driftRow = (adapterId: string) => {
    const row = drift.get(adapterId) ?? {
      priceVersions: new Set<string>(),
      descriptorHashes: new Set<string>(),
      actorBuilds: new Set<string>(),
      planSchemaVersions: new Set<string>(),
    }
    drift.set(adapterId, row)
    return row
  }

  for (const run of runs) {
    const planRows = adapterPlan(run)
    const executions = executionBatches(run)
    const schemaVersion = planSchemaVersion(run)
    for (const [index, plan] of planRows.entries()) {
      const adapterId = string(plan.adapter_id) ?? 'unknown'
      const observed = driftRow(adapterId)
      const priceVersion = string(plan.priceVersion)
      const descriptorHash = string(plan.descriptorHash)
      if (priceVersion) observed.priceVersions.add(priceVersion)
      if (descriptorHash) observed.descriptorHashes.add(descriptorHash)
      observed.planSchemaVersions.add(schemaVersion)

      const execution = executions[index]
      const operation = operationByCanonicalId.get(string(execution?.operation_id) ?? '')
      const source = operation?.provider || adapterId
      const row = sourceRow(source)
      row.chargedCredits += count(execution?.charged_credits)
      row.rawCandidatesFound += count(execution?.raw_candidates_found)
      row.duplicatesSkipped += count(execution?.duplicates_skipped)
      const actorBuild = operation ? operationReceiptCounts(operation).actorBuild : null
      if (actorBuild) observed.actorBuilds.add(actorBuild)
    }
  }

  const providerRows: OpportunityProviderDriftRow[] = [...drift.entries()]
    .map(([adapterId, observed]) => ({
      adapterId,
      priceVersions: [...observed.priceVersions].sort(),
      descriptorHashes: [...observed.descriptorHashes].sort(),
      actorBuilds: [...observed.actorBuilds].sort(),
      planSchemaVersions: [...observed.planSchemaVersions].sort(),
      pricingDrift: observed.priceVersions.size > 1,
      schemaDrift:
        observed.descriptorHashes.size > 1
        || observed.actorBuilds.size > 1
        || observed.planSchemaVersions.size > 1
        || [...observed.planSchemaVersions].some((version) => version !== '9' && version !== '10'),
    }))
    .sort((left, right) => left.adapterId.localeCompare(right.adapterId))
  const sourceRows = [...sources.values()]
    .map(finalizeSource)
    .sort((left, right) => left.source.localeCompare(right.source))
  const total = sourceRows.reduce<ProviderAccumulator>((sum, row) => ({
    source: 'all',
    opportunities: sum.opportunities + row.opportunities,
    accepted: sum.accepted + row.accepted,
    review: sum.review + row.review,
    rejected: sum.rejected + row.rejected,
    humanUsefulAccepted: sum.humanUsefulAccepted + row.humanUsefulAccepted,
    humanRejected: sum.humanRejected + row.humanRejected,
    chargedCredits: sum.chargedCredits + row.chargedCredits,
    deadDestinations: sum.deadDestinations + row.deadDestinations,
    staleDestinations: sum.staleDestinations + row.staleDestinations,
    parserInputRows: sum.parserInputRows + row.parserInputRows,
    parserDroppedRows: sum.parserDroppedRows + row.parserDroppedRows,
    keywordFilteredRows: sum.keywordFilteredRows + row.keywordFilteredRows,
    rawCandidatesFound: sum.rawCandidatesFound + row.rawCandidatesFound,
    duplicatesSkipped: sum.duplicatesSkipped + row.duplicatesSkipped,
  }), emptySource('all'))

  return {
    totals: finalizeSource(total),
    sources: sourceRows,
    humanReviewReasons: [...reasonCounts.values()].sort((left, right) =>
      left.verdict.localeCompare(right.verdict) || left.reason.localeCompare(right.reason),
    ),
    drift: {
      detected: providerRows.some((row) => row.pricingDrift || row.schemaDrift),
      providers: providerRows,
    },
    window: {
      candidateCap: OPPORTUNITY_QUALITY_CANDIDATE_CAP,
      operationCap: OPPORTUNITY_QUALITY_OPERATION_CAP,
      runCap: OPPORTUNITY_QUALITY_RUN_CAP,
      auditCap: OPPORTUNITY_QUALITY_AUDIT_CAP,
      truncated:
        candidateWindow.length > OPPORTUNITY_QUALITY_CANDIDATE_CAP
        || matchWindow.length > OPPORTUNITY_QUALITY_CANDIDATE_CAP
        || operationWindow.length > OPPORTUNITY_QUALITY_OPERATION_CAP
        || runWindow.length > OPPORTUNITY_QUALITY_RUN_CAP
        || auditWindow.length > OPPORTUNITY_QUALITY_AUDIT_CAP,
    },
  }
}
