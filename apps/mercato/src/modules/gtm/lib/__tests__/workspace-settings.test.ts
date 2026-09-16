import { FakeEm } from './support/fake-em'
import { ctx, OTHER_ORG, POSTAL_ADDRESS, seedWorkspace, WORKSPACE } from './support/campaign-fixtures'
import {
  consumePlayPreview,
  DUPLICATE_DISMISSAL_MAX_LENGTH,
  normalizeDuplicateDismissal,
  normalizePostalAddress,
  PLAY_PREVIEW_DAILY_LIMIT,
  POSTAL_ADDRESS_MAX_LENGTH,
  readDuplicateDismissal,
  readPlayPreviewQuota,
  readWorkspacePostalAddress,
  updateDuplicateDismissal,
  updateWorkspacePostalAddress,
} from '../workspace-settings'
import { GtmAuditEvent, GtmWorkspace } from '../../data/entities'

describe('workspace settings: postal_address (CAN-SPAM sender address)', () => {
  it('writes a trimmed address into settings.postal_address and reads it back', async () => {
    const em = new FakeEm()
    await seedWorkspace(em, { postalAddress: null })
    const result = await updateWorkspacePostalAddress(
      em,
      ctx,
      WORKSPACE,
      '  742 Synthetic Ave, Fresno, CA 93650  ',
    )
    expect(result.postalAddress).toBe('742 Synthetic Ave, Fresno, CA 93650')
    const row = (await em.findOne(GtmWorkspace, { id: WORKSPACE }))!
    expect((row.settings as Record<string, unknown>).postal_address).toBe(
      '742 Synthetic Ave, Fresno, CA 93650',
    )
    expect(readWorkspacePostalAddress(row)).toBe('742 Synthetic Ave, Fresno, CA 93650')
  })

  it('empty or whitespace-only input unsets the address (key removed, not stored blank)', async () => {
    const em = new FakeEm()
    await seedWorkspace(em)
    const result = await updateWorkspacePostalAddress(em, ctx, WORKSPACE, '   ')
    expect(result.postalAddress).toBeNull()
    const row = (await em.findOne(GtmWorkspace, { id: WORKSPACE }))!
    expect('postal_address' in (row.settings as Record<string, unknown>)).toBe(false)
    expect(readWorkspacePostalAddress(row)).toBeNull()
  })

  it('rejects an address over the 300-character cap with a typed error, never truncates', async () => {
    const em = new FakeEm()
    const workspace = await seedWorkspace(em)
    const tooLong = 'a'.repeat(POSTAL_ADDRESS_MAX_LENGTH + 1)
    await expect(updateWorkspacePostalAddress(em, ctx, WORKSPACE, tooLong)).rejects.toMatchObject({
      code: 'invalid_settings',
    })
    // The stored value is untouched.
    expect(readWorkspacePostalAddress(workspace)).toBeTruthy()
    // Exactly at the cap is accepted.
    expect(normalizePostalAddress('b'.repeat(POSTAL_ADDRESS_MAX_LENGTH))).toBe(
      'b'.repeat(POSTAL_ADDRESS_MAX_LENGTH),
    )
  })

  it('readWorkspacePostalAddress treats missing workspace, non-string, and blank as unset', () => {
    expect(readWorkspacePostalAddress(null)).toBeNull()
    expect(readWorkspacePostalAddress({ settings: null })).toBeNull()
    expect(readWorkspacePostalAddress({ settings: { postal_address: 42 } })).toBeNull()
    expect(readWorkspacePostalAddress({ settings: { postal_address: '  ' } })).toBeNull()
    expect(readWorkspacePostalAddress({ settings: { postal_address: ' 1 Main St ' } })).toBe(
      '1 Main St',
    )
  })

  it('is self-scoped: a workspace outside the caller org resolves workspace_not_found', async () => {
    const em = new FakeEm()
    const foreign = em.create(GtmWorkspace, {
      organizationId: 'aaaaaaaa-9999-4999-8999-999999999999',
      tenantId: ctx.tenantId,
      name: 'Foreign workspace',
      status: 'active',
    })
    em.persist(foreign)
    await em.flush()
    await expect(
      updateWorkspacePostalAddress(em, ctx, foreign.id, '1 Main St'),
    ).rejects.toMatchObject({ code: 'workspace_not_found' })
  })

  it('writes a redacted audit event in the same transaction (presence + length, no address text)', async () => {
    const em = new FakeEm()
    await seedWorkspace(em, { postalAddress: null })
    await updateWorkspacePostalAddress(em, ctx, WORKSPACE, '9 Synthetic Sq, Reno, NV 89501')
    const audits = em
      .table(GtmAuditEvent)
      .filter((row) => row.action === 'gtm.workspace.settings_updated')
    expect(audits).toHaveLength(1)
    expect(audits[0].objectType).toBe('gtm_workspace')
    expect(audits[0].actorUserId).toBe(ctx.userId)
    const metadata = audits[0].metadata as Record<string, unknown>
    expect(metadata).toMatchObject({
      setting: 'postal_address',
      postal_address_set: true,
      postal_address_length: '9 Synthetic Sq, Reno, NV 89501'.length,
    })
    expect(JSON.stringify(metadata)).not.toContain('Synthetic Sq')
  })
})

describe('workspace settings: duplicate_plays_dismissed (the merge prompt)', () => {
  it('remembers the dismissed grouping signature and reads it back', async () => {
    const em = new FakeEm()
    await seedWorkspace(em)
    const result = await updateDuplicateDismissal(em, ctx, WORKSPACE, '  sig-abc123  ')
    expect(result.signature).toBe('sig-abc123')
    const row = (await em.findOne(GtmWorkspace, { id: WORKSPACE }))!
    expect(readDuplicateDismissal(row)).toBe('sig-abc123')
  })

  it('an empty signature re-arms the prompt (key removed, not stored blank)', async () => {
    const em = new FakeEm()
    await seedWorkspace(em)
    await updateDuplicateDismissal(em, ctx, WORKSPACE, 'sig-abc123')
    const result = await updateDuplicateDismissal(em, ctx, WORKSPACE, '  ')
    expect(result.signature).toBeNull()
    const row = (await em.findOne(GtmWorkspace, { id: WORKSPACE }))!
    expect('duplicate_plays_dismissed' in (row.settings as Record<string, unknown>)).toBe(false)
    expect(readDuplicateDismissal(row)).toBeNull()
  })

  it('never disturbs the CAN-SPAM postal address', async () => {
    const em = new FakeEm()
    await seedWorkspace(em)
    await updateDuplicateDismissal(em, ctx, WORKSPACE, 'sig-abc123')
    const row = (await em.findOne(GtmWorkspace, { id: WORKSPACE }))!
    expect(readWorkspacePostalAddress(row)).toBe(POSTAL_ADDRESS)
  })

  it('rejects an over-cap signature with a typed error rather than truncating it', async () => {
    const em = new FakeEm()
    await seedWorkspace(em)
    await expect(
      updateDuplicateDismissal(em, ctx, WORKSPACE, 'x'.repeat(DUPLICATE_DISMISSAL_MAX_LENGTH + 1)),
    ).rejects.toMatchObject({ code: 'invalid_settings' })
    expect(normalizeDuplicateDismissal('y'.repeat(DUPLICATE_DISMISSAL_MAX_LENGTH))).toHaveLength(
      DUPLICATE_DISMISSAL_MAX_LENGTH,
    )
    expect(() => normalizeDuplicateDismissal(7)).toThrow(/signature must be a string/)
  })

  it('treats a missing workspace, a non-string and a blank value as "show the prompt"', () => {
    expect(readDuplicateDismissal(null)).toBeNull()
    expect(readDuplicateDismissal({ settings: null })).toBeNull()
    expect(readDuplicateDismissal({ settings: { duplicate_plays_dismissed: 5 } })).toBeNull()
    expect(readDuplicateDismissal({ settings: { duplicate_plays_dismissed: ' ' } })).toBeNull()
  })

  it('records the signature in the audit trail', async () => {
    const em = new FakeEm()
    await seedWorkspace(em)
    await updateDuplicateDismissal(em, ctx, WORKSPACE, 'sig-abc123')
    const audit = em
      .table(GtmAuditEvent)
      .filter((row) => (row.metadata as Record<string, unknown>)?.setting === 'duplicate_plays_dismissed')
    expect(audit).toHaveLength(1)
    expect(audit[0].metadata).toMatchObject({ duplicate_plays_dismissed: 'sig-abc123' })
  })
})

describe('workspace settings: play_preview_quota (three dry lanes per UTC day)', () => {
  const day = new Date('2026-09-16T09:00:00.000Z')

  it('a fresh workspace has the full daily allowance', async () => {
    const em = new FakeEm()
    const workspace = await seedWorkspace(em)
    expect(readPlayPreviewQuota(workspace, day)).toEqual({
      day: '2026-09-16',
      used: 0,
      limit: PLAY_PREVIEW_DAILY_LIMIT,
      remaining: PLAY_PREVIEW_DAILY_LIMIT,
    })
  })

  it('counts claims down to zero and then refuses without writing', async () => {
    const em = new FakeEm()
    await seedWorkspace(em)
    for (let i = 1; i <= PLAY_PREVIEW_DAILY_LIMIT; i += 1) {
      const claim = await consumePlayPreview(em, ctx, WORKSPACE, day)
      expect(claim.allowed).toBe(true)
      expect(claim.quota.used).toBe(i)
      expect(claim.quota.remaining).toBe(PLAY_PREVIEW_DAILY_LIMIT - i)
    }
    const refused = await consumePlayPreview(em, ctx, WORKSPACE, day)
    expect(refused.allowed).toBe(false)
    expect(refused.quota.remaining).toBe(0)
    const row = (await em.findOne(GtmWorkspace, { id: WORKSPACE }))!
    expect((row.settings as Record<string, { used: number }>).play_preview_quota.used).toBe(
      PLAY_PREVIEW_DAILY_LIMIT,
    )
  })

  it('rolls over on the next UTC day without a sweep', async () => {
    const em = new FakeEm()
    await seedWorkspace(em)
    await consumePlayPreview(em, ctx, WORKSPACE, day)
    await consumePlayPreview(em, ctx, WORKSPACE, day)
    const tomorrow = new Date('2026-09-17T00:00:01.000Z')
    const row = (await em.findOne(GtmWorkspace, { id: WORKSPACE }))!
    expect(readPlayPreviewQuota(row, tomorrow)).toMatchObject({ day: '2026-09-17', used: 0, remaining: 3 })
    const claim = await consumePlayPreview(em, ctx, WORKSPACE, tomorrow)
    expect(claim.allowed).toBe(true)
    expect(claim.quota.used).toBe(1)
  })

  it('reads an unusable counter as zero used rather than locking the customer out', () => {
    for (const raw of [null, 'three', { day: '2026-09-16' }, { day: '2026-09-16', used: -4 }, { day: '2026-09-16', used: Number.NaN }]) {
      expect(readPlayPreviewQuota({ settings: { play_preview_quota: raw } }, day).used).toBe(0)
    }
    // A counter above the cap still reads as spent, never as negative headroom.
    expect(readPlayPreviewQuota({ settings: { play_preview_quota: { day: '2026-09-16', used: 99 } } }, day)).toMatchObject({
      used: PLAY_PREVIEW_DAILY_LIMIT,
      remaining: 0,
    })
  })

  it('refuses a workspace the caller does not own', async () => {
    const em = new FakeEm()
    await seedWorkspace(em)
    await expect(
      consumePlayPreview(em, { ...ctx, organizationId: OTHER_ORG }, WORKSPACE, day),
    ).rejects.toMatchObject({ code: 'workspace_not_found' })
  })
})
