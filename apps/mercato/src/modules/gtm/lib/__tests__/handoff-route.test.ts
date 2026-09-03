import { harness, internalRequest, readJson, resetHarness } from './support/route-harness'
import { HARNESS_NOLI_USER, HARNESS_ORG, HARNESS_TENANT } from './support/route-harness'
import { GtmCampaign, GtmWorkspace } from '../../data/entities'

jest.mock('@open-mercato/shared/lib/noli/core-client', () =>
  require('./support/route-harness').coreClientMock,
)
jest.mock('@open-mercato/shared/lib/auth/clerk', () => require('./support/route-harness').clerkMock)
jest.mock('@open-mercato/shared/lib/di/container', () =>
  require('./support/route-harness').containerMock,
)

// AMS is stubbed at the client boundary: no socket, no secret.
const amsState = {
  configured: true,
  assets: [] as Array<{ id: string; kind: string; title: string; publishedUrl: string | null; status: string | null; updatedAt: string | null }>,
}
jest.mock('../handoff/ams-assets', () => ({
  ...jest.requireActual('../handoff/ams-assets'),
  isAmsHandoffConfigured: () => amsState.configured,
  createAmsAssetClient: () => ({
    mintKey: async () => 'los_synthetic',
    listAssets: async () => amsState.assets,
  }),
}))

const CAMPAIGN_ID = '77777777-7777-4777-8777-777777777777'
const WORKSPACE = '33333333-3333-4333-8333-333333333333'

async function seedCampaign() {
  const em = harness.em
  em.persist(
    em.create(GtmWorkspace, {
      id: WORKSPACE,
      organizationId: HARNESS_ORG,
      tenantId: HARNESS_TENANT,
      name: 'Fixture workspace',
      status: 'active',
    }),
  )
  const campaign = em.create(GtmCampaign, {
    id: CAMPAIGN_ID,
    organizationId: HARNESS_ORG,
    tenantId: HARNESS_TENANT,
    workspaceId: WORKSPACE,
    playId: '11111111-2222-4333-8444-555555555555',
    name: 'Fixture campaign',
    status: 'draft',
    channelMix: {},
  })
  em.persist(campaign)
  await em.flush()
  return campaign
}

function attachBody(assetRef: Record<string, unknown>) {
  return { op: 'attach-asset', noliUserId: HARNESS_NOLI_USER, campaignId: CAMPAIGN_ID, assetRef }
}

describe('POST /internal/gtm/handoff attach-asset (review M10)', () => {
  beforeEach(() => {
    resetHarness({ features: ['gtm.view', 'gtm.edit'] })
    amsState.configured = true
    amsState.assets = []
  })

  it('resolves the asset through AMS and freezes the AMS URL, not the caller-supplied one', async () => {
    const { POST } = await import('../../api/internal/handoff/route')
    const campaign = await seedCampaign()
    amsState.assets = [
      { id: 'asset-1', kind: 'landing_page', title: 'AMS title', publishedUrl: 'https://ams.example/real', status: 'published', updatedAt: null },
    ]
    const response = await POST(
      internalRequest(
        attachBody({
          id: 'asset-1',
          kind: 'landing_page',
          title: 'Caller title',
          publishedUrl: 'https://attacker.example/spoof',
          frozen_url: 'https://attacker.example/spoof',
        }),
      ),
    )
    expect(response.status).toBe(200)
    const json = await readJson(response)
    expect(json.asset_refs).toEqual([
      expect.objectContaining({
        id: 'asset-1',
        title: 'AMS title',
        publishedUrl: 'https://ams.example/real',
        frozen_url: 'https://ams.example/real',
      }),
    ])
    expect(JSON.stringify(campaign.channelMix)).not.toContain('attacker.example')
  })

  it('refuses an asset id AMS does not know', async () => {
    const { POST } = await import('../../api/internal/handoff/route')
    const campaign = await seedCampaign()
    const response = await POST(
      internalRequest(
        attachBody({ id: 'ghost', kind: 'landing_page', title: 'Ghost', publishedUrl: 'https://ams.example/ghost' }),
      ),
    )
    expect(response.status).toBe(422)
    expect(await readJson(response)).toMatchObject({ code: 'asset_not_found' })
    expect(campaign.channelMix).toEqual({})
  })

  it('rejects non-https URLs at the validator even when AMS is unconfigured', async () => {
    const { POST } = await import('../../api/internal/handoff/route')
    await seedCampaign()
    amsState.configured = false
    const response = await POST(
      internalRequest(attachBody({ id: 'asset-1', kind: 'landing_page', title: 'X', publishedUrl: 'javascript:alert(1)' })),
    )
    expect(response.status).toBe(400)
  })
})
