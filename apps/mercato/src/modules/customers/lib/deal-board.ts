/**
 * The deals pipeline board's stages and columns.
 *
 * Stages are the organization's own list (business profile
 * `pipeline_stages`), the same list the settings page edits; the New Deal
 * dialog and the board both read it through dealStageNames so they never
 * disagree. A deal sits in the column whose name matches its
 * `pipeline_stage` (case-insensitive). Won and lost deals sit in the won or
 * lost column. An open deal whose stage is not in the list (renamed before
 * renames carried deals, or set through the API) lands in a trailing "Other
 * stages" column instead of vanishing.
 *
 * Pure and dependency-free apart from the status vocabulary, so client
 * components import it.
 */
import {
  classifyDealStage,
  dealStatusOutcome,
  type DealOutcome,
} from '@open-mercato/core/modules/customers/lib/dealStatus'

export const DEFAULT_DEAL_STAGES: readonly string[] = ['New Lead', 'Contacted', 'Qualified', 'Proposal', 'Negotiation', 'Won', 'Lost']

export const OTHER_STAGES_COLUMN_KEY = '__other_stages__'
export const OTHER_STAGES_COLUMN_NAME = 'Other stages'

/** Stage names from a business profile's `pipeline_stages` (JSON text or array of names or `{ name }`); null when fewer than two. */
export function parsePipelineStageNames(raw: unknown): string[] | null {
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!Array.isArray(parsed)) return null
  const names = parsed
    .map((stage) => (typeof stage === 'string' ? stage : (stage as { name?: unknown } | null)?.name))
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
    .map((name) => name.trim())
  return names.length >= 2 ? names : null
}

/** The organization's deal stages, or the defaults when it has not set at least two. */
export function dealStageNames(profile: { pipeline_stages?: unknown } | null | undefined): string[] {
  return parsePipelineStageNames(profile?.pipeline_stages) ?? [...DEFAULT_DEAL_STAGES]
}

/** The stages a new deal can start in: every stage that is not a won or lost stage. */
export function openDealStageNames(stageNames: readonly string[]): string[] {
  const open = stageNames.filter((name) => classifyDealStage(name) === null)
  return open.length > 0 ? open : [...stageNames]
}

export type BoardDeal = {
  id: string
  title: string
  value_amount: number | string | null
  pipeline_stage: string | null
  status: string | null
  contact_name?: string | null
  updated_at: string
}

export type DealColumnKind = 'open' | 'won' | 'lost' | 'other'

export type DealColumn<T extends BoardDeal = BoardDeal> = {
  /** Unique column id: the stage name, or OTHER_STAGES_COLUMN_KEY. */
  key: string
  name: string
  kind: DealColumnKind
  deals: T[]
  count: number
  totalValue: number
  /** Deals in this column that are still open, and their value (the board's pipeline totals count only these). */
  openCount: number
  openValue: number
}

function stageKey(name: string | null | undefined): string {
  return String(name ?? '').trim().toLowerCase()
}

function amount(deal: BoardDeal): number {
  return Number(deal.value_amount) || 0
}

export function buildDealBoard<T extends BoardDeal>(stageNames: readonly string[], deals: readonly T[]): DealColumn<T>[] {
  const columns: DealColumn<T>[] = stageNames.map((name) => ({
    key: name,
    name,
    kind: classifyDealStage(name) ?? 'open',
    deals: [],
    count: 0,
    totalValue: 0,
    openCount: 0,
    openValue: 0,
  }))
  const byName = new Map<string, DealColumn<T>>()
  for (const column of columns) {
    const key = stageKey(column.name)
    if (!byName.has(key)) byName.set(key, column)
  }
  const other: DealColumn<T> = {
    key: OTHER_STAGES_COLUMN_KEY,
    name: OTHER_STAGES_COLUMN_NAME,
    kind: 'other',
    deals: [],
    count: 0,
    totalValue: 0,
    openCount: 0,
    openValue: 0,
  }

  const place = (column: DealColumn<T>, deal: T, outcome: DealOutcome) => {
    column.deals.push(deal)
    column.count += 1
    column.totalValue += amount(deal)
    if (outcome === 'open') {
      column.openCount += 1
      column.openValue += amount(deal)
    }
  }

  for (const deal of deals) {
    const outcome = dealStatusOutcome(deal.status)
    const named = byName.get(stageKey(deal.pipeline_stage))
    if (outcome === 'open') {
      place(named ?? other, deal, outcome)
      continue
    }
    // Won/lost: its own stage when that is a column of the same kind, else
    // the first won (or lost) column; a board with none leaves it off.
    const target = named && named.kind === outcome ? named : columns.find((column) => column.kind === outcome)
    if (target) place(target, deal, outcome)
  }

  return other.count > 0 ? [...columns, other] : columns
}
