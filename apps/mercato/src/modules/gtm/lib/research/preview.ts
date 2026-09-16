import { UniqueConstraintViolationException } from '@mikro-orm/core'
import { GtmProviderOperation } from '../../data/entities'
import type { Candidate, SourceAdapter } from '../adapters/types'
import {
  creditsForUnits,
  defaultMarkupMultiplier,
  providerSpendCapUsd,
  usdFromCredits,
} from '../credits/markup'
import { GtmCreditLedgerError, type GtmCreditLedger, type GtmSettleOutcome } from '../credits/ledger'
import type { SourcePlanBatch, SourcePlanSuccess } from './plan'

/*
 * Dry-lane preview (spec phase C, "dry-lane previews"): three real public
 * rows of what a run would find, shown before the customer commits to a run.
 *
 * What makes it a DRY lane rather than a small run:
 *
 *   - no gtm_research_runs row is created, so it never appears in run
 *     history, never enrolls anyone, and never becomes a campaign source
 *   - no gtm_candidates, gtm_candidate_matches, gtm_evidence or
 *     gtm_contact_points rows are written. The provider output is shaped into
 *     three display rows, returned, and dropped
 *   - exactly ONE lane of the play's priced plan is called, capped at three
 *     rows, so the fee is a few cents rather than a full run
 *
 * What is identical to a run, deliberately:
 *
 *   - the money. A provider is really called, so the canonical noli-core
 *     ledger reserves, starts and settles the operation exactly as
 *     lib/research/execute.ts does, and a gtm_provider_operations shadow row
 *     records it for reconciliation (research_run_id null: it belongs to no
 *     run). Nothing here invents a free lane
 *   - the honesty. Every returned row carries the source it came from and
 *     when it was observed. Rows are a SAMPLE, never a result set, and the
 *     caller labels them as one
 *   - fail-closed. An ambiguous provider outcome is parked for
 *     reconciliation and never retried, same as a run
 *
 * The daily cap (three per workspace per UTC day) is claimed by the caller
 * before this runs; see lib/workspace-settings.ts consumePlayPreview. The
 * claim is what makes the idempotency key deterministic, so a retried preview
 * re-reserves the same ledger operation instead of paying twice.
 */

export const PREVIEW_ROW_CAP = 3

export type PreviewEm = {
  transactional<T>(cb: (tem: PreviewEm) => Promise<T>): Promise<T>
  create<T extends object>(entityClass: new () => T, data: object): T
  persist(entity: object): unknown
  flush(): Promise<void>
  findOne<T extends object>(entityClass: new () => T, where: Record<string, unknown>): Promise<T | null>
}

export type PreviewRow = {
  entity_kind: 'person' | 'company' | 'opportunity'
  /** The person, business or conversation, as the provider named it. */
  title: string
  /** Headline, company, or the platform and place. Null when the row has none. */
  subtitle: string | null
  /** One sentence of why this row matched, taken from the returned evidence. */
  why: string | null
  /** Where it came from. Never synthesized: null when the provider gave none. */
  source_url: string | null
  /** The platform the row was observed on, or the adapter that found it. */
  source: string
  /** When Noli retrieved it (ISO), never when the post was written. */
  observed_at: string
}

export type PreviewQuote = {
  adapterId: string
  /** What the sample search is quoted at, in Noli credits. */
  estimatedCredits: number
  /** The same figure in dollars, for the "about $x" line before the click. */
  estimatedUsd: number
  rows: number
}

export type PreviewLaneResult = {
  status: 'ok' | 'no_result' | 'error' | 'ambiguous'
  adapterId: string
  rows: PreviewRow[]
  quote: PreviewQuote
  chargedCredits: number
  providerOperationId: string | null
  reconciliationRequired: boolean
  /** One honest line when there is nothing to show. */
  note: string | null
}

export class GtmPreviewError extends Error {
  constructor(
    public code: 'no_previewable_lane' | 'adapter_unavailable' | 'insufficient_credits' | 'quote_changed',
    message: string,
  ) {
    super(message)
    this.name = 'GtmPreviewError'
  }
}

/*
 * The lane a preview uses: the first batch in the plan's own adaptive order
 * that Noli can call on its own. Dependent-hydration batches are skipped
 * because they need a parent batch's output to exist, and a batch quoted at
 * zero candidates has nothing to sample.
 */
export function choosePreviewLane(plan: Pick<SourcePlanSuccess, 'adapterPlan'>): SourcePlanBatch | null {
  const eligible = plan.adapterPlan.filter((batch) => batch.maxCandidates > 0 && batch.adapter_id)
  if (eligible.length === 0) return null
  return [...eligible].sort((a, b) => (a.adaptiveOrder ?? 0) - (b.adaptiveOrder ?? 0))[0] ?? null
}

/*
 * Price the sample BEFORE the click, from the adapter's own quote for three
 * rows rather than by scaling the full-run figure down (many providers bill
 * per search, not per row, so a third of the rows is not a third of the fee).
 */
export function quotePreviewLane(
  adapter: SourceAdapter,
  batch: SourcePlanBatch,
  query: string,
  markupMultiplier: number = defaultMarkupMultiplier(),
): PreviewQuote {
  const rows = Math.min(PREVIEW_ROW_CAP, batch.maxCandidates)
  const quote = adapter.quote({
    signal_kind: batch.capability.signal_kind,
    entity_unit: batch.capability.entity_unit,
    geography: batch.capability.geography,
    query,
    provider_query: batch.providerQuery ?? undefined,
    max_candidates: rows,
  })
  // Never quote a sample above the full lane it is sampling.
  const estimatedCredits = Math.min(
    creditsForUnits(quote.provider_units, batch.quotedCreditsPerUnit, markupMultiplier),
    batch.estimatedCredits,
  )
  return {
    adapterId: batch.adapter_id,
    estimatedCredits,
    estimatedUsd: usdFromCredits(estimatedCredits),
    rows,
  }
}

function text(value: unknown, max = 200): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.replace(/\s+/g, ' ').trim()
  if (!trimmed) return null
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed
}

function firstUrl(candidate: Candidate): string | null {
  const direct = candidate.identity.urls?.find((url) => typeof url === 'string' && /^https?:\/\//i.test(url))
  if (direct) return direct
  const fromEvidence = candidate.evidence.find((row) => typeof row.source_url === 'string' && /^https?:\/\//i.test(row.source_url ?? ''))
  return fromEvidence?.source_url ?? null
}

/*
 * One provider row -> one display row. Deliberately narrow: a preview shows
 * who, why and where, never the full identity payload a paid candidate row
 * carries, so an unpaid sample can never be scraped into a lead list.
 */
export function shapePreviewRow(candidate: Candidate, adapterId: string, observedAt: Date): PreviewRow {
  const identity = candidate.identity
  const title = candidate.entity_kind === 'opportunity'
    ? text(identity.audience_description) ?? text(identity.name) ?? 'Public conversation'
    : text(identity.name) ?? text(identity.company) ?? 'Unnamed row'
  const subtitle = candidate.entity_kind === 'opportunity'
    ? text([identity.platform, identity.location].filter(Boolean).join(' · '), 120)
    : text([identity.title, identity.company].filter(Boolean).join(' at '), 120)
  const evidence = candidate.evidence[0] ?? null
  return {
    entity_kind: candidate.entity_kind,
    title,
    subtitle,
    why: text(evidence?.claim, 240),
    source_url: firstUrl(candidate),
    source: text(identity.platform, 60) ?? adapterId,
    observed_at: evidence?.observed_at ?? observedAt.toISOString(),
  }
}

export type PreviewLaneDeps = {
  em: PreviewEm
  ledger: GtmCreditLedger
  adapters: Record<string, SourceAdapter>
  plan: SourcePlanSuccess
  organizationId: string
  tenantId: string
  /** Canonical Noli Core org/user; the ledger settles against these, never the CRM ids. */
  noliOrgId: string
  noliUserId: string
  workspaceId: string
  playId: string
  /** The claimed daily slot: 'YYYY-MM-DD' plus the 1-based preview number. */
  claim: { day: string; slot: number }
  markupMultiplier?: number
  now?: () => Date
}

export async function previewLane(deps: PreviewLaneDeps): Promise<PreviewLaneResult> {
  const now = deps.now ?? (() => new Date())
  const markup = deps.markupMultiplier ?? defaultMarkupMultiplier()
  const batch = choosePreviewLane(deps.plan)
  if (!batch) {
    throw new GtmPreviewError('no_previewable_lane', 'This play has no source Noli can sample on its own')
  }
  const adapter = deps.adapters[batch.adapter_id]
  if (!adapter) {
    throw new GtmPreviewError('adapter_unavailable', 'The source this play would use is not enabled right now')
  }

  const quote = quotePreviewLane(adapter, batch, deps.plan.query, markup)
  // The claimed slot makes this deterministic: a retry after a lost response
  // re-reserves the SAME operation instead of buying a second sample.
  const idempotencyKey = `gtm:play-preview:${deps.workspaceId}:${deps.playId}:${deps.claim.day}:${deps.claim.slot}`

  let operationId: string
  try {
    const reserved = await deps.ledger.reserve({
      orgId: deps.noliOrgId,
      userId: deps.noliUserId,
      kind: 'source_search',
      provider: batch.adapter_id,
      estimatedCredits: quote.estimatedCredits,
      idempotencyKey,
      unitCostSnapshot: {
        unit: batch.billableUnit,
        provider_units: quote.rows,
        quoted_credits_per_unit: batch.quotedCreditsPerUnit,
        markup_multiplier: markup,
        price_version: batch.priceVersion,
        terms_version: batch.termsVersion,
      },
      fingerprint: {
        gtm_preview: true,
        workspace_id: deps.workspaceId,
        play_id: deps.playId,
        preview_day: deps.claim.day,
        preview_slot: deps.claim.slot,
        adapter_id: batch.adapter_id,
        max_candidates: quote.rows,
        descriptor_hash: batch.descriptorHash,
      },
    })
    operationId = reserved.operationId
    if (reserved.status !== 'reserved') {
      // An earlier attempt on this exact slot already contacted the provider.
      // Never call again: report it and let reconciliation close it out.
      return {
        status: 'ambiguous',
        adapterId: batch.adapter_id,
        rows: [],
        quote,
        chargedCredits: 0,
        providerOperationId: operationId,
        reconciliationRequired: true,
        note: 'An earlier preview of this play is still settling. Try again after it clears.',
      }
    }
  } catch (error) {
    if (error instanceof GtmCreditLedgerError && error.code === 'insufficient_credits') {
      throw new GtmPreviewError('insufficient_credits', error.message)
    }
    throw error
  }

  // Shadow row for reconciliation. research_run_id is null: a preview belongs
  // to no run, and the reconciliation sweeps key on the operation, not the run.
  let shadow = await deps.em.findOne(GtmProviderOperation, {
    noliCoreOperationId: operationId,
    organizationId: deps.organizationId,
    tenantId: deps.tenantId,
  })
  if (!shadow) {
    try {
      shadow = await deps.em.transactional(async (tem) => {
        const row = tem.create(GtmProviderOperation, {
          organizationId: deps.organizationId,
          tenantId: deps.tenantId,
          noliCoreOperationId: operationId,
          researchRunId: null,
          kind: 'source_search',
          provider: batch.adapter_id,
          localStatusMirror: 'reserved',
          requestedAt: now(),
        })
        tem.persist(row)
        await tem.flush()
        return row
      })
    } catch (error) {
      if (!(error instanceof UniqueConstraintViolationException)) {
        try {
          await deps.ledger.release(operationId)
        } catch (releaseError) {
          console.error('[gtm.preview] reservation left open', releaseError instanceof Error ? releaseError.message : releaseError)
        }
        throw error
      }
      shadow = await deps.em.findOne(GtmProviderOperation, {
        noliCoreOperationId: operationId,
        organizationId: deps.organizationId,
        tenantId: deps.tenantId,
      })
      if (!shadow) throw error
    }
  }

  const started = await deps.ledger.start(operationId)
  const shadowRow = shadow
  shadowRow.localStatusMirror = started.status
  await deps.em.transactional(async (tem) => {
    tem.persist(shadowRow)
    await tem.flush()
  })
  if (!started.startedNow) {
    return {
      status: 'ambiguous',
      adapterId: batch.adapter_id,
      rows: [],
      quote,
      chargedCredits: 0,
      providerOperationId: operationId,
      reconciliationRequired: true,
      note: 'An earlier preview of this play already reached the provider. Try again after it clears.',
    }
  }

  const result = await adapter.search({
    signal_kind: batch.capability.signal_kind,
    entity_unit: batch.capability.entity_unit,
    geography: batch.capability.geography,
    query: deps.plan.query,
    provider_query: batch.providerQuery ?? undefined,
    max_candidates: quote.rows,
    max_charge_usd: providerSpendCapUsd(quote.estimatedCredits, markup),
  })

  const observedAt = now()
  const receipt = (result.receipt ?? null) as Record<string, unknown> | null
  let chargedCredits = 0
  let intended: GtmSettleOutcome | 'mark_ambiguous'
  if ((result.status === 'ok' || result.status === 'partial' || result.status === 'no_result') && result.cost_units == null) {
    // A completed call with no final cost is an unknown charge, never zero.
    intended = 'mark_ambiguous'
  } else if (result.status === 'ok' || result.status === 'partial') {
    chargedCredits = Math.min(
      creditsForUnits(result.cost_units ?? 0, batch.quotedCreditsPerUnit, markup),
      quote.estimatedCredits,
    )
    intended = result.status === 'partial' ? 'partially_charged' : 'charged'
  } else if (result.status === 'no_result') {
    chargedCredits = Math.min(
      creditsForUnits(result.cost_units ?? 0, batch.quotedCreditsPerUnit, markup),
      quote.estimatedCredits,
    )
    intended = adapter.descriptor.cost_model.pay_on_found ? 'refunded' : 'charged'
  } else if (result.status === 'ambiguous') {
    intended = 'mark_ambiguous'
  } else if (result.cost_units != null && result.cost_units > 0) {
    chargedCredits = Math.min(
      creditsForUnits(result.cost_units, batch.quotedCreditsPerUnit, markup),
      quote.estimatedCredits,
    )
    intended = 'charged'
  } else {
    intended = 'refunded'
  }

  let reconciliationRequired = false
  let ledgerStatus = shadowRow.localStatusMirror ?? 'provider_started'
  try {
    if (intended === 'mark_ambiguous') {
      ledgerStatus = await deps.ledger.markAmbiguous(operationId, {
        error: result.error ?? 'ambiguous preview provider outcome',
        receipt,
      })
      reconciliationRequired = true
    } else {
      ledgerStatus = await deps.ledger.settle(operationId, intended, chargedCredits, receipt)
    }
  } catch (error) {
    reconciliationRequired = true
    console.error('[gtm.preview] settlement pending', error instanceof Error ? error.message : error)
  }

  await deps.em.transactional(async (tem) => {
    shadowRow.localStatusMirror = ledgerStatus
    // The provider payload itself is NOT retained: nothing downstream will
    // ever materialize a preview into candidates, so keeping the rows would
    // be storage of customer-visible data with no purpose.
    shadowRow.receipt = {
      ...(receipt ?? {}),
      gtm_preview: {
        schema_version: 'gtm-preview-v1',
        workspace_id: deps.workspaceId,
        play_id: deps.playId,
        preview_day: deps.claim.day,
        preview_slot: deps.claim.slot,
        observed_at: observedAt.toISOString(),
        adapter_status: result.status,
        intended_ledger_action: intended,
        charged_credits: chargedCredits,
        output_count: Array.isArray(result.data) ? result.data.length : 0,
        provider_error: result.error ?? null,
      },
    }
    shadowRow.settledAt = reconciliationRequired ? null : observedAt
    tem.persist(shadowRow)
    await tem.flush()
  })

  const rows = (Array.isArray(result.data) ? result.data : [])
    .slice(0, quote.rows)
    .map((candidate) => shapePreviewRow(candidate, batch.adapter_id, observedAt))

  const status: PreviewLaneResult['status'] = intended === 'mark_ambiguous'
    ? 'ambiguous'
    : result.status === 'error'
      ? 'error'
      : rows.length === 0
        ? 'no_result'
        : 'ok'

  return {
    status,
    adapterId: batch.adapter_id,
    rows,
    quote,
    chargedCredits,
    providerOperationId: operationId,
    reconciliationRequired,
    note: status === 'ok'
      ? null
      : status === 'no_result'
        ? 'This source returned nothing for the sample. A full run searches more sources and more pages.'
        : status === 'error'
          ? 'The source could not be reached for the sample. Nothing was charged for an empty result.'
          : 'The sample outcome is unconfirmed and has been parked for reconciliation. Noli will not retry it automatically.',
  }
}
