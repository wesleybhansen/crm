import { generateKeyPairSync } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  CRM_AMS_AUTHORITY_PROJECTION_FLAG_V1,
  CrmAmsAuthorityProjectionConflict,
  __test,
} from '../ams-crm-authority'
import {
  IntegrationsApiAmsEvent,
  IntegrationsApiConsentVersion,
  IntegrationsApiSuppressionVersion,
} from '../../data/entities'
import type { CrmAmsAuthorityProjectionInputV1 } from '../../data/validators'
import {
  crmAmsEventEnvelopeV1Schema,
  verifyCrmAmsEventV1,
} from '../../lib/ams-crm-contract-v1'
import { evaluateCrmAmsEligibilityV1 } from '../../lib/ams-crm-eligibility-v1'

const nowMs = Date.parse('2026-08-24T20:00:00.000Z')
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const signer = { keyVersion: 'crm-event-test-1', privateKeyPem }
const input: CrmAmsAuthorityProjectionInputV1 = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  sourceOrganizationId: '33333333-3333-4333-8333-333333333333',
  crmContactRef: 'crm-contact:opaque:1',
  purpose: 'marketing',
  event: {
    eventId: '44444444-4444-4444-8444-444444444444',
    eventType: 'consent.changed',
    occurredAt: '2026-08-24T20:00:00.000Z',
    expiresAt: '2026-08-24T20:05:00.000Z',
    nonce: 'abcdefghijklmnopqrstuv',
    commandRef: 'command:opaque:1',
    receiptRef: 'receipt:opaque:1',
  },
  consent: {
    version: '1',
    state: 'granted',
    policyRef: 'policy:opaque:1',
    sourceRef: 'source:opaque:1',
    effectiveAt: '2026-08-24T19:59:00.000Z',
    expiresAt: null,
  },
  suppression: {
    version: '1',
    active: false,
    reasonCode: 'none',
    effectiveAt: '2026-08-24T19:59:00.000Z',
  },
}

type StoredRow = Record<string, unknown> & { __entity?: unknown }

function matches(row: StoredRow, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') {
      return (expected as Array<Record<string, unknown>>).some((candidate) => matches(row, candidate))
    }
    return row[key] === expected
  })
}

function inMemoryEm() {
  const stored = {
    consent: [] as StoredRow[],
    suppression: [] as StoredRow[],
    events: [] as StoredRow[],
  }
  const pending: StoredRow[] = []

  function rowsFor(entity: unknown): StoredRow[] {
    if (entity === IntegrationsApiConsentVersion) return stored.consent
    if (entity === IntegrationsApiSuppressionVersion) return stored.suppression
    if (entity === IntegrationsApiAmsEvent) return stored.events
    throw new Error('Unexpected entity')
  }

  const em = {
    findOne: jest.fn(async (
      entity: unknown,
      filter: Record<string, unknown>,
      options?: { orderBy?: { version?: string } },
    ) => {
      const candidates = rowsFor(entity).filter((row) => matches(row, filter))
      if (options?.orderBy?.version === 'DESC') {
        candidates.sort((left, right) => Number(BigInt(String(right.version)) - BigInt(String(left.version))))
      }
      return candidates[0] ?? null
    }),
    find: jest.fn(async (entity: unknown, filter: Record<string, unknown>) => (
      rowsFor(entity).filter((row) => matches(row, filter))
    )),
    create: jest.fn((entity: unknown, value: Record<string, unknown>) => {
      const row: StoredRow = { ...value, deletedAt: null, __entity: entity }
      pending.push(row)
      return row
    }),
    persist: jest.fn(() => undefined),
    flush: jest.fn(async () => {
      for (const row of pending.splice(0)) {
        rowsFor(row.__entity).push(row)
      }
    }),
    transactional: jest.fn(async (work: (transaction: EntityManager) => Promise<unknown>) => (
      work(em as unknown as EntityManager)
    )),
  } as unknown as EntityManager

  return { em, stored }
}

function nextInput(overrides: Partial<CrmAmsAuthorityProjectionInputV1> = {}): CrmAmsAuthorityProjectionInputV1 {
  return {
    ...input,
    ...overrides,
    event: { ...input.event, ...overrides.event },
    consent: { ...input.consent, ...overrides.consent },
    suppression: { ...input.suppression, ...overrides.suppression },
  }
}

describe('CRM AMS authority projection v1', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it('atomically persists monotonic authority versions and a privacy-minimal signed event held dark', async () => {
    const { em, stored } = inMemoryEm()
    const fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('provider access forbidden'))

    await expect(__test.projectAuthority(em, input, signer, nowMs)).resolves.toMatchObject({
      action: 'inserted',
      state: 'held_dark',
      eventDelivery: false,
      providerDispatch: false,
    })

    expect(stored.consent).toHaveLength(1)
    expect(stored.suppression).toHaveLength(1)
    expect(stored.events).toHaveLength(1)
    expect((em.persist as jest.Mock)).toHaveBeenCalledTimes(1)
    expect((em.flush as jest.Mock)).toHaveBeenCalledTimes(1)
    const eventRow = stored.events[0]
    const envelope = crmAmsEventEnvelopeV1Schema.parse(eventRow.signedEnvelope)
    expect(verifyCrmAmsEventV1(envelope, { 'crm-event-test-1': publicKey }, nowMs)).toEqual({
      ok: true,
      value: envelope,
    })
    expect(eventRow).toMatchObject({ state: 'held_dark', projectionDigest: expect.stringMatching(/^[0-9a-f]{64}$/) })

    const serialized = JSON.stringify(stored)
    expect(serialized).not.toMatch(/@|https?:\/\/|renderedBody|providerResponse/i)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('returns an exact replay without creating a second authority or event row', async () => {
    const { em, stored } = inMemoryEm()
    await __test.projectAuthority(em, input, signer, nowMs)

    await expect(__test.projectAuthority(em, input, signer, nowMs + 900_000)).resolves.toMatchObject({
      action: 'replayed',
      state: 'held_dark',
    })
    expect(stored.consent).toHaveLength(1)
    expect(stored.suppression).toHaveLength(1)
    expect(stored.events).toHaveLength(1)
    expect((em.flush as jest.Mock)).toHaveBeenCalledTimes(1)
  })

  it('rejects same-version mutation and older versions instead of overwriting authority', async () => {
    const { em } = inMemoryEm()
    await __test.projectAuthority(em, nextInput({
      consent: { ...input.consent, version: '2' },
      suppression: { ...input.suppression, version: '2' },
    }), signer, nowMs)

    await expect(__test.projectAuthority(em, nextInput({
      event: {
        ...input.event,
        eventId: '55555555-5555-4555-8555-555555555555',
        nonce: 'bcdefghijklmnopqrstuvw',
        receiptRef: 'receipt:opaque:2',
      },
      consent: { ...input.consent, version: '2', state: 'withdrawn' },
      suppression: { ...input.suppression, version: '2' },
    }), signer, nowMs)).rejects.toEqual(
      new CrmAmsAuthorityProjectionConflict('consent_version_conflict'),
    )

    await expect(__test.projectAuthority(em, nextInput({
      event: {
        ...input.event,
        eventId: '66666666-6666-4666-8666-666666666666',
        nonce: 'cdefghijklmnopqrstuvwx',
        receiptRef: 'receipt:opaque:3',
      },
    }), signer, nowMs)).rejects.toEqual(
      new CrmAmsAuthorityProjectionConflict('stale_consent_version'),
    )
  })

  it('feeds the newly projected suppression version into the JIT fail-closed decision', async () => {
    const { em, stored } = inMemoryEm()
    const suppressed = nextInput({
      event: { ...input.event, eventType: 'suppression.changed' },
      suppression: { ...input.suppression, active: true, reasonCode: 'recipient_opt_out' },
    })
    await __test.projectAuthority(em, suppressed, signer, nowMs)

    const consent = stored.consent[0]
    const suppression = stored.suppression[0]
    expect(evaluateCrmAmsEligibilityV1({
      dependencyAvailable: true,
      nowMs,
      expectedConsentVersion: String(consent.version),
      expectedSuppressionVersion: String(suppression.version),
      consent: {
        version: String(consent.version),
        state: consent.state,
        effectiveAt: (consent.effectiveAt as Date).toISOString(),
        expiresAt: null,
      },
      suppression: {
        version: String(suppression.version),
        active: suppression.active,
        effectiveAt: (suppression.effectiveAt as Date).toISOString(),
      },
    })).toEqual({
      eligible: false,
      denialCode: 'suppressed',
      consentVersion: '1',
      suppressionVersion: '1',
    })
  })

  it('fails before resolving a database when the exact projection flag is off', async () => {
    delete process.env[CRM_AMS_AUTHORITY_PROJECTION_FLAG_V1]
    const resolve = jest.fn()

    await expect(__test.executeProjection(input, { container: { resolve } })).rejects.toEqual(
      new CrmAmsAuthorityProjectionConflict('projection_disabled'),
    )
    expect(resolve).not.toHaveBeenCalled()
  })

  it('uses one transaction when explicitly enabled and still returns no-send invariants', async () => {
    process.env[CRM_AMS_AUTHORITY_PROJECTION_FLAG_V1] = 'true'
    process.env.NOLI_CRM_AMS_SIGNING_KEY_VERSION_V1 = signer.keyVersion
    process.env.NOLI_CRM_AMS_SIGNING_PRIVATE_KEY_V1 = signer.privateKeyPem
    const { em } = inMemoryEm()
    const root = { fork: jest.fn(() => em) }
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(nowMs)

    await expect(__test.executeProjection(input, {
      container: { resolve: jest.fn(() => root) },
    })).resolves.toMatchObject({ eventDelivery: false, providerDispatch: false })
    expect((em.transactional as jest.Mock)).toHaveBeenCalledTimes(1)
    nowSpy.mockRestore()
  })
})
