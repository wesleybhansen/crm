import { FakeEm } from './support/fake-em'
import {
  HARNESS_NOLI_USER,
  HARNESS_ORG,
  HARNESS_TENANT,
  harness,
  internalRequest,
  readJson,
  resetHarness,
} from './support/route-harness'
import { GtmAuditEvent, GtmResearchRun } from '../../data/entities'

jest.mock('@open-mercato/shared/lib/noli/core-client', () =>
  require('./support/route-harness').coreClientMock,
)
jest.mock('@open-mercato/shared/lib/auth/clerk', () => require('./support/route-harness').clerkMock)
jest.mock('@open-mercato/shared/lib/di/container', () =>
  require('./support/route-harness').containerMock,
)

/*
 * /internal/gtm/research-runs shows an unstarted quote past its window as
 * expired (not pending) and refuses to execute it on the old price.
 */

const WORKSPACE = '33333333-3333-4333-8333-333333333333'
const PLAY = '55555555-5555-4555-8555-555555555555'
const PLAN_HASH = 'a'.repeat(64)
const DAY = 24 * 60 * 60 * 1000

async function seedPriced(em: FakeEm, ageDays: number): Promise<GtmResearchRun> {
  const run = em.create(GtmResearchRun, {
    organizationId: HARNESS_ORG,
    tenantId: HARNESS_TENANT,
    workspaceId: WORKSPACE,
    playId: PLAY,
    status: 'priced',
    providerPlan: { planHash: PLAN_HASH, adapterPlan: [] },
    estimatedCredits: '120',
    createdAt: new Date(Date.now() - ageDays * DAY),
  })
  em.persist(run)
  await em.flush()
  return run
}

async function loadRoute() {
  return (await import('../../api/internal/research-runs/route')).POST
}

describe('research-runs route: quote expiry', () => {
  beforeEach(() => {
    resetHarness({ features: ['gtm.view', 'gtm.edit', 'gtm.launch'] })
  })

  it('lists an unstarted quote past the window as expired, a fresh one as priced', async () => {
    const stale = await seedPriced(harness.em, 4)
    const fresh = await seedPriced(harness.em, 1)
    const POST = await loadRoute()
    const response = await POST(internalRequest({ op: 'list', noliUserId: HARNESS_NOLI_USER }))
    expect(response.status).toBe(200)
    const body = await readJson(response)
    const runs = body.runs as Array<{ id: string; status: string; quote_expires_at: string | null }>
    const byId = new Map(runs.map((run) => [run.id, run]))
    expect(byId.get(stale.id)?.status).toBe('expired')
    expect(byId.get(fresh.id)?.status).toBe('priced')
    expect(Date.parse(byId.get(fresh.id)!.quote_expires_at!)).toBeGreaterThan(Date.now())
  })

  it('status reports the expired quote too', async () => {
    const stale = await seedPriced(harness.em, 5)
    const POST = await loadRoute()
    const response = await POST(internalRequest({ op: 'status', noliUserId: HARNESS_NOLI_USER, runId: stale.id }))
    expect(response.status).toBe(200)
    const body = await readJson(response)
    expect((body.run as { status: string }).status).toBe('expired')
  })

  it('refuses to execute an expired quote and records the expiry', async () => {
    const stale = await seedPriced(harness.em, 4)
    const POST = await loadRoute()
    const response = await POST(
      internalRequest({ op: 'execute', noliUserId: HARNESS_NOLI_USER, runId: stale.id, expectedPlanHash: PLAN_HASH }),
    )
    expect(response.status).toBe(409)
    const body = await readJson(response)
    expect(body.code).toBe('quote_expired')
    expect((body.run as { status: string }).status).toBe('expired')
    const row = harness.em.table(GtmResearchRun).find((run) => run.id === stale.id)!
    expect(row.status).toBe('expired')
    expect(row.startedAt ?? null).toBeNull()
    expect(harness.em.table(GtmAuditEvent).map((event) => event.action)).toEqual([
      'gtm.research_run.quote_expired',
    ])
  })
})
