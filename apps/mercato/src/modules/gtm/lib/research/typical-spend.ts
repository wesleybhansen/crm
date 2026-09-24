/*
 * What a run usually costs, next to the most it can cost (2026-09-24 audit:
 * $99 quoted against $36.51 actually spent, which made the approve-spend step
 * look scary). The quote stays the hard cap the customer approves; this adds
 * "usually about", from the platform's own history: per source, the share of
 * its quote that finished runs were actually charged (sources stop early once
 * enough leads are accepted). A source needs at least MIN_RUNS finished runs;
 * otherwise the platform-wide ratio is used, and with too little history at
 * all there is no estimate. Aggregates only: no customer data leaves this.
 */

export const TYPICAL_WINDOW_DAYS = 120
export const MIN_RUNS = 5

export type SpendHistory = { ratios: Map<string, number>; overall: number | null }
type PlanBatch = { adapter_id: string; estimatedCredits: number }

export function typicalCredits(adapterPlan: PlanBatch[], history: SpendHistory): number | null {
  if (!adapterPlan.length) return null
  let total = 0
  let max = 0
  for (const batch of adapterPlan) {
    const ratio = history.ratios.get(batch.adapter_id) ?? history.overall
    if (ratio == null) return null
    total += batch.estimatedCredits * Math.min(1, Math.max(0.05, ratio))
    max += batch.estimatedCredits
  }
  return Math.min(max, Math.round(total))
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

export const SPEND_HISTORY_SQL = `
with q as (
  select r.id, y->>'adapter_id' as adapter, sum((y->>'estimatedCredits')::numeric) as quoted
  from gtm_research_runs r, jsonb_array_elements(r.provider_plan->'adapterPlan') y
  where r.status in ('completed', 'failed') and r.deleted_at is null and r.created_at > now() - interval '${TYPICAL_WINDOW_DAYS} days'
  group by 1, 2
), c as (
  select r.id, x->>'adapter_id' as adapter, sum(coalesce((x->>'charged_credits')::numeric, 0)) as charged
  from gtm_research_runs r, jsonb_array_elements(r.provider_plan->'execution'->'batches') x
  where r.status in ('completed', 'failed') and r.deleted_at is null and r.created_at > now() - interval '${TYPICAL_WINDOW_DAYS} days'
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
