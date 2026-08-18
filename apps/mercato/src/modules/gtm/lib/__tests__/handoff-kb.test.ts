import { FakeEm } from './support/fake-em'
import { WORKSPACE, ctx, seedCandidate, seedPlay, seedRun } from './support/campaign-fixtures'
import { createCampaign } from '../campaign/build'
import { approveCampaign, computeDraftState } from '../campaign/approve'
import {
  KB_MIRROR_CANONICAL_NOTICE,
  KbMirrorClient,
  buildCampaignSummaryDoc,
  buildIcpMirrorDoc,
  createKbMirrorClient,
  isKbHandoffConfigured,
} from '../handoff/kb-mirror'
import { GtmHandoffError, type FetchLike } from '../handoff/http'
import { GtmIcpVersion } from '../../data/entities'

const KB_BASE = 'https://kb.fixture.example'
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

function client(fn: FetchLike): KbMirrorClient {
  return new KbMirrorClient({ fetch: fn, baseUrl: KB_BASE, secret: SECRET })
}

function makeIcpVersion(overrides: Partial<GtmIcpVersion> = {}): GtmIcpVersion {
  const row = new GtmIcpVersion()
  Object.assign(row, {
    id: '11111111-1111-4111-8111-111111111111',
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    workspaceId: WORKSPACE,
    version: 3,
    content: {
      segment: 'B2B services, 10-50 employees',
      pains: ['manual follow-up', 'no outbound system'],
      geography: 'California, US',
    },
    locked: true,
    lockedByUserId: ctx.userId,
    lockedAt: new Date('2026-07-21T00:00:00.000Z'),
    ...overrides,
  })
  return row
}

describe('KB mirror handoff (SPEC-066 section 13)', () => {
  const savedEnv = { ...process.env }
  afterEach(() => {
    process.env.NOLI_INTERNAL_SERVICE_SECRET = savedEnv.NOLI_INTERNAL_SERVICE_SECRET
    process.env.KB_INTERNAL_URL = savedEnv.KB_INTERNAL_URL
    if (savedEnv.NOLI_INTERNAL_SERVICE_SECRET === undefined) {
      delete process.env.NOLI_INTERNAL_SERVICE_SECRET
    }
    if (savedEnv.KB_INTERNAL_URL === undefined) delete process.env.KB_INTERNAL_URL
  })

  it('mintKey POSTs the provision-key contract shape and parses both response shapes', async () => {
    const bare = fakeFetch([{ body: { key: 'pkb_bare' } }])
    await expect(client(bare.fn).mintKey('noli-user-9')).resolves.toBe('pkb_bare')
    expect(bare.calls[0].url).toBe(`${KB_BASE}/api/internal/provision-key`)
    expect(bare.calls[0].init?.method).toBe('POST')
    expect(bare.calls[0].init?.headers?.authorization).toBe(`Bearer ${SECRET}`)
    expect(JSON.parse(bare.calls[0].init?.body ?? '{}')).toEqual({
      noliUserId: 'noli-user-9',
      source: 'gtm',
    })

    const wrapped = fakeFetch([{ body: { data: { key: 'pkb_wrapped' } } }])
    await expect(client(wrapped.fn).mintKey('noli-user-9')).resolves.toBe('pkb_wrapped')

    const missing = fakeFetch([{ body: {} }])
    await expect(client(missing.fn).mintKey('noli-user-9')).rejects.toMatchObject({
      code: 'bad_response',
    })
  })

  it('pushMirror POSTs /api/agent/documents with the pkb_ bearer and gtm tag', async () => {
    const f = fakeFetch([{ body: { id: 'doc-1' } }])
    const result = await client(f.fn).pushMirror('pkb_key', {
      title: 'GTM ICP v3 (read-only mirror)',
      content: `${KB_MIRROR_CANONICAL_NOTICE}\n\nbody`,
      tags: ['gtm'],
    })
    expect(f.calls[0].url).toBe(`${KB_BASE}/api/agent/documents`)
    expect(f.calls[0].init?.method).toBe('POST')
    expect(f.calls[0].init?.headers?.authorization).toBe('Bearer pkb_key')
    const body = JSON.parse(f.calls[0].init?.body ?? '{}')
    expect(body.tags).toEqual(['gtm'])
    expect(body.title).toBe('GTM ICP v3 (read-only mirror)')
    expect(body.content).toContain(KB_MIRROR_CANONICAL_NOTICE)
    expect(result.id).toBe('doc-1')
  })

  it('non-2xx responses surface as typed request_failed errors', async () => {
    const f = fakeFetch([{ status: 401, body: { error: 'bad key' } }])
    let caught: unknown
    try {
      await client(f.fn).pushMirror('pkb_key', { title: 't', content: 'c', tags: ['gtm'] })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(GtmHandoffError)
    expect((caught as GtmHandoffError).code).toBe('request_failed')
    expect((caught as GtmHandoffError).status).toBe(401)
  })

  it('fails closed as handoff_unconfigured without the shared secret', () => {
    delete process.env.NOLI_INTERNAL_SERVICE_SECRET
    expect(isKbHandoffConfigured()).toBe(false)
    expect(() => createKbMirrorClient()).toThrow(
      expect.objectContaining({ code: 'handoff_unconfigured' }),
    )
  })

  it('the ICP mirror doc opens with the canonical notice and reads as a locked-version summary', () => {
    const doc = buildIcpMirrorDoc(makeIcpVersion())
    expect(doc.content.startsWith(KB_MIRROR_CANONICAL_NOTICE)).toBe(true)
    expect(doc.content).toContain('read-only mirror')
    expect(doc.content).toContain('Canonical record: Noli CRM')
    expect(doc.content).toContain('version 3')
    expect(doc.content).toContain('B2B services, 10-50 employees')
    expect(doc.title).toContain('v3')
    expect(doc.tags).toEqual(['gtm'])
  })

  it('the campaign summary doc opens with the canonical notice and summarizes the frozen snapshot', async () => {
    const em = new FakeEm()
    const play = await seedPlay(em)
    const run = await seedRun(em, play)
    await seedCandidate(em, run)
    const { campaign } = await createCampaign(em, ctx, {
      workspaceId: WORKSPACE,
      playId: play.id,
      name: 'Mirror summary campaign',
      channelMix: { emails: 2, linkedin: true },
    })
    const draft = await computeDraftState(em, ctx, campaign)
    const approved = await approveCampaign(em, ctx, {
      campaignId: campaign.id,
      expectedContentHash: draft.contentHash,
    })

    const doc = buildCampaignSummaryDoc(campaign, approved.version)
    expect(doc.content.startsWith(KB_MIRROR_CANONICAL_NOTICE)).toBe(true)
    expect(doc.content).toContain('Mirror summary campaign')
    expect(doc.content).toContain(approved.version.contentHash)
    expect(doc.content).toContain('**Steps:** 4')
    expect(doc.content).toContain('**Recipients (frozen):** 1')
    expect(doc.title).toContain('v1')
    expect(doc.tags).toEqual(['gtm'])
  })
})
