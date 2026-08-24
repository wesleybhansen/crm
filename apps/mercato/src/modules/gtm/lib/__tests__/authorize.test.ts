import {
  candidateFeatureForOp,
  campaignFeatureForOp,
  chatFeatureForOp,
  enrichmentFeatureForOp,
  executionFeatureForOp,
  handoffFeatureForOp,
  hasGtmFeature,
  inboxFeatureForOp,
  reconciliationFeatureForOp,
  researchFeatureForOp,
  strategyFeatureForOp,
  taskFeatureForOp,
} from '../authorize'

const ctx = {
  userId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  organizationId: '33333333-3333-4333-8333-333333333333',
}

describe('GTM server-side feature authorization', () => {
  it('maps every campaign operation onto its least-privilege feature', () => {
    for (const op of ['list', 'draft-state', 'list-senders', 'status']) {
      expect(campaignFeatureForOp(op)).toBe('gtm.view')
    }
    expect(campaignFeatureForOp('approve')).toBe('gtm.approve')
    for (const op of [
      'create',
      'update-template',
      'update-message',
      'update-sequence',
      'update-settings',
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
    for (const op of [
      'launch',
      'pause-campaign',
      'resume-campaign',
      'stop-campaign',
      'complete-campaign',
      'tick',
      'recover-stuck',
      'correlate-replies',
      'clear-mailbox-pause',
      'enqueue-mailbox-ingestion',
      'r4-owned-mailbox-ingest',
    ]) {
      expect(executionFeatureForOp(op)).toBe('gtm.launch')
    }
  })

  it('makes provider reconciliation readable by viewers and mutable only by approvers', () => {
    expect(reconciliationFeatureForOp('list')).toBe('gtm.view')
    expect(reconciliationFeatureForOp('history')).toBe('gtm.view')
    expect(reconciliationFeatureForOp('catalog')).toBe('gtm.view')
    expect(reconciliationFeatureForOp('ai-telemetry')).toBe('gtm.view')
    expect(reconciliationFeatureForOp('apply')).toBe('gtm.approve')
  })

  it('reserves paid provider work and reply sends for launch-capable users', () => {
    for (const op of ['plan', 'status']) expect(enrichmentFeatureForOp(op)).toBe('gtm.view')
    expect(enrichmentFeatureForOp('run')).toBe('gtm.launch')
    for (const op of ['list', 'plan', 'status']) expect(researchFeatureForOp(op)).toBe('gtm.view')
    expect(researchFeatureForOp('create')).toBe('gtm.edit')
    expect(researchFeatureForOp('execute')).toBe('gtm.launch')
    expect(researchFeatureForOp('retention-sweep')).toBe('gtm.launch')
    for (const op of ['list', 'thread']) expect(inboxFeatureForOp(op)).toBe('gtm.view')
    expect(inboxFeatureForOp('draft-response-ai')).toBe('gtm.edit')
    expect(inboxFeatureForOp('approve-draft')).toBe('gtm.launch')
  })

  it('maps every remaining GTM route operation onto least privilege', () => {
    for (const op of ['list', 'detail']) expect(candidateFeatureForOp(op)).toBe('gtm.view')
    for (const op of ['review', 'export']) expect(candidateFeatureForOp(op)).toBe('gtm.edit')
    for (const op of ['thread-list', 'messages']) expect(chatFeatureForOp(op)).toBe('gtm.view')
    for (const op of ['thread-create', 'append-message']) expect(chatFeatureForOp(op)).toBe('gtm.edit')
    for (const op of ['assets-list', 'asset-status']) expect(handoffFeatureForOp(op)).toBe('gtm.view')
    expect(handoffFeatureForOp('asset-request')).toBe('gtm.approve')
    expect(handoffFeatureForOp('attach-asset')).toBe('gtm.edit')
    for (const op of ['icp-list', 'icp-get', 'voice-list', 'voice-get']) {
      expect(strategyFeatureForOp(op)).toBe('gtm.view')
    }
    for (const op of ['icp-create', 'voice-lock', 'voice-derive']) {
      expect(strategyFeatureForOp(op)).toBe('gtm.edit')
    }
    for (const op of ['list', 'timeline']) expect(taskFeatureForOp(op)).toBe('gtm.view')
    expect(taskFeatureForOp('mark')).toBe('gtm.edit')
    expect(taskFeatureForOp('override-dependency')).toBe('gtm.launch')
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
