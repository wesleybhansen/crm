import { GtmCampaignError, type CampaignEm, type GtmCtx } from './campaign/build'
import { GtmAuditEvent, GtmPlay } from '../data/entities'

/*
 * Archiving a play (the "merge duplicates" action in the hub's Plays tab).
 *
 * A workspace that imported several audience reports ends up with four plays
 * that read the same. Merging keeps one and archives the rest. Archiving is
 * deliberately NOT a delete:
 *
 *   - the play row stays, stamped deleted_at, which is the same soft-delete
 *     every GTM list read already filters on (`deletedAt: null`), so an
 *     archived play simply stops appearing in the overview, the plays list
 *     and the play picker
 *   - its research runs, candidates, evidence, provider operations and
 *     campaigns are untouched. They carry play_id, not a foreign key cascade,
 *     and every one of those reads is scoped by run or workspace rather than
 *     by a live-play join, so results a customer already paid for stay
 *     readable after the play they came from is archived
 *   - one audit event records who archived it and why, so "where did my play
 *     go" has an answer
 *
 * Idempotent: archiving an already-archived play is a no-op that reports
 * `alreadyArchived`, so a retried merge cannot fail halfway through a group.
 * A missing, foreign or malformed play is the caller's opaque 404, raised as
 * play_not_found exactly like every other play-scoped operation.
 */

export const ARCHIVE_REASON_MAX_LENGTH = 200

export type ArchivePlayResult = {
  play: GtmPlay
  alreadyArchived: boolean
  archivedAt: Date
}

export function normalizeArchiveReason(input: unknown): string | null {
  if (input == null) return null
  if (typeof input !== 'string') {
    throw new GtmCampaignError('invalid_settings', 'reason must be a string')
  }
  const trimmed = input.trim().replace(/\s+/g, ' ')
  if (!trimmed) return null
  return trimmed.slice(0, ARCHIVE_REASON_MAX_LENGTH)
}

export async function archivePlay(
  em: CampaignEm,
  ctx: GtmCtx,
  playId: string,
  options: { reason?: unknown; keptPlayId?: string | null; now?: Date } = {},
): Promise<ArchivePlayResult> {
  const reason = normalizeArchiveReason(options.reason)
  const play = await em.findOne(GtmPlay, {
    id: playId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
  })
  if (!play) {
    throw new GtmCampaignError('play_not_found', 'Play not found')
  }
  if (play.deletedAt) {
    return { play, alreadyArchived: true, archivedAt: play.deletedAt }
  }

  const archivedAt = options.now ?? new Date()
  await em.transactional(async (tem) => {
    play.deletedAt = archivedAt
    tem.persist(play)
    const audit = tem.create(GtmAuditEvent, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      actor: 'user_id',
      actorUserId: ctx.userId,
      action: 'gtm.play.archived',
      objectType: 'gtm_play',
      objectId: play.id,
      requestId: ctx.requestId ?? null,
      // Ids and the customer's own one-line reason; no audience text, which
      // would turn the audit log into a copy of the play table.
      metadata: {
        workspace_id: play.workspaceId,
        kept_play_id: typeof options.keptPlayId === 'string' && options.keptPlayId.trim()
          ? options.keptPlayId.trim()
          : null,
        reason,
      },
    })
    tem.persist(audit)
    await tem.flush()
  })

  return { play, alreadyArchived: false, archivedAt }
}
