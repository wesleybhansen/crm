import { generateKeyPairSync } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  AmsCrmShadowCommandConflict,
  __test,
} from '../ams-crm'
import {
  AMS_CRM_COMMAND_AUDIENCE_V1,
  AMS_CRM_COMMAND_CONTRACT_V1,
  AMS_CRM_COMMAND_ISSUER_V1,
  commandCanonicalHashV1,
  commandIdempotencyDigestV1,
  commandNonceDigestV1,
  signAmsCrmCommandV1,
  type AmsCrmCommandUnsignedV1,
} from '../../lib/ams-crm-contract-v1'

const { privateKey } = generateKeyPairSync('ed25519')
const unsigned: AmsCrmCommandUnsignedV1 = {
  contractVersion: AMS_CRM_COMMAND_CONTRACT_V1,
  schemaVersion: 1,
  issuer: AMS_CRM_COMMAND_ISSUER_V1,
  audience: AMS_CRM_COMMAND_AUDIENCE_V1,
  keyVersion: 'ams-command-test-1',
  commandId: '11111111-1111-4111-8111-111111111111',
  idempotencyKey: 'contact:opaque:upsert:1',
  sourceOrganizationId: '22222222-2222-4222-8222-222222222222',
  principalRef: '33333333-3333-4333-8333-333333333333',
  issuedAt: '2026-08-22T20:00:00.000Z',
  expiresAt: '2026-08-22T20:05:00.000Z',
  nonce: 'abcdefghijklmnopqrstuv',
  payload: {
    commandType: 'contact.upsert',
    commandRef: 'command:opaque:1',
    identityDigest: 'a'.repeat(64),
    sealedPayloadRef: 'vault:opaque:1',
    sealedPayloadDigest: 'b'.repeat(64),
    encryptionKeyVersion: 'crm-envelope-1',
  },
}
const envelope = signAmsCrmCommandV1(unsigned, privateKey)
const input = {
  organizationId: '44444444-4444-4444-8444-444444444444',
  tenantId: '55555555-5555-4555-8555-555555555555',
  envelope,
}

function fakeEm(existing: Array<Record<string, unknown>> = []) {
  const created: Array<Record<string, unknown>> = []
  const em = {
    find: jest.fn(async () => existing),
    create: jest.fn((_entity, value: Record<string, unknown>) => {
      const row = { ...value }
      created.push(row)
      return row
    }),
    persistAndFlush: jest.fn(async () => undefined),
  } as unknown as EntityManager
  return { em, created }
}

describe('AMS CRM shadow command handler v1', () => {
  it('persists only tenant-scoped privacy-minimal digest metadata', async () => {
    const { em, created } = fakeEm()
    const result = await __test.acceptShadowCommand(em, input)

    expect(result).toMatchObject({ action: 'inserted', state: 'shadow_validated' })
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      principalRef: envelope.principalRef,
      commandId: envelope.commandId,
      commandType: 'contact.upsert',
      contractVersion: envelope.contractVersion,
      canonicalHash: commandCanonicalHashV1(envelope),
      idempotencyDigest: commandIdempotencyDigestV1(envelope),
      nonceDigest: commandNonceDigestV1(envelope),
    })
    const serialized = JSON.stringify(created[0])
    expect(serialized).not.toContain('private@example.test')
    expect(serialized).not.toContain('sealedPayloadRef')
    expect(serialized).not.toContain('vault:opaque:1')
  })

  it('returns exact replay without a second insert', async () => {
    const identity = {
      commandId: envelope.commandId,
      idempotencyDigest: commandIdempotencyDigestV1(envelope),
      nonceDigest: commandNonceDigestV1(envelope),
      canonicalHash: commandCanonicalHashV1(envelope),
      state: 'shadow_validated',
    }
    const { em, created } = fakeEm([identity])

    await expect(__test.acceptShadowCommand(em, input)).resolves.toMatchObject({ action: 'replayed' })
    expect(created).toHaveLength(0)
  })

  it('rejects the same command identity with different canonical bytes', async () => {
    const { em } = fakeEm([{
      commandId: envelope.commandId,
      idempotencyDigest: commandIdempotencyDigestV1(envelope),
      nonceDigest: commandNonceDigestV1(envelope),
      canonicalHash: 'f'.repeat(64),
      state: 'shadow_validated',
    }])

    await expect(__test.acceptShadowCommand(em, input)).rejects.toEqual(
      new AmsCrmShadowCommandConflict('command_id_conflict'),
    )
  })
})
