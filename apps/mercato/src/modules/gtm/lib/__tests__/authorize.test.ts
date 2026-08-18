import {
  campaignFeatureForOp,
  executionFeatureForOp,
  hasGtmFeature,
  reconciliationFeatureForOp,
} from '../authorize'

const ctx = {
  userId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  organizationId: '33333333-3333-4333-8333-333333333333',
}

describe('GTM server-side feature authorization', () => {
  it('maps every campaign operation onto its least-privilege feature', () => {
    for (const op of ['list', 'draft-state', 'status']) {
      expect(campaignFeatureForOp(op)).toBe('gtm.view')
    }
    expect(campaignFeatureForOp('approve')).toBe('gtm.approve')
    for (const op of [
      'create',
      'update-template',
      'exclude',
      'include',
      'invalidate',
      'regenerate-message',
      'update-workspace-settings',
    ]) {
      expect(campaignFeatureForOp(op)).toBe('gtm.edit')
    }
  })

  it('reserves every execution mutation for launch-capable users', () => {
    expect(executionFeatureForOp('status')).toBe('gtm.view')
    expect(executionFeatureForOp('cursor-status')).toBe('gtm.view')
    for (const op of ['launch', 'tick', 'recover-stuck', 'correlate-replies']) {
      expect(executionFeatureForOp(op)).toBe('gtm.launch')
    }
  })

  it('makes provider reconciliation readable by viewers and mutable only by approvers', () => {
    expect(reconciliationFeatureForOp('list')).toBe('gtm.view')
    expect(reconciliationFeatureForOp('apply')).toBe('gtm.approve')
  })

  it('checks the represented user in the exact tenant and organization scope', async () => {
    const userHasAllFeatures = jest.fn().mockResolvedValue(true)
    const container = { resolve: jest.fn(() => ({ userHasAllFeatures })) }
    await expect(hasGtmFeature(container, ctx, 'gtm.approve')).resolves.toBe(true)
    expect(userHasAllFeatures).toHaveBeenCalledWith(ctx.userId, ['gtm.approve'], {
      tenantId: ctx.tenantId,
      organizationId: ctx.organizationId,
    })
  })

  it('fails closed for denial, missing service, or dependency failure', async () => {
    await expect(hasGtmFeature({ resolve: () => ({ userHasAllFeatures: async () => false }) }, ctx, 'gtm.launch')).resolves.toBe(false)
    await expect(hasGtmFeature({ resolve: () => null }, ctx, 'gtm.launch')).resolves.toBe(false)
    await expect(hasGtmFeature({ resolve: () => { throw new Error('rbac unavailable') } }, ctx, 'gtm.launch')).resolves.toBe(false)
  })
})
