import { generateKeyPairSync } from 'node:crypto'
import {
  AMS_CRM_COMMAND_AUDIENCE_V1,
  AMS_CRM_COMMAND_CONTRACT_V1,
  AMS_CRM_COMMAND_ISSUER_V1,
  amsCrmCommandEnvelopeV1Schema,
  amsCrmContractDescriptorHashV1,
  canonicalJsonV1,
  commandCanonicalHashV1,
  commandIdempotencyDigestV1,
  commandNonceDigestV1,
  crmAmsEligibilityLeaseV1Schema,
  parseEd25519PublicKeysV1,
  parseEd25519PrivateKeyV1,
  signAmsCrmCommandV1,
  signCrmAmsEligibilityLeaseV1,
  verifyAmsCrmCommandV1,
  verifyCrmAmsEligibilityLeaseV1,
  type AmsCrmCommandUnsignedV1,
} from '../ams-crm-contract-v1'
import { decideAmsCrmReplayV1 } from '../ams-crm-replay-v1'

const now = '2026-08-22T20:00:00.000Z'
const nowMs = Date.parse(now)
const keys = generateKeyPairSync('ed25519')
const otherKeys = generateKeyPairSync('ed25519')

const unsigned: AmsCrmCommandUnsignedV1 = {
  contractVersion: AMS_CRM_COMMAND_CONTRACT_V1,
  schemaVersion: 1,
  issuer: AMS_CRM_COMMAND_ISSUER_V1,
  audience: AMS_CRM_COMMAND_AUDIENCE_V1,
  keyVersion: 'crm-test-1',
  commandId: '11111111-1111-4111-8111-111111111111',
  idempotencyKey: 'campaign:42:contact:7',
  sourceOrganizationId: '22222222-2222-4222-8222-222222222222',
  principalRef: '33333333-3333-4333-8333-333333333333',
  issuedAt: now,
  expiresAt: '2026-08-22T20:05:00.000Z',
  nonce: 'abcdefghijklmnopqrstuv',
  payload: {
    commandType: 'marketing.send',
    commandRef: 'command:42',
    crmContactRef: 'contact:7',
    purpose: 'marketing',
    consentRef: 'consent:3',
    expectedConsentVersion: '3',
    expectedSuppressionVersion: '7',
    artifactVersionRef: 'newsletter:12:v4',
    artifactSha256: 'a'.repeat(64),
    contentRef: 'crm-content:88',
    approvalReceiptRef: 'approval:99',
    campaignRef: 'campaign:42',
  },
}

describe('AMS CRM signed authority contracts v1', () => {
  it('signs and verifies a strict Ed25519 command envelope', () => {
    const signed = signAmsCrmCommandV1(unsigned, keys.privateKey)

    expect(amsCrmCommandEnvelopeV1Schema.parse(signed)).toEqual(signed)
    expect(verifyAmsCrmCommandV1(signed, { 'crm-test-1': keys.publicKey }, nowMs)).toEqual({
      ok: true,
      value: signed,
    })
    expect(commandCanonicalHashV1(signed)).toMatch(/^[0-9a-f]{64}$/)
    expect(commandIdempotencyDigestV1(signed)).toMatch(/^[0-9a-f]{64}$/)
    expect(commandNonceDigestV1(signed)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects a forged payload, wrong key, stale window, and wrong audience', () => {
    const signed = signAmsCrmCommandV1(unsigned, keys.privateKey)
    const forged = { ...signed, payload: { ...signed.payload, campaignRef: 'campaign:evil' } }
    expect(verifyAmsCrmCommandV1(forged, { 'crm-test-1': keys.publicKey }, nowMs)).toEqual({
      ok: false,
      code: 'invalid_signature',
    })
    expect(verifyAmsCrmCommandV1(signed, { 'crm-test-1': otherKeys.publicKey }, nowMs)).toEqual({
      ok: false,
      code: 'invalid_signature',
    })
    expect(verifyAmsCrmCommandV1(signed, { 'crm-test-1': keys.publicKey }, nowMs + 600_000)).toEqual({
      ok: false,
      code: 'invalid_time',
    })
    expect(verifyAmsCrmCommandV1({ ...signed, audience: 'somewhere-else' }, { 'crm-test-1': keys.publicKey }, nowMs)).toEqual({
      ok: false,
      code: 'invalid_envelope',
    })
  })

  it('canonicalizes key order and rejects non-canonical timestamps and plaintext PII fields', () => {
    expect(canonicalJsonV1({ z: 1, a: { y: 2, b: 3 } })).toBe('{"a":{"b":3,"y":2},"z":1}')
    const signed = signAmsCrmCommandV1(unsigned, keys.privateKey)
    expect(amsCrmCommandEnvelopeV1Schema.safeParse({ ...signed, issuedAt: '2026-08-22T20:00:00Z' }).success).toBe(false)
    expect(amsCrmCommandEnvelopeV1Schema.safeParse({
      ...signed,
      payload: { ...signed.payload, email: 'private@example.test' },
    }).success).toBe(false)
  })

  it('accepts at most three explicitly versioned Ed25519 public keys', () => {
    const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    expect(parseEd25519PublicKeysV1(JSON.stringify({ 'crm-test-1': publicPem }))).toEqual({
      'crm-test-1': publicPem,
    })
    expect(parseEd25519PublicKeysV1('{not-json')).toEqual({})
    expect(parseEd25519PublicKeysV1(JSON.stringify({ bad: 'not a key' }))).toEqual({})
    expect(parseEd25519PrivateKeyV1(keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())?.asymmetricKeyType).toBe('ed25519')
    expect(parseEd25519PrivateKeyV1('not a private key')).toBeNull()
  })

  it('binds eligibility and denial code in the lease schema', () => {
    const baseLease = {
      contractVersion: 'noli.crm-ams.eligibility-lease.v1',
      schemaVersion: 1,
      issuer: 'noli-crm',
      audience: 'noli-ams',
      keyVersion: 'crm-test-1',
      leaseId: '44444444-4444-4444-8444-444444444444',
      sourceOrganizationId: unsigned.sourceOrganizationId,
      crmContactRef: 'contact:7',
      purpose: 'marketing',
      consentVersion: '3',
      suppressionVersion: '7',
      eligible: true,
      denialCode: null,
      issuedAt: now,
      expiresAt: '2026-08-22T20:00:30.000Z',
      nonce: 'zyxwvutsrqponmlkjihgfe',
      signature: 'A'.repeat(86),
    }
    expect(crmAmsEligibilityLeaseV1Schema.safeParse(baseLease).success).toBe(true)
    expect(crmAmsEligibilityLeaseV1Schema.safeParse({
      ...baseLease,
      eligible: false,
      denialCode: null,
    }).success).toBe(false)
  })

  it('signs a fail-closed denial lease without inventing authority versions', () => {
    const lease = signCrmAmsEligibilityLeaseV1({
      contractVersion: 'noli.crm-ams.eligibility-lease.v1',
      schemaVersion: 1,
      issuer: 'noli-crm',
      audience: 'noli-ams',
      keyVersion: 'crm-test-1',
      leaseId: '55555555-5555-4555-8555-555555555555',
      sourceOrganizationId: unsigned.sourceOrganizationId,
      crmContactRef: 'contact:7',
      purpose: 'marketing',
      consentVersion: null,
      suppressionVersion: null,
      eligible: false,
      denialCode: 'dependency_unavailable',
      issuedAt: now,
      expiresAt: '2026-08-22T20:00:30.000Z',
      nonce: 'abcdefghijklmnopqrstuv',
    }, keys.privateKey)

    expect(verifyCrmAmsEligibilityLeaseV1(lease, { 'crm-test-1': keys.publicKey }, nowMs)).toEqual({
      ok: true,
      value: lease,
    })
  })

  it('returns exact replay only for identical canonical authority', () => {
    const signed = signAmsCrmCommandV1(unsigned, keys.privateKey)
    const incoming = {
      commandId: signed.commandId,
      idempotencyDigest: commandIdempotencyDigestV1(signed),
      nonceDigest: commandNonceDigestV1(signed),
      canonicalHash: commandCanonicalHashV1(signed),
    }
    expect(decideAmsCrmReplayV1(incoming, [])).toEqual({ action: 'insert' })
    expect(decideAmsCrmReplayV1(incoming, [{ ...incoming, state: 'shadow_validated' }])).toEqual({
      action: 'replay',
      state: 'shadow_validated',
    })
    expect(decideAmsCrmReplayV1(
      { ...incoming, canonicalHash: 'f'.repeat(64) },
      [{ ...incoming, state: 'shadow_validated' }],
    )).toEqual({ action: 'conflict', code: 'command_id_conflict' })
  })

  it('freezes the descriptor to a stable content-addressed hash', () => {
    expect(amsCrmContractDescriptorHashV1()).toMatch(/^[0-9a-f]{64}$/)
    expect(amsCrmContractDescriptorHashV1()).toBe(amsCrmContractDescriptorHashV1())
  })
})
