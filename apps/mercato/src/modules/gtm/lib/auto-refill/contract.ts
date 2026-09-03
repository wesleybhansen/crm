import {
  canonicalHash,
} from '../campaign/approve'
import {
  isValidTimeZone,
  normalizeAutoRefillSettings,
  type CampaignAutoRefillSettings,
} from '../campaign/build'

export const GTM_AUTO_REFILL_QUEUE = 'gtm-auto-refill'
// Campaign statuses under which auto-refill may activate or run a cycle.
// 'paused' is deliberately absent (review 2026-09-02, M13): pausing a
// campaign must pause its provider spend too.
export const AUTO_REFILL_CAMPAIGN_STATUSES: readonly string[] = ['approved', 'launching', 'active']
// A cycle still 'running' after this long has lost its worker (the process
// died or the failure path itself threw). The sweep marks it for
// reconciliation so escrowed credits are never silently locked.
export const AUTO_REFILL_STALE_CYCLE_MS = 6 * 60 * 60 * 1000
export const AUTO_REFILL_POLICY_SCHEMA_VERSION = 'gtm-auto-refill-policy-v1'
export const AUTO_REFILL_CYCLE_SCHEMA_VERSION = 'gtm-auto-refill-cycle-v1'

export type ApprovedAutoRefillConfig = {
  autoRefill: CampaignAutoRefillSettings
  timezone: string
}

export class GtmAutoRefillError extends Error {
  constructor(
    public readonly code:
      | 'campaign_not_found'
      | 'campaign_not_approved'
      | 'policy_not_found'
      | 'auto_refill_not_configured'
      | 'stale_campaign'
      | 'plan_changed'
      | 'daily_credit_cap_too_low'
      | 'scheduler_unavailable'
      | 'policy_changed'
      | 'identity_changed',
    message: string,
  ) {
    super(message)
    this.name = 'GtmAutoRefillError'
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function parseApprovedAutoRefillConfig(snapshot: unknown): ApprovedAutoRefillConfig {
  const root = record(snapshot)
  const settings = record(root?.settings)
  const autoRefill = normalizeAutoRefillSettings(record(settings?.auto_refill))
  if (!autoRefill.enabled || !autoRefill.plan_hash) {
    throw new GtmAutoRefillError(
      'auto_refill_not_configured',
      'Approve a campaign version with auto-refill enabled before activating it',
    )
  }
  const sendWindow = record(settings?.send_window)
  const timezone = typeof sendWindow?.timezone === 'string'
    ? sendWindow.timezone.trim()
    : ''
  if (!timezone || !isValidTimeZone(timezone)) {
    throw new GtmAutoRefillError(
      'auto_refill_not_configured',
      'The approved campaign does not contain a valid auto-refill timezone',
    )
  }
  return { autoRefill, timezone }
}

export type AutoRefillPolicyHashInput = {
  policyId: string
  organizationId: string
  tenantId: string
  workspaceId: string
  playId: string
  campaignId: string
  campaignVersionId: string
  representedNoliUserId: string
  noliOrganizationId: string
  requestedByUserId: string
  campaignContentHash: string
  planHash: string
  targetAcceptedPerDay: number
  maxRawCandidatesPerDay: number
  maxCreditsPerDay: number
  runHourLocal: number
  timezone: string
}

export function buildAutoRefillPolicyHash(input: AutoRefillPolicyHashInput): string {
  return canonicalHash({
    schema_version: AUTO_REFILL_POLICY_SCHEMA_VERSION,
    policy_id: input.policyId,
    organization_id: input.organizationId,
    tenant_id: input.tenantId,
    workspace_id: input.workspaceId,
    play_id: input.playId,
    campaign_id: input.campaignId,
    campaign_version_id: input.campaignVersionId,
    represented_noli_user_id: input.representedNoliUserId,
    noli_organization_id: input.noliOrganizationId,
    requested_by_user_id: input.requestedByUserId,
    campaign_content_hash: input.campaignContentHash,
    plan_hash: input.planHash,
    limits: {
      target_accepted_per_day: input.targetAcceptedPerDay,
      max_raw_candidates_per_day: input.maxRawCandidatesPerDay,
      max_credits_per_day: input.maxCreditsPerDay,
    },
    schedule: {
      weekdays: [1, 2, 3, 4, 5],
      run_hour_local: input.runHourLocal,
      timezone: input.timezone,
    },
  })
}

export function autoRefillScheduleCron(runHourLocal: number): string {
  if (!Number.isInteger(runHourLocal) || runHourLocal < 0 || runHourLocal > 23) {
    throw new RangeError('runHourLocal must be an integer between 0 and 23')
  }
  return `0 ${runHourLocal} * * 1-5`
}

export function localDateInTimeZone(now: Date, timezone: string): string {
  if (!isValidTimeZone(timezone)) throw new RangeError('timezone must be a valid IANA timezone')
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value
  const year = read('year')
  const month = read('month')
  const day = read('day')
  if (!year || !month || !day) throw new RangeError('unable to derive local date')
  return `${year}-${month}-${day}`
}

export type GtmAutoRefillJob = {
  policyId: string
  organizationId: string
  tenantId: string
  _idempotencyKey?: string
}
