import { GtmCampaignError, type CampaignEm, type GtmCtx } from './campaign/build'
import { GtmAuditEvent, GtmWorkspace } from '../data/entities'

/*
 * Workspace-level GTM settings stored in gtm_workspaces.settings (jsonb).
 *
 * settings.postal_address is the CUSTOMER organization's business postal
 * address. CAN-SPAM requires the sender's valid physical postal address in
 * every commercial email, and for GTM outreach the sender is the customer's
 * org (their mailbox, their campaign), never Noli. The address is:
 *   - a single free-form string, trimmed, capped at 300 characters
 *   - empty / whitespace-only = unset (the key is removed, not stored as '')
 *   - required before a campaign can be APPROVED (lib/campaign/approve.ts)
 *   - rechecked at send time (lib/execute/send.ts) so clearing it after
 *     approval fails sends closed instead of shipping non-compliant mail
 *   - rendered into the compliance footer of every message body
 *     (lib/campaign/render.ts), so it is covered by the frozen content hash
 *
 * settings.duplicate_plays_dismissed is the signature of the duplicate-play
 * grouping the customer has already said "no thanks" to. The hub computes the
 * grouping and its signature; the server only remembers the string, so the
 * prompt comes back when the duplicates actually change and never when the
 * same ones are simply re-rendered. Dismissal is a preference, not a right:
 * it never hides a play, only the merge prompt.
 *
 * settings.play_preview_quota is the per-UTC-day counter behind dry-lane
 * previews ({ day: 'YYYY-MM-DD', used: n }). Previews call a real provider,
 * so they cost real money: three per workspace per day (owner decision
 * 2026-09-12). The day rolls over by being a different string, so no sweep
 * or cron is needed and a stale counter from last week reads as zero used.
 */

export const POSTAL_ADDRESS_MAX_LENGTH = 300

// Owner decision 2026-09-12: three dry-lane previews per workspace per day.
export const PLAY_PREVIEW_DAILY_LIMIT = 3

// Signatures are opaque to the server; bound so settings cannot become a
// scratch pad.
export const DUPLICATE_DISMISSAL_MAX_LENGTH = 200

// Read the workspace's postal address; unset / blank / non-string -> null.
export function readWorkspacePostalAddress(
  workspace: Pick<GtmWorkspace, 'settings'> | null | undefined,
): string | null {
  const settings = (workspace?.settings ?? {}) as Record<string, unknown>
  const raw = settings.postal_address
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed ? trimmed : null
}

// Normalize a caller-supplied postal address: trim, empty -> null (unset),
// over-cap -> typed error (never silently truncated).
export function normalizePostalAddress(input: unknown): string | null {
  if (input == null) return null
  if (typeof input !== 'string') {
    throw new GtmCampaignError('invalid_settings', 'postal_address must be a string')
  }
  const trimmed = input.trim()
  if (!trimmed) return null
  if (trimmed.length > POSTAL_ADDRESS_MAX_LENGTH) {
    throw new GtmCampaignError(
      'invalid_settings',
      `postal_address must be at most ${POSTAL_ADDRESS_MAX_LENGTH} characters`,
    )
  }
  return trimmed
}

export type UpdateWorkspacePostalAddressResult = {
  workspace: GtmWorkspace
  postalAddress: string | null
}

// Write settings.postal_address (or remove it when the input is empty),
// self-scoped by org/tenant, with an audit event in the same transaction.
export async function updateWorkspacePostalAddress(
  em: CampaignEm,
  ctx: GtmCtx,
  workspaceId: string,
  input: unknown,
): Promise<UpdateWorkspacePostalAddressResult> {
  const postalAddress = normalizePostalAddress(input)
  const workspace = await em.findOne(GtmWorkspace, {
    id: workspaceId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!workspace) {
    throw new GtmCampaignError('workspace_not_found', 'Workspace not found')
  }

  await em.transactional(async (tem) => {
    const settings = { ...((workspace.settings ?? {}) as Record<string, unknown>) }
    if (postalAddress) settings.postal_address = postalAddress
    else delete settings.postal_address
    workspace.settings = settings
    tem.persist(workspace)
    const audit = tem.create(GtmAuditEvent, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      actor: 'user_id',
      actorUserId: ctx.userId,
      action: 'gtm.workspace.settings_updated',
      objectType: 'gtm_workspace',
      objectId: workspace.id,
      requestId: ctx.requestId ?? null,
      // Redacted: presence and length only, never the address text itself.
      metadata: {
        setting: 'postal_address',
        postal_address_set: postalAddress != null,
        postal_address_length: postalAddress?.length ?? 0,
      },
    })
    tem.persist(audit)
    await tem.flush()
  })

  return { workspace, postalAddress }
}

// ---------------------------------------------------------------------------
// Duplicate-play merge prompt: the dismissal the customer already made
// ---------------------------------------------------------------------------

// Read the dismissed duplicate-grouping signature; unset / blank / non-string
// -> null, which means "show the prompt if there are duplicates".
export function readDuplicateDismissal(
  workspace: Pick<GtmWorkspace, 'settings'> | null | undefined,
): string | null {
  const settings = (workspace?.settings ?? {}) as Record<string, unknown>
  const raw = settings.duplicate_plays_dismissed
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed ? trimmed : null
}

// Normalize a caller-supplied signature: trim, empty -> null (re-arm the
// prompt), over-cap -> typed error (never silently truncated, or a truncated
// signature would silently stop matching and the prompt would never settle).
export function normalizeDuplicateDismissal(input: unknown): string | null {
  if (input == null) return null
  if (typeof input !== 'string') {
    throw new GtmCampaignError('invalid_settings', 'signature must be a string')
  }
  const trimmed = input.trim()
  if (!trimmed) return null
  if (trimmed.length > DUPLICATE_DISMISSAL_MAX_LENGTH) {
    throw new GtmCampaignError(
      'invalid_settings',
      `signature must be at most ${DUPLICATE_DISMISSAL_MAX_LENGTH} characters`,
    )
  }
  return trimmed
}

export type UpdateDuplicateDismissalResult = {
  workspace: GtmWorkspace
  signature: string | null
}

/*
 * Write settings.duplicate_plays_dismissed (or remove it when the input is
 * empty), self-scoped by org/tenant, with an audit event in the same
 * transaction. The signature itself is recorded: it is a hash the hub
 * computed over play ids, not customer content.
 */
export async function updateDuplicateDismissal(
  em: CampaignEm,
  ctx: GtmCtx,
  workspaceId: string,
  input: unknown,
): Promise<UpdateDuplicateDismissalResult> {
  const signature = normalizeDuplicateDismissal(input)
  const workspace = await em.findOne(GtmWorkspace, {
    id: workspaceId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!workspace) {
    throw new GtmCampaignError('workspace_not_found', 'Workspace not found')
  }

  await em.transactional(async (tem) => {
    const settings = { ...((workspace.settings ?? {}) as Record<string, unknown>) }
    if (signature) settings.duplicate_plays_dismissed = signature
    else delete settings.duplicate_plays_dismissed
    workspace.settings = settings
    tem.persist(workspace)
    const audit = tem.create(GtmAuditEvent, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      actor: 'user_id',
      actorUserId: ctx.userId,
      action: 'gtm.workspace.settings_updated',
      objectType: 'gtm_workspace',
      objectId: workspace.id,
      requestId: ctx.requestId ?? null,
      metadata: {
        setting: 'duplicate_plays_dismissed',
        duplicate_plays_dismissed: signature,
      },
    })
    tem.persist(audit)
    await tem.flush()
  })

  return { workspace, signature }
}

// ---------------------------------------------------------------------------
// Dry-lane preview quota: three per workspace per UTC day
// ---------------------------------------------------------------------------

export type PlayPreviewQuota = {
  /** UTC day the counter belongs to, 'YYYY-MM-DD'. */
  day: string
  used: number
  limit: number
  remaining: number
}

export function utcDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}

/*
 * The quota as it stands today. A counter stored under a different day, a
 * missing counter and a malformed counter all read as zero used: the cap is a
 * spend guard, and a guard that fails closed on unreadable state would lock a
 * customer out of a feature over a bad jsonb write.
 */
export function readPlayPreviewQuota(
  workspace: Pick<GtmWorkspace, 'settings'> | null | undefined,
  now: Date = new Date(),
): PlayPreviewQuota {
  const day = utcDayKey(now)
  const settings = (workspace?.settings ?? {}) as Record<string, unknown>
  const raw = settings.play_preview_quota
  let used = 0
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const record = raw as { day?: unknown; used?: unknown }
    if (record.day === day && typeof record.used === 'number' && Number.isFinite(record.used) && record.used > 0) {
      used = Math.floor(record.used)
    }
  }
  const capped = Math.min(used, PLAY_PREVIEW_DAILY_LIMIT)
  return { day, used: capped, limit: PLAY_PREVIEW_DAILY_LIMIT, remaining: Math.max(0, PLAY_PREVIEW_DAILY_LIMIT - capped) }
}

export type ConsumePlayPreviewResult = {
  allowed: boolean
  quota: PlayPreviewQuota
}

/*
 * Claim one preview BEFORE any provider call. The read-modify-write runs
 * inside the workspace transaction so two clicks in the same second cannot
 * both see "2 used"; a refused claim writes nothing. The claim is never
 * refunded when the provider returns nothing: the money left the building
 * either way, and a refund would let an empty lane be retried without limit.
 */
export async function consumePlayPreview(
  em: CampaignEm,
  ctx: GtmCtx,
  workspaceId: string,
  now: Date = new Date(),
): Promise<ConsumePlayPreviewResult> {
  const workspace = await em.findOne(GtmWorkspace, {
    id: workspaceId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!workspace) {
    throw new GtmCampaignError('workspace_not_found', 'Workspace not found')
  }
  const before = readPlayPreviewQuota(workspace, now)
  if (before.remaining <= 0) return { allowed: false, quota: before }

  const used = before.used + 1
  await em.transactional(async (tem) => {
    const settings = { ...((workspace.settings ?? {}) as Record<string, unknown>) }
    settings.play_preview_quota = { day: before.day, used }
    workspace.settings = settings
    tem.persist(workspace)
    await tem.flush()
  })
  return {
    allowed: true,
    quota: {
      day: before.day,
      used,
      limit: PLAY_PREVIEW_DAILY_LIMIT,
      remaining: Math.max(0, PLAY_PREVIEW_DAILY_LIMIT - used),
    },
  }
}
