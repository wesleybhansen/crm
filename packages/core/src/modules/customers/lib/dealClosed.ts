/**
 * When a deal counts as closed (won), and the one event that says it just
 * became so.
 *
 * Deals close three ways: the deal form / API (customers.deals.update), a drag
 * into a won-named column on the pipeline board (PUT /api/ext/deals) and a
 * pipeline automation (pipeline_automation/executor). Each of them knows the
 * deal's state before and after its write, so each calls
 * emitDealClosedIfTransitioned once. Subscribers then see exactly one
 * `customers.deal.closed` per transition, never one per later edit of a deal
 * that was already closed.
 *
 * Pure and dependency-free: the executor is reachable from worker bundles.
 */

export const DEAL_CLOSED_EVENT_ID = 'customers.deal.closed' as const

export type DealCloseState = {
  status?: string | null
  pipelineStage?: string | null
}

export type DealClosedEventPayload = {
  id: string
  organizationId: string
  tenantId: string
  closedAt: string
  status: string | null
  stage: string | null
}

type EventBusLike = {
  emitEvent?: (event: string, payload: Record<string, unknown>, options?: { persistent?: boolean }) => Promise<unknown> | unknown
} | null | undefined

const WON_STATUSES = new Set(['win', 'won', 'closed', 'closed won', 'sold'])
const LOST_STATUSES = new Set(['loose', 'lost', 'lose', 'closed lost'])
const LOST_WORDS = /\b(lost|loose|lose|dead|cancell?ed|withdrawn|expired|fell through)\b/
const WON_WORDS = /\b(won|closed|sold)\b/

function normalize(value: string | null | undefined): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[_\-/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * True when the deal is won or closed: a won/closed status, or a pipeline
 * stage named Won / Closed / Closed Won / Sold. A lost-looking stage or status
 * ("Closed Lost", "Lost", "Fell through") is never closed-won.
 */
export function isDealClosedWon(deal: DealCloseState | null | undefined): boolean {
  if (!deal) return false
  const status = normalize(deal.status)
  const stage = normalize(deal.pipelineStage)
  if (LOST_STATUSES.has(status) || LOST_WORDS.test(stage) || LOST_WORDS.test(status)) return false
  if (WON_STATUSES.has(status)) return true
  return WON_WORDS.test(stage)
}

export function isDealClosedTransition(before: DealCloseState | null | undefined, after: DealCloseState | null | undefined): boolean {
  return !isDealClosedWon(before) && isDealClosedWon(after)
}

/**
 * Emit `customers.deal.closed` when the write moved the deal into a won/closed
 * state. Never throws: a failed emit must not fail the deal update. Returns
 * whether an event was emitted.
 */
export async function emitDealClosedIfTransitioned(
  bus: EventBusLike,
  args: {
    id: string
    organizationId: string
    tenantId: string
    before: DealCloseState | null | undefined
    after: DealCloseState
    closedAt?: Date
  },
): Promise<boolean> {
  if (!isDealClosedTransition(args.before, args.after)) return false
  if (!bus?.emitEvent) return false
  const payload: DealClosedEventPayload = {
    id: args.id,
    organizationId: args.organizationId,
    tenantId: args.tenantId,
    closedAt: (args.closedAt ?? new Date()).toISOString(),
    status: args.after.status ?? null,
    stage: args.after.pipelineStage ?? null,
  }
  try {
    await bus.emitEvent(DEAL_CLOSED_EVENT_ID, payload, { persistent: true })
    return true
  } catch {
    return false
  }
}
