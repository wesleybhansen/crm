import { FakeEm } from './support/fake-em'
import { ctx, seedPlay, seedRun } from './support/campaign-fixtures'
import { archivePlay, ARCHIVE_REASON_MAX_LENGTH, normalizeArchiveReason } from '../play-archive'
import { GtmAuditEvent, GtmPlay, GtmResearchRun } from '../../data/entities'

/*
 * Archiving is the "merge duplicates" action. The contract that matters to a
 * customer: the play leaves the lists, the results they paid for do not.
 */

describe('archivePlay', () => {
  it('stamps deleted_at so every live list stops showing the play', async () => {
    const em = new FakeEm()
    const play = await seedPlay(em)
    const at = new Date('2026-09-16T10:00:00.000Z')

    const result = await archivePlay(em, ctx, play.id, { now: at })

    expect(result.alreadyArchived).toBe(false)
    expect(result.archivedAt).toEqual(at)
    expect((await em.findOne(GtmPlay, { id: play.id }))?.deletedAt).toEqual(at)
    // The live-list predicate every GTM read uses no longer matches it.
    expect(await em.findOne(GtmPlay, { id: play.id, deletedAt: null })).toBeNull()
  })

  it('keeps the play row, its runs and their results', async () => {
    const em = new FakeEm()
    const play = await seedPlay(em)
    const run = await seedRun(em, play)

    await archivePlay(em, ctx, play.id)

    // The row itself is still there (archived, not deleted).
    expect(await em.findOne(GtmPlay, { id: play.id })).not.toBeNull()
    const keptRun = await em.findOne(GtmResearchRun, { id: run.id, deletedAt: null })
    expect(keptRun).not.toBeNull()
    expect(keptRun?.playId).toBe(play.id)
    expect(keptRun?.status).toBe('completed')
  })

  it('is idempotent: archiving twice reports already_archived and keeps the first timestamp', async () => {
    const em = new FakeEm()
    const play = await seedPlay(em)
    const first = new Date('2026-09-16T10:00:00.000Z')
    await archivePlay(em, ctx, play.id, { now: first })

    const second = await archivePlay(em, ctx, play.id, { now: new Date('2026-09-17T10:00:00.000Z') })

    expect(second.alreadyArchived).toBe(true)
    expect(second.archivedAt).toEqual(first)
    expect((await em.findOne(GtmPlay, { id: play.id }))?.deletedAt).toEqual(first)
    // No second audit event for a no-op.
    const events = em.table(GtmAuditEvent).filter((row) => row.action === 'gtm.play.archived')
    expect(events).toHaveLength(1)
  })

  it('records who archived it, which play survived, and the reason, but no audience text', async () => {
    const em = new FakeEm()
    const kept = await seedPlay(em)
    const play = await seedPlay(em)

    await archivePlay(em, ctx, play.id, { keptPlayId: kept.id, reason: '  Duplicate of   the Austin play ' })

    const audit = em.table(GtmAuditEvent).find((row) => row.action === 'gtm.play.archived')!
    expect(audit.objectType).toBe('gtm_play')
    expect(audit.objectId).toBe(play.id)
    expect(audit.actorUserId).toBe(ctx.userId)
    expect(audit.metadata).toMatchObject({
      workspace_id: play.workspaceId,
      kept_play_id: kept.id,
      reason: 'Duplicate of the Austin play',
    })
    expect(JSON.stringify(audit.metadata)).not.toContain(play.audience)
  })

  it('refuses a play from another organization with the same opaque play_not_found', async () => {
    const em = new FakeEm()
    const play = await seedPlay(em)
    await expect(
      archivePlay(em, { ...ctx, organizationId: '00000000-0000-4000-8000-0000000000ff' }, play.id),
    ).rejects.toMatchObject({ code: 'play_not_found' })
    await expect(archivePlay(em, ctx, 'not-a-play')).rejects.toMatchObject({ code: 'play_not_found' })
    expect((await em.findOne(GtmPlay, { id: play.id }))?.deletedAt ?? null).toBeNull()
  })

  it('normalizes the reason: blank is null, whitespace collapses, over-cap truncates', () => {
    expect(normalizeArchiveReason(null)).toBeNull()
    expect(normalizeArchiveReason('   ')).toBeNull()
    expect(normalizeArchiveReason('a\n\n b')).toBe('a b')
    expect(normalizeArchiveReason('x'.repeat(ARCHIVE_REASON_MAX_LENGTH + 50))).toHaveLength(
      ARCHIVE_REASON_MAX_LENGTH,
    )
    expect(() => normalizeArchiveReason(42)).toThrow(/reason must be a string/)
  })
})
