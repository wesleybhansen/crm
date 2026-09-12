import {
  GtmCandidate,
  GtmCandidateMatch,
  GtmPlay,
  GtmResearchRun,
} from '../../data/entities'
import { qualificationDiagnostics } from '../candidate-export'
import { CREDITS_PER_CENT } from '../credits/markup'

/*
 * Read-only research-run summary for the hub's run detail / Opportunities
 * surface (internal research-runs op 'summary').
 *
 * Everything here is derived from rows the run already owns:
 * - counts come from the run's GtmCandidateMatch rows (legacy runs without
 *   match rows fall back to the GtmCandidate rows, exactly like the 'status'
 *   op and the candidates list)
 * - sources_searched comes from the execution summary folded into
 *   provider_plan.execution.batches by lib/research/execute.ts; a run that
 *   has not executed yet lists its planned adapters as not searched
 * - money is the run's frozen quote (estimated_credits) and the settled
 *   charge (reconciled_credits), converted at the noli-core ledger rate
 *   (cost_cents = ceil(credits / CREDITS_PER_CENT), per operation)
 * - top_filters reuses qualificationDiagnostics() so the grouped reject
 *   reasons are the same numbers the Opportunities screen already shows as
 *   "Largest recorded filters"
 *
 * No provider, ledger, or model call; no row is written.
 */

export type ResearchSummaryEm = {
  find<T extends object>(
    entityClass: new () => T,
    where: Record<string, unknown>,
    options?: { orderBy?: Record<string, 'asc' | 'desc'>; limit?: number },
  ): Promise<T[]>
  findOne<T extends object>(
    entityClass: new () => T,
    where: Record<string, unknown>,
  ): Promise<T | null>
}

export type ResearchSummaryCtx = { organizationId: string; tenantId: string }

export type ResearchSummarySource = {
  source: string
  searched: boolean
  found: number
}

export type ResearchSummaryFilter = {
  reason: string
  label: string
  count: number
}

export type ResearchRunSummary = {
  run_id: string
  play_id: string
  play_name: string | null
  status: string
  started_at: Date | null
  finished_at: Date | null
  elapsed_ms: number | null
  sources_searched: ResearchSummarySource[]
  found: number
  accepted: number
  needs_review: number
  filtered_out: number
  size_unconfirmed: number
  projected_cost_cents: number | null
  spent_cents: number | null
  cost_per_accepted_cents: number | null
  qualification_rate: number | null
  top_filters: ResearchSummaryFilter[]
}

export const TOP_FILTER_LIMIT = 6

// Reason codes the qualifier emits (lib/research/qualify.ts FIT_REASONS) plus
// the rollup buckets qualificationDiagnostics() adds, in plain English. An
// unknown code is humanised rather than dropped so a new qualifier reason
// still shows up with a readable label.
export const FIT_REASON_LABELS: Record<string, string> = {
  meets_fit_rules: 'Meets every fit rule',
  insufficient_decisive_fit_data: 'Not enough decisive information to judge fit',
  entity_kind_mismatch: 'Wrong record type for this play',
  missing_identity_name: 'No name on the record',
  missing_public_destination: 'No public link to act on',
  outside_play_geography: "Outside this play's geography",
  no_supporting_evidence: 'No usable supporting evidence',
  weak_evidence_confidence: 'Supporting evidence is low confidence',
  no_domain: 'No company domain found',
  below_fit_threshold: 'Scored below the fit threshold',
  required_criterion_mismatch: 'Fails a required criterion',
  required_criterion_unknown: 'A required criterion could not be confirmed',
  matches_exclusion_criterion: 'Matches an exclusion rule',
  outside_signal_recency_window: 'Signal is older than the recency window',
  public_destination_inaccessible: 'Public link could not be reached',
  public_destination_expired: 'Public link has expired',
  opportunity_audience_mismatch: 'Audience does not match the play',
  opportunity_intent_mismatch: 'No buying intent in the conversation',
  opportunity_not_actionable_under_observed_rules: 'Venue rules do not allow participation',
  opportunity_not_relevant_to_play: 'Not relevant to this play',
  realtor_false_positive: 'Realtor noise, not a prospect',
  accepted_size_unconfirmed: 'Accepted, team size unconfirmed',
  size_unknown: 'Team size unknown',
  manual_review: 'Rejected by a reviewer',
  unspecified: 'No reason recorded',
}

export function fitReasonLabel(reason: string): string {
  const code = reason.trim()
  const known = FIT_REASON_LABELS[code]
  if (known) return known
  const words = code.replace(/[_:\-\s]+/g, ' ').trim()
  if (!words) return 'No reason recorded'
  return words.charAt(0).toUpperCase() + words.slice(1)
}

// noli-core settles cost_cents = ceil(charged_credits / CREDITS_PER_CENT)
// per operation; mirror that rounding rather than inventing a fractional cent.
export function centsFromCredits(credits: number): number {
  if (!Number.isFinite(credits) || credits <= 0) return 0
  return Math.ceil(credits / CREDITS_PER_CENT)
}

type ExecutionBatch = {
  adapter_id?: unknown
  outcome?: unknown
  raw_candidates_found?: unknown
  charged_credits?: unknown
  ledger_status?: unknown
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

// A batch "searched" its source when the adapter was actually called. Skip
// markers (limits reached, source unresolved) and a credit block mean the
// provider was never contacted.
function batchSearched(outcome: unknown): boolean {
  if (typeof outcome !== 'string') return false
  return !outcome.startsWith('skipped_') && !outcome.startsWith('blocked_')
}

export function sourcesSearchedFromPlan(
  providerPlan: Record<string, unknown> | null | undefined,
): ResearchSummarySource[] {
  const plan = providerPlan ?? {}
  const execution = asRecord(plan.execution)
  const batches = Array.isArray(execution?.batches) ? (execution!.batches as ExecutionBatch[]) : []
  const adapterPlan = Array.isArray(plan.adapterPlan) ? (plan.adapterPlan as Array<Record<string, unknown>>) : []

  const order: string[] = []
  const bySource = new Map<string, ResearchSummarySource>()
  const touch = (source: string) => {
    let row = bySource.get(source)
    if (!row) {
      row = { source, searched: false, found: 0 }
      bySource.set(source, row)
      order.push(source)
    }
    return row
  }
  for (const entry of adapterPlan) {
    if (typeof entry.adapter_id === 'string' && entry.adapter_id) touch(entry.adapter_id)
  }
  for (const batch of batches) {
    if (typeof batch.adapter_id !== 'string' || !batch.adapter_id) continue
    const row = touch(batch.adapter_id)
    if (batchSearched(batch.outcome)) row.searched = true
    row.found += asNumber(batch.raw_candidates_found) ?? 0
  }
  return order.map((source) => bySource.get(source)!)
}

// Settled spend: per-operation ceil when the execution recorded batch-level
// charges (the ledger rounds each operation), else the run's reconciled total.
function settledSpendCents(run: GtmResearchRun): number | null {
  if (run.status !== 'completed' && run.status !== 'failed') return null
  if (run.reconciledCredits == null) return null
  const execution = asRecord((run.providerPlan ?? {}).execution)
  const batches = Array.isArray(execution?.batches) ? (execution!.batches as ExecutionBatch[]) : []
  const charged = batches.filter(
    (batch) =>
      (batch.ledger_status === 'charged' || batch.ledger_status === 'partially_charged')
      && (asNumber(batch.charged_credits) ?? 0) > 0,
  )
  if (charged.length > 0) {
    return charged.reduce((sum, batch) => sum + centsFromCredits(asNumber(batch.charged_credits) ?? 0), 0)
  }
  return centsFromCredits(Number(run.reconciledCredits))
}

export type ResearchSummaryTarget = { runId?: string | null; playId?: string | null }

// Returns null for a missing, foreign, or soft-deleted run (the route answers
// with the same opaque 404 it uses everywhere else).
export async function summarizeResearchRun(
  em: ResearchSummaryEm,
  ctx: ResearchSummaryCtx,
  target: ResearchSummaryTarget,
): Promise<ResearchRunSummary | null> {
  const scope = { organizationId: ctx.organizationId, tenantId: ctx.tenantId, deletedAt: null }
  let run: GtmResearchRun | null = null
  if (target.runId) {
    run = await em.findOne(GtmResearchRun, { ...scope, id: target.runId })
    if (run && target.playId && run.playId !== target.playId) return null
  } else if (target.playId) {
    const runs = await em.find(
      GtmResearchRun,
      { ...scope, playId: target.playId },
      { orderBy: { createdAt: 'desc', id: 'desc' }, limit: 1 },
    )
    run = runs[0] ?? null
  }
  if (!run) return null

  const play = await em.findOne(GtmPlay, { ...scope, id: run.playId })

  // Contextual verdicts live on the per-run match rows; legacy runs that
  // predate matches keep their verdicts on the candidate rows.
  const runScope = { ...scope, researchRunId: run.id }
  const matches = await em.find(GtmCandidateMatch, runScope)
  const verdictRows: Array<Pick<GtmCandidateMatch, 'fitStatus' | 'rejectReason' | 'qualification'>> =
    matches.length > 0 ? matches : await em.find(GtmCandidate, runScope)

  const diagnostics = qualificationDiagnostics(verdictRows)
  const sizeUnconfirmed = verdictRows.filter(
    (row) =>
      row.fitStatus === 'accepted'
      && asRecord(row.qualification)?.reason === 'accepted_size_unconfirmed',
  ).length

  const providerPlan = (run.providerPlan ?? {}) as Record<string, unknown>
  const execution = asRecord(providerPlan.execution)
  const funnel = asRecord(execution?.funnel)
  const found = asNumber(funnel?.raw_candidates_found) ?? verdictRows.length

  const projectedCents = run.estimatedCredits != null ? centsFromCredits(Number(run.estimatedCredits)) : null
  const spentCents = settledSpendCents(run)
  const accepted = diagnostics.accepted

  const startedAt = run.startedAt ?? null
  const finishedAt = run.completedAt ?? null
  const elapsedMs =
    startedAt && finishedAt ? Math.max(0, finishedAt.getTime() - startedAt.getTime()) : null

  const topFilters = Object.entries(diagnostics.by_reason)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_FILTER_LIMIT)
    .map(([reason, count]) => ({ reason, label: fitReasonLabel(reason), count }))

  return {
    run_id: run.id,
    play_id: run.playId,
    play_name: play?.name ?? play?.audience ?? null,
    status: run.status,
    started_at: startedAt,
    finished_at: finishedAt,
    elapsed_ms: elapsedMs,
    sources_searched: sourcesSearchedFromPlan(providerPlan),
    found,
    accepted,
    needs_review: diagnostics.review,
    filtered_out: diagnostics.rejected,
    size_unconfirmed: sizeUnconfirmed,
    projected_cost_cents: projectedCents,
    spent_cents: spentCents,
    cost_per_accepted_cents:
      spentCents != null && accepted > 0 ? Math.round(spentCents / accepted) : null,
    qualification_rate: found > 0 ? Math.min(1, accepted / found) : null,
    top_filters: topFilters,
  }
}
