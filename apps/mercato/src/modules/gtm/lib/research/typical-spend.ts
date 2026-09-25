/*
 * What a run usually costs, next to the most it can cost (2026-09-24 audit:
 * $99 quoted against $36.51 actually spent, which made the approve-spend step
 * look scary). The quote stays the hard cap the customer approves; this adds
 * "usually about", from the platform's own history: per source, the share of
 * its quote that finished runs were actually charged (sources stop early once
 * enough leads are accepted). A source needs at least MIN_RUNS finished runs;
 * otherwise the platform-wide ratio is used, and with too little platform
 * history as well, DEFAULT_TYPICAL_RATIO. Aggregates only: no customer data
 * leaves this.
 *
 * The quote (estimated_credits) remains the hard cap: the ledger reservation
 * and the provider's max_charge_usd are derived from it, never from this.
 */

import { usdFromCredits } from '../credits/markup'

export const TYPICAL_WINDOW_DAYS = 120
export const MIN_RUNS = 5
/**
 * Fallback share of the quote a run is charged when there is not enough
 * history anywhere: the 2026-09-24 audit, $36.51 charged on $99 quoted.
 */
export const DEFAULT_TYPICAL_RATIO = 0.37

export type SpendHistory = { ratios: Map<string, number>; overall: number | null }
type PlanBatch = { adapter_id: string; estimatedCredits: number }

/** Where the typical figure came from, weakest source used by any batch. */
export type TypicalBasis = 'source_history' | 'platform_history' | 'default'
export type TypicalEstimate = { credits: number; usd: number; basis: TypicalBasis }

const BASIS_RANK: Record<TypicalBasis, number> = { source_history: 0, platform_history: 1, default: 2 }

export function typicalEstimate(adapterPlan: PlanBatch[], history: SpendHistory): TypicalEstimate | null {
  if (!adapterPlan.length) return null
  let total = 0
  let max = 0
  let basis: TypicalBasis = 'source_history'
  for (const batch of adapterPlan) {
    const own = history.ratios.get(batch.adapter_id)
    let ratio: number
    let used: TypicalBasis
    if (own != null) { ratio = own; used = 'source_history' }
    else if (history.overall != null) { ratio = history.overall; used = 'platform_history' }
    else { ratio = DEFAULT_TYPICAL_RATIO; used = 'default' }
    if (BASIS_RANK[used] > BASIS_RANK[basis]) basis = used
    const credits = Number(batch.estimatedCredits) || 0
    total += credits * Math.min(1, Math.max(0.05, ratio))
    max += credits
  }
  const credits = Math.min(max, Math.round(total))
  return { credits, usd: usdFromCredits(credits), basis }
}

/** The typical figure in credits (null only for an empty plan). */
export function typicalCredits(adapterPlan: PlanBatch[], history: SpendHistory): number | null {
  return typicalEstimate(adapterPlan, history)?.credits ?? null
}

/**
 * The typical fields every quote-bearing response carries beside the cap
 * (estimated_credits). Shape is stable: nulls when the plan is empty.
 */
export function typicalFields(adapterPlan: PlanBatch[], history: SpendHistory): {
  typical_credits: number | null
  typical_usd: number | null
  typical_basis: TypicalBasis | null
} {
  const t = typicalEstimate(adapterPlan, history)
  return { typical_credits: t?.credits ?? null, typical_usd: t?.usd ?? null, typical_basis: t?.basis ?? null }
}

type Row = { adapter: string; runs: number | string; charged: number | string; quoted: number | string }

export function spendHistoryFromRows(rows: Row[]): SpendHistory {
  const ratios = new Map<string, number>()
  let charged = 0
  let quoted = 0
  let runs = 0
  for (const row of rows) {
    const c = Number(row.charged) || 0
    const q = Number(row.quoted) || 0
    const n = Number(row.runs) || 0
    charged += c; quoted += q; runs += n
    if (n >= MIN_RUNS && q > 0) ratios.set(row.adapter, c / q)
  }
  return { ratios, overall: runs >= MIN_RUNS * 2 && quoted > 0 ? charged / quoted : null }
}

// Completed runs only: a failed run stops early and charges a fraction of its
// quote, which dragged the ratio down and understated "usually about"
// (2026-09-25 review, LOW).
export const SPEND_HISTORY_SQL = `
with q as (
  select r.id, y->>'adapter_id' as adapter, sum((y->>'estimatedCredits')::numeric) as quoted
  from gtm_research_runs r, jsonb_array_elements(r.provider_plan->'adapterPlan') y
  where r.status = 'completed' and r.deleted_at is null and r.created_at > now() - interval '${TYPICAL_WINDOW_DAYS} days'
  group by 1, 2
), c as (
  select r.id, x->>'adapter_id' as adapter, sum(coalesce((x->>'charged_credits')::numeric, 0)) as charged
  from gtm_research_runs r, jsonb_array_elements(r.provider_plan->'execution'->'batches') x
  where r.status = 'completed' and r.deleted_at is null and r.created_at > now() - interval '${TYPICAL_WINDOW_DAYS} days'
  group by 1, 2
)
select q.adapter, count(*) as runs, sum(coalesce(c.charged, 0)) as charged, sum(q.quoted) as quoted
from q left join c on c.id = q.id and c.adapter = q.adapter
group by q.adapter`

let cache: { at: number; history: SpendHistory } | null = null

/** History across all runs, cached for ten minutes per process. Never throws. */
export async function loadSpendHistory(em: { getConnection(): { execute(sql: string): Promise<unknown[]> } }): Promise<SpendHistory> {
  if (cache && Date.now() - cache.at < 10 * 60_000) return cache.history
  try {
    const rows = await em.getConnection().execute(SPEND_HISTORY_SQL) as Row[]
    cache = { at: Date.now(), history: spendHistoryFromRows(rows) }
    return cache.history
  } catch (error) {
    console.error('[gtm.typical-spend] history unavailable', error instanceof Error ? error.message : error)
    return { ratios: new Map(), overall: null }
  }
}

/*
 * Previews: a fixed small sample that does not stop early, so the ratio above
 * does not apply. Their typical cost is what previews of the same source were
 * actually charged (audit events), never above the preview's own quote.
 */
export type PreviewHistory = Map<string, number>

type PreviewRow = { adapter: string; runs: number | string; avg_charged: number | string | null }

export function previewHistoryFromRows(rows: PreviewRow[]): PreviewHistory {
  const out: PreviewHistory = new Map()
  for (const row of rows) {
    const n = Number(row.runs) || 0
    const avg = Number(row.avg_charged)
    if (n >= MIN_RUNS && Number.isFinite(avg) && avg >= 0) out.set(row.adapter, avg)
  }
  return out
}

export function typicalPreviewCredits(adapterId: string, quotedCredits: number, history: PreviewHistory): number | null {
  const avg = history.get(adapterId)
  if (avg == null) return null
  return Math.min(quotedCredits, Math.round(avg))
}

export const PREVIEW_HISTORY_SQL = `
select metadata->>'adapter_id' as adapter, count(*) as runs, avg(coalesce((metadata->>'charged_credits')::numeric, 0)) as avg_charged
from gtm_audit_events
where action = 'gtm.play.previewed' and metadata->>'status' in ('ok', 'no_result')
  and created_at > now() - interval '${TYPICAL_WINDOW_DAYS} days'
group by 1`

let previewCache: { at: number; history: PreviewHistory } | null = null

/** Preview history across all orgs, cached ten minutes. Never throws. */
export async function loadPreviewHistory(em: { getConnection(): { execute(sql: string): Promise<unknown[]> } }): Promise<PreviewHistory> {
  if (previewCache && Date.now() - previewCache.at < 10 * 60_000) return previewCache.history
  try {
    const rows = await em.getConnection().execute(PREVIEW_HISTORY_SQL) as PreviewRow[]
    previewCache = { at: Date.now(), history: previewHistoryFromRows(rows) }
    return previewCache.history
  } catch (error) {
    console.error('[gtm.typical-spend] preview history unavailable', error instanceof Error ? error.message : error)
    return new Map()
  }
}
