import { FakeEm } from './support/fake-em'
import { ctx, seedWorkspace, WORKSPACE } from './support/campaign-fixtures'
import {
  normalizePostalAddress,
  POSTAL_ADDRESS_MAX_LENGTH,
  readWorkspacePostalAddress,
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
