import { FakeEm } from './support/fake-em'
import { ctx, seedWorkspace, TENANT, WORKSPACE } from './support/campaign-fixtures'
import {
  createVersion,
  getLatestLockedVersion,
  getVersion,
  GtmVersionError,
  listVersions,
  revertVersion,
  setVersionLock,
} from '../versions'
import { GtmAuditEvent, GtmIcpVersion, GtmVoiceVersion } from '../../data/entities'

describe('ICP + Voice version CRUD, locks, and revert (immutable history)', () => {
  it('creates an append-only chain: each create is the next version, older rows untouched', async () => {
    const em = new FakeEm()
    await seedWorkspace(em)
    const v1 = await createVersion(em, ctx, 'icp', {
      workspaceId: WORKSPACE,
      content: { audience: 'first' },
    })
    const v2 = await createVersion(em, ctx, 'icp', {
      workspaceId: WORKSPACE,
      content: { audience: 'second' },
    })
    expect(v1.version).toBe(1)
    expect(v2.version).toBe(2)
    // The v1 row is never mutated by a later create.
    const v1Row = (await getVersion(em, ctx, 'icp', WORKSPACE, v1.id)) as GtmIcpVersion
    expect(v1Row.content).toEqual({ audience: 'first' })
    const list = await listVersions(em, ctx, 'icp', WORKSPACE)
    expect(list.map((r) => r.version)).toEqual([2, 1]) // newest first
  })

  it('records provenance author and writes an audit event per create', async () => {
    const em = new FakeEm()
    await seedWorkspace(em)
    const v = await createVersion(em, ctx, 'icp', {
      workspaceId: WORKSPACE,
      content: { x: 1 },
      author: 'user',
      provenance: { note: 'seeded' },
    })
    expect((v.provenance as Record<string, unknown>).author).toBe('user')
    const audits = em.table(GtmAuditEvent).filter((a) => a.action === 'gtm.icp.version_created')
    expect(audits).toHaveLength(1)
    expect(audits[0].objectId).toBe(v.id)
    expect(audits[0].objectVersion).toBe(1)
    expect(audits[0].actorUserId).toBe(ctx.userId)
  })

  it('locks a version (stamps locked/locked_by/locked_at) and unlock clears it; idempotent', async () => {
    const em = new FakeEm()
    await seedWorkspace(em)
    const v = await createVersion(em, ctx, 'voice', { workspaceId: WORKSPACE, content: { tone: 'warm' } })
    const locked = await setVersionLock(em, ctx, 'voice', { workspaceId: WORKSPACE, versionId: v.id, locked: true })
    expect(locked.locked).toBe(true)
    expect(locked.lockedByUserId).toBe(ctx.userId)
    expect(locked.lockedAt).toBeInstanceOf(Date)
    const lockAudits = em.table(GtmAuditEvent).filter((a) => a.action === 'gtm.voice.version_locked')
    expect(lockAudits).toHaveLength(1)

    // Idempotent: locking an already-locked row writes no second audit.
    await setVersionLock(em, ctx, 'voice', { workspaceId: WORKSPACE, versionId: v.id, locked: true })
    expect(em.table(GtmAuditEvent).filter((a) => a.action === 'gtm.voice.version_locked')).toHaveLength(1)

    const unlocked = await setVersionLock(em, ctx, 'voice', { workspaceId: WORKSPACE, versionId: v.id, locked: false })
    expect(unlocked.locked).toBe(false)
    expect(unlocked.lockedByUserId).toBeNull()
    expect(unlocked.lockedAt).toBeNull()
  })

  it('an agent write to a locked document is rejected; a user write still supersedes it', async () => {
    const em = new FakeEm()
    await seedWorkspace(em)
    const v1 = await createVersion(em, ctx, 'voice', { workspaceId: WORKSPACE, content: { tone: 'v1' } })
    await setVersionLock(em, ctx, 'voice', { workspaceId: WORKSPACE, versionId: v1.id, locked: true })

    // Agent cannot supersede a locked latest version.
    await expect(
      createVersion(em, ctx, 'voice', { workspaceId: WORKSPACE, content: { tone: 'agent' }, author: 'agent' }),
    ).rejects.toMatchObject({ code: 'locked_rejects_agent' })
    // An agent revert is refused the same way.
    await expect(
      revertVersion(em, ctx, 'voice', { workspaceId: WORKSPACE, sourceVersionId: v1.id, author: 'agent' }),
    ).rejects.toMatchObject({ code: 'locked_rejects_agent' })

    // A human can still author the next version over a locked one.
    const v2 = await createVersion(em, ctx, 'voice', { workspaceId: WORKSPACE, content: { tone: 'human' }, author: 'user' })
    expect(v2.version).toBe(2)
    // The locked v1 row is untouched.
    const v1Row = (await getVersion(em, ctx, 'voice', WORKSPACE, v1.id)) as GtmVoiceVersion
    expect(v1Row.locked).toBe(true)
    expect(v1Row.content).toEqual({ tone: 'v1' })
  })

  it('revert creates a NEW version copying an older version content; history is preserved', async () => {
    const em = new FakeEm()
    await seedWorkspace(em)
    const v1 = await createVersion(em, ctx, 'icp', { workspaceId: WORKSPACE, content: { audience: 'original' } })
    await createVersion(em, ctx, 'icp', { workspaceId: WORKSPACE, content: { audience: 'changed' } })
    const reverted = await revertVersion(em, ctx, 'icp', { workspaceId: WORKSPACE, sourceVersionId: v1.id })
    expect(reverted.version).toBe(3)
    expect(reverted.content).toEqual({ audience: 'original' })
    // New row, not the old one; deep clone (not the same reference).
    expect(reverted.id).not.toBe(v1.id)
    expect(reverted.content).not.toBe(v1.content)
    expect((reverted.provenance as Record<string, unknown>).reverted_from_version).toBe(1)
    const audits = em.table(GtmAuditEvent).filter((a) => a.action === 'gtm.icp.version_reverted')
    expect(audits).toHaveLength(1)
  })

  it('getLatestLockedVersion returns the highest locked version, ignoring later unlocked drafts', async () => {
    const em = new FakeEm()
    await seedWorkspace(em)
    const v1 = await createVersion(em, ctx, 'voice', { workspaceId: WORKSPACE, content: { tone: 'a' } })
    await setVersionLock(em, ctx, 'voice', { workspaceId: WORKSPACE, versionId: v1.id, locked: true })
    // A later unlocked draft must not be treated as the locked voice.
    await createVersion(em, ctx, 'voice', { workspaceId: WORKSPACE, content: { tone: 'b' }, author: 'user' })
    const latestLocked = await getLatestLockedVersion(em, ctx, 'voice', WORKSPACE)
    expect(latestLocked?.id).toBe(v1.id)
  })

  it('is self-scoped: a foreign-org workspace resolves workspace_not_found', async () => {
    const em = new FakeEm()
    const foreign = em.create(GtmIcpVersion, {
      organizationId: 'aaaaaaaa-9999-4999-8999-999999999999',
      tenantId: TENANT,
      workspaceId: 'ffffffff-4444-4444-8444-444444444444',
      version: 1,
      content: {},
    })
    em.persist(foreign)
    await em.flush()
    await expect(
      createVersion(em, ctx, 'icp', { workspaceId: 'ffffffff-4444-4444-8444-444444444444', content: {} }),
    ).rejects.toBeInstanceOf(GtmVersionError)
    await expect(
      createVersion(em, ctx, 'icp', { workspaceId: 'ffffffff-4444-4444-8444-444444444444', content: {} }),
    ).rejects.toMatchObject({ code: 'workspace_not_found' })
  })

  it('rejects non-object content with a typed error', async () => {
    const em = new FakeEm()
    await seedWorkspace(em)
    await expect(
      createVersion(em, ctx, 'icp', { workspaceId: WORKSPACE, content: [] as unknown as Record<string, unknown> }),
    ).rejects.toMatchObject({ code: 'invalid_content' })
  })
})
