/**
 * Deal status vocabulary: the values stored in `customer_deals.status`, how
 * the legacy spellings read, and what status a move to a pipeline stage
 * implies.
 *
 * Stored values: 'open', 'win' (won) and 'lost'. Older rows (and older
 * writers) used 'won', 'loose' (the original status dictionary's misspelling
 * of lost) and 'lose'. Writers store canonicalDealStatus(); readers that
 * count outcomes use WON_STATUS_VALUES / LOST_STATUS_VALUES so a legacy row
 * still counts.
 *
 * Pure and dependency-free: the pipeline automation executor, which runs in
 * worker bundles, imports it, and so do client components.
 */

export const DEAL_STATUS_OPEN = 'open'
export const DEAL_STATUS_WON = 'win'
export const DEAL_STATUS_LOST = 'lost'

/** Stored status values that mean the deal was won (canonical first). */
export const WON_STATUS_VALUES: readonly string[] = ['win', 'won']
/** Stored status values that mean the deal was lost (canonical first; 'loose' and 'lose' are legacy). */
export const LOST_STATUS_VALUES: readonly string[] = ['lost', 'loose', 'lose']

export type DealOutcome = 'won' | 'lost' | 'open'
export type DealStageOutcome = 'won' | 'lost' | null

const WON_STATUS_FORMS = new Set([...WON_STATUS_VALUES, 'closed won'])
const LOST_STATUS_FORMS = new Set([...LOST_STATUS_VALUES, 'closed lost'])

/* Same vocabulary as isDealClosedWon (dealClosed.ts), so a stage the board
 * marks won is also the stage that fires `customers.deal.closed`. A lost word
 * wins over a won word ("Closed Lost"). */
const STAGE_LOST_WORDS = /\b(lost|loose|lose|dead|cancell?ed|withdrawn|expired|fell through)\b/
const STAGE_WON_WORDS = /\b(won|closed|sold)\b/

function normalize(value: string | null | undefined): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[_\-/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 'won', 'lost' or 'open' for a stored status; anything that is not a won or lost spelling reads as open. */
export function dealStatusOutcome(status: string | null | undefined): DealOutcome {
  const normalized = normalize(status)
  if (WON_STATUS_FORMS.has(normalized)) return 'won'
  if (LOST_STATUS_FORMS.has(normalized)) return 'lost'
  return 'open'
}

/**
 * The value to store for a status a caller sent: won spellings become 'win',
 * lost spellings (including the legacy 'loose') become 'lost', anything else
 * is kept as sent.
 */
export function canonicalDealStatus(status: string): string {
  const outcome = dealStatusOutcome(status)
  if (outcome === 'won') return DEAL_STATUS_WON
  if (outcome === 'lost') return DEAL_STATUS_LOST
  return status
}

/** Whether a pipeline stage name means won ("Won", "Closed", "Sold"), lost ("Lost", "Closed Lost", "Fell through") or neither. */
export function classifyDealStage(stage: string | null | undefined): DealStageOutcome {
  const normalized = normalize(stage)
  if (!normalized) return null
  if (STAGE_LOST_WORDS.test(normalized)) return 'lost'
  if (STAGE_WON_WORDS.test(normalized)) return 'won'
  return null
}

/**
 * The status a deal should get when it moves to `targetStage` and the caller
 * did not send a status: a won stage makes it won, a lost stage lost, and an
 * ordinary stage reopens a deal that was won or lost. Returns null when the
 * current status already fits (other statuses, e.g. 'in_progress', are kept
 * on a move between ordinary stages).
 */
export function statusForStageMove(currentStatus: string | null | undefined, targetStage: string | null | undefined): string | null {
  const target = classifyDealStage(targetStage)
  const current = dealStatusOutcome(currentStatus)
  if (target === 'won') return current === 'won' ? null : DEAL_STATUS_WON
  if (target === 'lost') return current === 'lost' ? null : DEAL_STATUS_LOST
  return current === 'open' ? null : DEAL_STATUS_OPEN
}

/** Won share of decided deals, as a whole percent; 0 when nothing was decided. */
export function winRatePercent(won: number, lost: number): number {
  const decided = won + lost
  return decided > 0 ? Math.round((won / decided) * 100) : 0
}
