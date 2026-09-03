import { harness, internalRequest, readJson, resetHarness } from './support/route-harness'
import { HARNESS_NOLI_USER, HARNESS_ORG, HARNESS_TENANT } from './support/route-harness'
import { GtmAuditEvent, GtmDeletionRequest, GtmDsrOperation } from '../../data/entities'

jest.mock('@open-mercato/shared/lib/noli/core-client', () =>
  require('./support/route-harness').coreClientMock,
)
jest.mock('@open-mercato/shared/lib/auth/clerk', () => require('./support/route-harness').clerkMock)
jest.mock('@open-mercato/shared/lib/di/container', () =>
  require('./support/route-harness').containerMock,
)
// The customers-module entity classes are only used as query targets here;
// plain classes keep the FakeEm table keyed without loading the core module.
jest.mock('@open-mercato/core/modules/customers/data/entities', () => ({
  CustomerEntity: class CustomerEntity {},
  CustomerPersonProfile: class CustomerPersonProfile {},
}))

const REQUEST_ID = '12121212-1212-4121-8121-121212121212'

async function seedRequest(status: string, dueInDays: number, overrides: Partial<GtmDeletionRequest> = {}) {
  const em = harness.em
  const request = em.create(GtmDeletionRequest, {
    id: REQUEST_ID,
    organizationId: HARNESS_ORG,
    tenantId: HARNESS_TENANT,
    idempotencyKey: `tenant-email:${HARNESS_TENANT}:hash`,
    scope: 'tenant_email',
    addressHash: 'a'.repeat(64),
    status,
    legalHold: false,
    requestedAt: new Date(),
    dueAt: new Date(Date.now() + dueInDays * 24 * 60 * 60 * 1000),
    ...overrides,
  })
  em.persist(request)
  await em.flush()
  return request
}

describe('POST /internal/gtm/privacy operator ops', () => {
  beforeEach(() => {
    resetHarness({ features: ['gtm.view'] })
  })

  it('gates the write ops behind gtm.approve while status stays viewer-level', async () => {
    const { POST } = await import('../../api/internal/privacy/route')
    await seedRequest('partial', 3)
    for (const op of ['set-legal-hold', 'clear-legal-hold']) {
      const response = await POST(
        internalRequest({ op, noliUserId: HARNESS_NOLI_USER, requestId: REQUEST_ID, reason: 'hold' }),
      )
      expect({ op, status: response.status }).toEqual({ op, status: 403 })
    }
    const complete = await POST(
      internalRequest({ op: 'complete-crm-contact-deletion', noliUserId: HARNESS_NOLI_USER, requestId: REQUEST_ID }),
    )
    expect(complete.status).toBe(403)
    const status = await POST(internalRequest({ op: 'status', noliUserId: HARNESS_NOLI_USER, requestId: REQUEST_ID }))
    expect(status.status).toBe(200)
  })

  it('lists partial requests nearing or past due, newest due first, and never other tenants', async () => {
    const { POST } = await import('../../api/internal/privacy/route')
    await seedRequest('partial', 2)
    const em = harness.em
    em.persist(
      em.create(GtmDeletionRequest, {
        organizationId: HARNESS_ORG,
        tenantId: HARNESS_TENANT,
        idempotencyKey: 'far',
        scope: 'tenant_email',
        addressHash: 'b'.repeat(64),
        status: 'partial',
        legalHold: false,
        requestedAt: new Date(),
        dueAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
      }),
    )
    em.persist(
      em.create(GtmDeletionRequest, {
        organizationId: HARNESS_ORG,
        tenantId: HARNESS_TENANT,
        idempotencyKey: 'overdue',
        scope: 'tenant_email',
        addressHash: 'c'.repeat(64),
        status: 'partial',
        legalHold: false,
        requestedAt: new Date(),
        dueAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      }),
    )
    em.persist(
      em.create(GtmDeletionRequest, {
        organizationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        tenantId: HARNESS_TENANT,
        idempotencyKey: 'foreign',
        scope: 'tenant_email',
        addressHash: 'd'.repeat(64),
        status: 'partial',
        legalHold: false,
        requestedAt: new Date(),
        dueAt: new Date(),
      }),
    )
    await em.flush()
    const response = await POST(internalRequest({ op: 'list-partial', noliUserId: HARNESS_NOLI_USER, within_days: 7 }))
    expect(response.status).toBe(200)
    const json = await readJson(response)
    const rows = json.requests as Array<Record<string, unknown>>
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ overdue: true })
    expect(rows[1]).toMatchObject({ id: REQUEST_ID, overdue: false })
  })

  it('sets and clears a legal hold with an audit for approvers', async () => {
    const { POST } = await import('../../api/internal/privacy/route')
    harness.features = new Set(['gtm.view', 'gtm.approve'])
    const request = await seedRequest('partial', 3)
    const set = await POST(
      internalRequest({ op: 'set-legal-hold', noliUserId: HARNESS_NOLI_USER, requestId: REQUEST_ID, reason: 'litigation' }),
    )
    expect(set.status).toBe(200)
    expect(request).toMatchObject({ legalHold: true, status: 'blocked_legal_hold', legalHoldReason: 'litigation' })
    const cleared = await POST(
      internalRequest({ op: 'clear-legal-hold', noliUserId: HARNESS_NOLI_USER, requestId: REQUEST_ID, reason: 'resolved' }),
    )
    expect(cleared.status).toBe(200)
    expect(request).toMatchObject({ legalHold: false, status: 'pending' })
    expect(harness.em.table(GtmAuditEvent).map((row) => row.action)).toEqual([
      'gtm.privacy.legal_hold_set',
      'gtm.privacy.legal_hold_cleared',
    ])
    const missing = await POST(
      internalRequest({
        op: 'set-legal-hold',
        noliUserId: HARNESS_NOLI_USER,
        requestId: '34343434-3434-4343-8343-343434343434',
        reason: 'x',
      }),
    )
    expect(missing.status).toBe(404)
  })

  it('completes the crm_customers operation from its receipt and reports the closed op', async () => {
    const { POST } = await import('../../api/internal/privacy/route')
    harness.features = new Set(['gtm.view', 'gtm.approve'])
    const request = await seedRequest('partial', 3)
    const em = harness.em
    const operation = em.create(GtmDsrOperation, {
      organizationId: HARNESS_ORG,
      tenantId: HARNESS_TENANT,
      deletionRequestId: request.id,
      provider: 'crm_customers',
      kind: 'local_anonymize',
      idempotencyKey: `${request.id}:${HARNESS_ORG}:crm_customers:local_anonymize`,
      status: 'blocked_authority',
      receipt: { promoted_contact_ids: ['56565656-5656-4565-8565-565656565656'] },
    })
    em.persist(operation)
    await em.flush()
    const response = await POST(
      internalRequest({ op: 'complete-crm-contact-deletion', noliUserId: HARNESS_NOLI_USER, requestId: REQUEST_ID }),
    )
    expect(response.status).toBe(200)
    const json = await readJson(response)
    // No contact rows exist in this fake, so zero anonymized, but the op is
    // closed and the request recomputed from its operations.
    expect(json).toMatchObject({
      ok: true,
      operation: { id: operation.id, status: 'completed' },
      request: { status: 'completed' },
      already_completed: false,
    })
    const again = await POST(
      internalRequest({ op: 'complete-crm-contact-deletion', noliUserId: HARNESS_NOLI_USER, requestId: REQUEST_ID }),
    )
    expect(await readJson(again)).toMatchObject({ already_completed: true })
  })
})
