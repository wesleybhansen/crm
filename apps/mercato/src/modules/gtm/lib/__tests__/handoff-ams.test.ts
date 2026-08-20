import { FakeEm } from './support/fake-em'
import { WORKSPACE, ctx, seedCandidate, seedPlay, seedRun } from './support/campaign-fixtures'
import { createCampaign, parseAssetRefs } from '../campaign/build'
import { approveCampaign, computeDraftState, loadCampaign } from '../campaign/approve'
import {
  AmsAssetClient,
  attachAssetRef,
  createAmsAssetClient,
  isAmsHandoffConfigured,
} from '../handoff/ams-assets'
import { GtmHandoffError, type FetchLike } from '../handoff/http'
import { GtmAuditEvent, GtmCampaignVersion } from '../../data/entities'

const AMS_BASE = 'https://ams.fixture.example'
const SECRET = 'test-internal-secret'

type RecordedCall = {
  url: string
  init?: { method?: string; headers?: Record<string, string>; body?: string }
}

function fakeFetch(queue: Array<{ status?: number; body: unknown }>) {
  const calls: RecordedCall[] = []
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init })
    const next = queue.shift() ?? { status: 200, body: {} }
    const status = next.status ?? 200
    return { ok: status >= 200 && status < 300, status, json: async () => next.body }
  }
  return { fn, calls }
}

function client(fn: FetchLike): AmsAssetClient {
  return new AmsAssetClient({ fetch: fn, baseUrl: AMS_BASE, secret: SECRET })
}

describe('AMS asset handoff client (gtm-asset-handoff-contract-2026-07-23)', () => {
  const savedEnv = { ...process.env }
  afterEach(() => {
    process.env.NOLI_INTERNAL_SERVICE_SECRET = savedEnv.NOLI_INTERNAL_SERVICE_SECRET
    process.env.AMS_INTERNAL_URL = savedEnv.AMS_INTERNAL_URL
    if (savedEnv.NOLI_INTERNAL_SERVICE_SECRET === undefined) {
      delete process.env.NOLI_INTERNAL_SERVICE_SECRET
    }
    if (savedEnv.AMS_INTERNAL_URL === undefined) delete process.env.AMS_INTERNAL_URL
  })

  it('mintKey POSTs the provision-key contract shape and parses both response shapes', async () => {
    const bare = fakeFetch([{ body: { key: 'los_bare_key' } }])
    await expect(client(bare.fn).mintKey('noli-user-1')).resolves.toBe('los_bare_key')
    expect(bare.calls).toHaveLength(1)
    expect(bare.calls[0].url).toBe(`${AMS_BASE}/api/internal/provision-key`)
    expect(bare.calls[0].init?.method).toBe('POST')
    expect(bare.calls[0].init?.headers?.authorization).toBe(`Bearer ${SECRET}`)
    expect(bare.calls[0].init?.headers?.['content-type']).toBe('application/json')
    expect(JSON.parse(bare.calls[0].init?.body ?? '{}')).toEqual({
      noliUserId: 'noli-user-1',
      source: 'gtm',
    })

    const wrapped = fakeFetch([{ body: { data: { key: 'los_wrapped_key' } } }])
    await expect(client(wrapped.fn).mintKey('noli-user-1')).resolves.toBe('los_wrapped_key')

    const empty = fakeFetch([{ body: { ok: true } }])
    await expect(client(empty.fn).mintKey('noli-user-1')).rejects.toMatchObject({
      code: 'bad_response',
    })
  })

  it('listAssets GETs /api/ext/assets with the los_ bearer and accepts both list shapes', async () => {
    const asset = {
      id: 'asset-1',
      kind: 'lead_magnet',
      title: 'Synthetic guide',
      publishedUrl: 'https://ams.fixture.example/lm/guide',
      status: 'published',
      updatedAt: '2026-07-20T00:00:00.000Z',
    }
    const bare = fakeFetch([{ body: [asset] }])
    const bareResult = await client(bare.fn).listAssets('los_key')
    expect(bare.calls[0].url).toBe(`${AMS_BASE}/api/ext/assets`)
    expect(bare.calls[0].init?.method).toBe('GET')
    expect(bare.calls[0].init?.headers?.authorization).toBe('Bearer los_key')
    expect(bareResult).toEqual([asset])

    const wrapped = fakeFetch([{ body: { assets: [asset] } }])
    await expect(client(wrapped.fn).listAssets('los_key')).resolves.toEqual([asset])
  })

  it('requestAsset POSTs the frozen request shape and parses both response shapes', async () => {
    const direct = fakeFetch([{ body: { request_id: 'req-1', job_id: 'job-1' } }])
    const input = {
      kind: 'asset_kit',
      brief: 'One-pager for plumbing companies adopting AI',
      platform: 'linkedin',
      play_context: { play_id: 'play-1', angle: 'hiring growth' },
    }
    const result = await client(direct.fn).requestAsset('los_key', input)
    expect(direct.calls[0].url).toBe(`${AMS_BASE}/api/ext/assets/requests`)
    expect(direct.calls[0].init?.method).toBe('POST')
    expect(direct.calls[0].init?.headers?.authorization).toBe('Bearer los_key')
    expect(JSON.parse(direct.calls[0].init?.body ?? '{}')).toEqual({
      kind: 'asset_kit',
      brief: 'One-pager for plumbing companies adopting AI',
      platform: 'linkedin',
      play_context: { play_id: 'play-1', angle: 'hiring growth' },
    })
    expect(result).toEqual({ request_id: 'req-1', job_id: 'job-1' })

    const wrapped = fakeFetch([{ body: { data: { request_id: 'req-2', job_id: null } } }])
    await expect(
      client(wrapped.fn).requestAsset('los_key', { ...input, platform: null }),
    ).resolves.toEqual({ request_id: 'req-2', job_id: null })
    // platform omitted from the body when null
    expect(JSON.parse(wrapped.calls[0].init?.body ?? '{}')).not.toHaveProperty('platform')
  })

  it('getRequestStatus GETs the request by id', async () => {
    const f = fakeFetch([{ body: { request_id: 'req-1', status: 'COMPLETED' } }])
    const result = await client(f.fn).getRequestStatus('los_key', 'req-1')
    expect(f.calls[0].url).toBe(`${AMS_BASE}/api/ext/assets/requests/req-1`)
    expect(f.calls[0].init?.headers?.authorization).toBe('Bearer los_key')
    expect(result.status).toBe('COMPLETED')
  })

  it('non-2xx responses surface as typed request_failed errors with the status', async () => {
    const f = fakeFetch([{ status: 503, body: { error: 'down' } }])
    let caught: unknown
    try {
      await client(f.fn).listAssets('los_key')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(GtmHandoffError)
    expect((caught as GtmHandoffError).code).toBe('request_failed')
    expect((caught as GtmHandoffError).status).toBe(503)
  })

  it('fails closed as handoff_unconfigured without the shared secret', () => {
    delete process.env.NOLI_INTERNAL_SERVICE_SECRET
    expect(isAmsHandoffConfigured()).toBe(false)
    expect(() => createAmsAssetClient()).toThrow(
      expect.objectContaining({ code: 'handoff_unconfigured' }),
    )
  })
})

describe('asset references freeze into the approval snapshot', () => {
  async function draftFixture() {
    const em = new FakeEm()
    const play = await seedPlay(em)
    const run = await seedRun(em, play)
    await seedCandidate(em, run)
    const { campaign } = await createCampaign(em, ctx, {
      workspaceId: WORKSPACE,
      playId: play.id,
      name: 'Asset campaign',
    })
    return { em, campaign }
  }

  const REF_A = {
    id: 'asset-a',
    kind: 'lead_magnet',
    title: 'Synthetic guide',
    publishedUrl: 'https://ams.fixture.example/lm/guide',
  }
  const REF_B = {
    id: 'asset-b',
    kind: 'post',
    title: 'Synthetic post',
    publishedUrl: 'https://ams.fixture.example/posts/1',
  }

  it('attach stores the reference with a frozen_url and audits', async () => {
    const { em, campaign } = await draftFixture()
    const result = await attachAssetRef(em, ctx, { campaignId: campaign.id, assetRef: REF_A })
    expect(result.assetRefs).toHaveLength(1)
    expect(result.assetRefs[0].frozen_url).toBe(REF_A.publishedUrl)
    expect(result.invalidated).toBe(false)

    const audits = await em.find(GtmAuditEvent, { action: 'gtm.handoff.asset_attached' })
    expect(audits).toHaveLength(1)
    expect((audits[0].metadata as Record<string, unknown>).asset_id).toBe('asset-a')

    // Attaching changes the reviewable draft content hash.
    const before = await computeDraftState(em, ctx, await loadCampaign(em, ctx, campaign.id))
    await attachAssetRef(em, ctx, { campaignId: campaign.id, assetRef: REF_B })
    const after = await computeDraftState(em, ctx, await loadCampaign(em, ctx, campaign.id))
    expect(after.contentHash).not.toBe(before.contentHash)
  })

  it('a ref present at approval is frozen in the snapshot and immune to later channel_mix edits', async () => {
    const { em, campaign } = await draftFixture()
    await attachAssetRef(em, ctx, { campaignId: campaign.id, assetRef: REF_A })
    const reviewed = await computeDraftState(em, ctx, campaign)
    const approved = await approveCampaign(em, ctx, {
      campaignId: campaign.id,
      expectedContentHash: reviewed.contentHash,
    })

    const snapshotRefs = (approved.version.snapshot as Record<string, unknown>)
      .asset_refs as Array<Record<string, unknown>>
    expect(snapshotRefs).toHaveLength(1)
    expect(snapshotRefs[0]).toEqual({
      id: 'asset-a',
      kind: 'lead_magnet',
      title: 'Synthetic guide',
      published_url: REF_A.publishedUrl,
      frozen_url: REF_A.publishedUrl,
    })

    // Attaching another asset invalidates the current version but never
    // rewrites the frozen snapshot.
    const second = await attachAssetRef(em, ctx, { campaignId: campaign.id, assetRef: REF_B })
    expect(second.invalidated).toBe(true)
    const versionRow = await em.findOne(GtmCampaignVersion, { id: approved.version.id })
    expect(versionRow!.invalidatedReason).toBe('asset_attached')
    const frozenRefs = (versionRow!.snapshot as Record<string, unknown>)
      .asset_refs as Array<Record<string, unknown>>
    expect(frozenRefs).toHaveLength(1)
    expect(frozenRefs[0].id).toBe('asset-a')
    expect(versionRow!.contentHash).toBe(approved.contentHash)

    // Even a direct channel_mix mutation (simulating any later edit or an
    // AMS-side unpublish rewriting the draft) cannot reach the snapshot.
    const campaignRow = await loadCampaign(em, ctx, campaign.id)
    const mix = campaignRow.channelMix as Record<string, unknown>
    mix.asset_refs = []
    expect(
      ((versionRow!.snapshot as Record<string, unknown>).asset_refs as unknown[]).length,
    ).toBe(1)

    // Re-approval freezes the new set into a NEW version.
    campaignRow.channelMix = {
      ...mix,
      asset_refs: parseAssetRefs(campaignRow) /* empty now */,
    }
    await attachAssetRef(em, ctx, { campaignId: campaign.id, assetRef: REF_B })
    const reviewedAgain = await computeDraftState(em, ctx, campaign)
    const reapproved = await approveCampaign(em, ctx, {
      campaignId: campaign.id,
      expectedContentHash: reviewedAgain.contentHash,
    })
    expect(reapproved.version.version).toBe(2)
    const newRefs = (reapproved.version.snapshot as Record<string, unknown>)
      .asset_refs as Array<Record<string, unknown>>
    expect(newRefs.map((ref) => ref.id)).toEqual(['asset-b'])
  })
})
