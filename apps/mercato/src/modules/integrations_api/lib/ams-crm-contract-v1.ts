import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
  type KeyObject,
} from 'node:crypto'
import { z } from 'zod'

export const AMS_CRM_COMMAND_CONTRACT_V1 = 'noli.ams-crm.command.v1' as const
export const CRM_AMS_EVENT_CONTRACT_V1 = 'noli.crm-ams.event.v1' as const
export const CRM_AMS_ELIGIBILITY_LEASE_V1 = 'noli.crm-ams.eligibility-lease.v1' as const
export const AMS_CRM_COMMAND_ISSUER_V1 = 'noli-ams' as const
export const AMS_CRM_COMMAND_AUDIENCE_V1 = 'noli-crm' as const
export const CRM_AMS_EVENT_ISSUER_V1 = 'noli-crm' as const
export const CRM_AMS_EVENT_AUDIENCE_V1 = 'noli-ams' as const

export const AMS_CRM_CONTRACT_DESCRIPTOR_V1 = Object.freeze({
  contractVersion: 'noli.ams-crm.contract-descriptor.v1',
  commandContractVersion: AMS_CRM_COMMAND_CONTRACT_V1,
  eventContractVersion: CRM_AMS_EVENT_CONTRACT_V1,
  eligibilityLeaseVersion: CRM_AMS_ELIGIBILITY_LEASE_V1,
  signingAlgorithm: 'Ed25519',
  canonicalization: 'recursive-key-sort-json-utf8-v1',
  commandMaxLifetimeSeconds: 600,
  eventMaxLifetimeSeconds: 600,
  eligibilityLeaseMaxLifetimeSeconds: 60,
  piiPolicy: 'opaque-references-and-digests-only',
  providerDispatchImplemented: false,
} as const)

const uuid = z.string().uuid()
const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
const safeRef = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
const keyVersion = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
const nonce = z.string().min(22).max(128).regex(/^[A-Za-z0-9_-]+$/)
const positiveVersion = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(
  (value) => BigInt(value) <= BigInt('9223372036854775807'),
)

const contactUpsertPayloadSchema = z.object({
  commandType: z.literal('contact.upsert'),
  commandRef: safeRef,
  identityDigest: sha256,
  sealedPayloadRef: safeRef,
  sealedPayloadDigest: sha256,
  encryptionKeyVersion: keyVersion,
}).strict()

const eligibilityEvaluatePayloadSchema = z.object({
  commandType: z.literal('eligibility.evaluate'),
  commandRef: safeRef,
  crmContactRef: safeRef,
  purpose: z.enum(['marketing', 'transactional_asset']),
  expectedConsentVersion: positiveVersion,
  expectedSuppressionVersion: positiveVersion,
}).strict()

const marketingSendPayloadSchema = z.object({
  commandType: z.literal('marketing.send'),
  commandRef: safeRef,
  crmContactRef: safeRef,
  purpose: z.literal('marketing'),
  consentRef: safeRef,
  expectedConsentVersion: positiveVersion,
  expectedSuppressionVersion: positiveVersion,
  artifactVersionRef: safeRef,
  artifactSha256: sha256,
  contentRef: safeRef,
  approvalReceiptRef: safeRef,
  campaignRef: safeRef,
}).strict()

const contactExportPayloadSchema = z.object({
  commandType: z.literal('contact.export'),
  commandRef: safeRef,
  segmentRef: safeRef,
  segmentVersion: positiveVersion,
  approvalReceiptRef: safeRef,
}).strict()

export const amsCrmCommandPayloadV1Schema = z.discriminatedUnion('commandType', [
  contactUpsertPayloadSchema,
  eligibilityEvaluatePayloadSchema,
  marketingSendPayloadSchema,
  contactExportPayloadSchema,
])

const amsCrmCommandUnsignedV1Schema = z.object({
  contractVersion: z.literal(AMS_CRM_COMMAND_CONTRACT_V1),
  schemaVersion: z.literal(1),
  issuer: z.literal(AMS_CRM_COMMAND_ISSUER_V1),
  audience: z.literal(AMS_CRM_COMMAND_AUDIENCE_V1),
  keyVersion,
  commandId: uuid,
  idempotencyKey: safeRef,
  sourceOrganizationId: uuid,
  principalRef: uuid,
  issuedAt: instant,
  expiresAt: instant,
  nonce,
  payload: amsCrmCommandPayloadV1Schema,
}).strict()

export const amsCrmCommandEnvelopeV1Schema = amsCrmCommandUnsignedV1Schema.extend({
  signature: z.string().min(86).max(88).regex(/^[A-Za-z0-9_-]+$/),
}).strict()

export const crmAmsEventPayloadV1Schema = z.object({
  eventType: z.enum([
    'contact.upserted',
    'consent.changed',
    'suppression.changed',
    'delivery.accepted',
    'delivery.succeeded',
    'delivery.failed',
    'delivery.bounced',
    'delivery.complained',
    'delivery.unsubscribed',
    'engagement.opened',
    'engagement.clicked',
  ]),
  crmContactRef: safeRef,
  commandRef: safeRef.nullable(),
  deliveryRef: safeRef.nullable(),
  purpose: z.enum(['marketing', 'transactional_asset']).nullable(),
  consentVersion: positiveVersion.nullable(),
  suppressionVersion: positiveVersion.nullable(),
  safeOutcome: z.enum(['accepted', 'succeeded', 'failed', 'denied', 'unknown']),
  receiptRef: safeRef,
}).strict()

const crmAmsEventUnsignedV1Schema = z.object({
  contractVersion: z.literal(CRM_AMS_EVENT_CONTRACT_V1),
  schemaVersion: z.literal(1),
  issuer: z.literal(CRM_AMS_EVENT_ISSUER_V1),
  audience: z.literal(CRM_AMS_EVENT_AUDIENCE_V1),
  keyVersion,
  eventId: uuid,
  sourceOrganizationId: uuid,
  occurredAt: instant,
  expiresAt: instant,
  nonce,
  payload: crmAmsEventPayloadV1Schema,
}).strict()

export const crmAmsEventEnvelopeV1Schema = crmAmsEventUnsignedV1Schema.extend({
  signature: z.string().min(86).max(88).regex(/^[A-Za-z0-9_-]+$/),
}).strict()

const crmAmsEligibilityLeaseUnsignedV1BaseSchema = z.object({
  contractVersion: z.literal(CRM_AMS_ELIGIBILITY_LEASE_V1),
  schemaVersion: z.literal(1),
  issuer: z.literal(CRM_AMS_EVENT_ISSUER_V1),
  audience: z.literal(CRM_AMS_EVENT_AUDIENCE_V1),
  keyVersion,
  leaseId: uuid,
  sourceOrganizationId: uuid,
  crmContactRef: safeRef,
  purpose: z.enum(['marketing', 'transactional_asset']),
  consentVersion: positiveVersion.nullable(),
  suppressionVersion: positiveVersion.nullable(),
  eligible: z.boolean(),
  denialCode: z.enum([
    'consent_absent',
    'consent_denied',
    'consent_withdrawn',
    'consent_expired',
    'suppressed',
    'stale_expected_version',
    'dependency_unavailable',
  ]).nullable(),
  issuedAt: instant,
  expiresAt: instant,
  nonce,
}).strict()

const crmAmsEligibilityLeaseUnsignedV1Schema = crmAmsEligibilityLeaseUnsignedV1BaseSchema.superRefine((value, context) => {
  if (value.eligible === (value.denialCode !== null)) {
    context.addIssue({ code: 'custom', message: 'Eligibility and denial code disagree' })
  }
  if (value.eligible && (value.consentVersion === null || value.suppressionVersion === null)) {
    context.addIssue({ code: 'custom', message: 'Eligible leases require exact authority versions' })
  }
})

export const crmAmsEligibilityLeaseV1Schema = crmAmsEligibilityLeaseUnsignedV1BaseSchema.extend({
  signature: z.string().min(86).max(88).regex(/^[A-Za-z0-9_-]+$/),
}).strict().superRefine((value, context) => {
  if (value.eligible === (value.denialCode !== null)) {
    context.addIssue({ code: 'custom', message: 'Eligibility and denial code disagree' })
  }
  if (value.eligible && (value.consentVersion === null || value.suppressionVersion === null)) {
    context.addIssue({ code: 'custom', message: 'Eligible leases require exact authority versions' })
  }
})

export type AmsCrmCommandEnvelopeV1 = z.infer<typeof amsCrmCommandEnvelopeV1Schema>
export type AmsCrmCommandUnsignedV1 = z.infer<typeof amsCrmCommandUnsignedV1Schema>
export type CrmAmsEventEnvelopeV1 = z.infer<typeof crmAmsEventEnvelopeV1Schema>
export type CrmAmsEventUnsignedV1 = z.infer<typeof crmAmsEventUnsignedV1Schema>
export type CrmAmsEligibilityLeaseV1 = z.infer<typeof crmAmsEligibilityLeaseV1Schema>
export type CrmAmsEligibilityLeaseUnsignedV1 = z.infer<typeof crmAmsEligibilityLeaseUnsignedV1Schema>

type CanonicalValue = null | boolean | number | string | CanonicalValue[] | { [key: string]: CanonicalValue }

function canonicalJsonValue(value: unknown): CanonicalValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (Array.isArray(value)) return value.map(canonicalJsonValue)
  if (typeof value !== 'object') throw new Error('Unsupported canonical JSON value')
  const record = value as Record<string, unknown>
  const result: Record<string, CanonicalValue> = {}
  for (const key of Object.keys(record).sort()) result[key] = canonicalJsonValue(record[key])
  return result
}

export function canonicalJsonV1(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value))
}

export function sha256HexV1(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function commandCanonicalHashV1(command: AmsCrmCommandEnvelopeV1): string {
  const { signature: _signature, ...unsigned } = command
  return sha256HexV1(canonicalJsonV1(unsigned))
}

export function commandPayloadHashV1(command: AmsCrmCommandEnvelopeV1): string {
  return sha256HexV1(canonicalJsonV1(command.payload))
}

export function commandIdempotencyDigestV1(command: AmsCrmCommandEnvelopeV1): string {
  return sha256HexV1(`noli:ams-crm:idempotency:v1\0${command.sourceOrganizationId}\0${command.idempotencyKey}`)
}

export function commandNonceDigestV1(command: AmsCrmCommandEnvelopeV1): string {
  return sha256HexV1(`noli:ams-crm:nonce:v1\0${command.sourceOrganizationId}\0${command.nonce}`)
}

export function eventCanonicalHashV1(event: CrmAmsEventEnvelopeV1): string {
  const { signature: _signature, ...unsigned } = event
  return sha256HexV1(canonicalJsonV1(unsigned))
}

export function eventPayloadHashV1(event: CrmAmsEventEnvelopeV1): string {
  return sha256HexV1(canonicalJsonV1(event.payload))
}

export function eventNonceDigestV1(event: CrmAmsEventEnvelopeV1): string {
  return sha256HexV1(`noli:crm-ams:event-nonce:v1\0${event.sourceOrganizationId}\0${event.nonce}`)
}

export function amsCrmContractDescriptorHashV1(): string {
  return sha256HexV1(canonicalJsonV1(AMS_CRM_CONTRACT_DESCRIPTOR_V1))
}

function signingBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJsonV1(value), 'utf8')
}

function assertEd25519Key(key: KeyObject): void {
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Ed25519 key required')
}

function signEnvelope<T extends object>(unsigned: T, privateKey: KeyObject | string): T & { signature: string } {
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey
  assertEd25519Key(key)
  return { ...unsigned, signature: signBytes(null, signingBytes(unsigned), key).toString('base64url') }
}

export function signAmsCrmCommandV1(unsigned: AmsCrmCommandUnsignedV1, privateKey: KeyObject | string): AmsCrmCommandEnvelopeV1 {
  const parsed = amsCrmCommandUnsignedV1Schema.parse(unsigned)
  return amsCrmCommandEnvelopeV1Schema.parse(signEnvelope(parsed, privateKey))
}

export function signCrmAmsEventV1(unsigned: CrmAmsEventUnsignedV1, privateKey: KeyObject | string): CrmAmsEventEnvelopeV1 {
  const parsed = crmAmsEventUnsignedV1Schema.parse(unsigned)
  return crmAmsEventEnvelopeV1Schema.parse(signEnvelope(parsed, privateKey))
}

export function signCrmAmsEligibilityLeaseV1(
  unsigned: CrmAmsEligibilityLeaseUnsignedV1,
  privateKey: KeyObject | string,
): CrmAmsEligibilityLeaseV1 {
  const parsed = crmAmsEligibilityLeaseUnsignedV1Schema.parse(unsigned)
  return crmAmsEligibilityLeaseV1Schema.parse(signEnvelope(parsed, privateKey))
}

function verifyEnvelopeSignature(
  envelope: Record<string, unknown> & { signature: string },
  publicKey: KeyObject | string,
): boolean {
  const { signature, ...unsigned } = envelope
  const key = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey
  if (key.asymmetricKeyType !== 'ed25519') return false
  return verifyBytes(null, signingBytes(unsigned), key, Buffer.from(signature, 'base64url'))
}

function validateWindow(issuedAt: string, expiresAt: string, nowMs: number, maxLifetimeMs: number): boolean {
  const issuedMs = Date.parse(issuedAt)
  const expiresMs = Date.parse(expiresAt)
  return (
    Number.isFinite(issuedMs)
    && Number.isFinite(expiresMs)
    && issuedMs <= nowMs + 30_000
    && expiresMs > nowMs
    && expiresMs > issuedMs
    && expiresMs - issuedMs <= maxLifetimeMs
  )
}

export type SignatureVerificationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: 'invalid_envelope' | 'unknown_key' | 'invalid_signature' | 'invalid_time' }

export function verifyAmsCrmCommandV1(
  value: unknown,
  publicKeys: Readonly<Record<string, KeyObject | string>>,
  nowMs = Date.now(),
): SignatureVerificationResult<AmsCrmCommandEnvelopeV1> {
  const parsed = amsCrmCommandEnvelopeV1Schema.safeParse(value)
  if (!parsed.success) return { ok: false, code: 'invalid_envelope' }
  const key = publicKeys[parsed.data.keyVersion]
  if (!key) return { ok: false, code: 'unknown_key' }
  if (!verifyEnvelopeSignature(parsed.data, key)) return { ok: false, code: 'invalid_signature' }
  if (!validateWindow(parsed.data.issuedAt, parsed.data.expiresAt, nowMs, 600_000)) {
    return { ok: false, code: 'invalid_time' }
  }
  return { ok: true, value: parsed.data }
}

export function verifyCrmAmsEventV1(
  value: unknown,
  publicKeys: Readonly<Record<string, KeyObject | string>>,
  nowMs = Date.now(),
): SignatureVerificationResult<CrmAmsEventEnvelopeV1> {
  const parsed = crmAmsEventEnvelopeV1Schema.safeParse(value)
  if (!parsed.success) return { ok: false, code: 'invalid_envelope' }
  const key = publicKeys[parsed.data.keyVersion]
  if (!key) return { ok: false, code: 'unknown_key' }
  if (!verifyEnvelopeSignature(parsed.data, key)) return { ok: false, code: 'invalid_signature' }
  if (!validateWindow(parsed.data.occurredAt, parsed.data.expiresAt, nowMs, 600_000)) {
    return { ok: false, code: 'invalid_time' }
  }
  return { ok: true, value: parsed.data }
}

export function verifyCrmAmsEligibilityLeaseV1(
  value: unknown,
  publicKeys: Readonly<Record<string, KeyObject | string>>,
  nowMs = Date.now(),
): SignatureVerificationResult<CrmAmsEligibilityLeaseV1> {
  const parsed = crmAmsEligibilityLeaseV1Schema.safeParse(value)
  if (!parsed.success) return { ok: false, code: 'invalid_envelope' }
  const key = publicKeys[parsed.data.keyVersion]
  if (!key) return { ok: false, code: 'unknown_key' }
  if (!verifyEnvelopeSignature(parsed.data, key)) return { ok: false, code: 'invalid_signature' }
  if (!validateWindow(parsed.data.issuedAt, parsed.data.expiresAt, nowMs, 60_000)) {
    return { ok: false, code: 'invalid_time' }
  }
  return { ok: true, value: parsed.data }
}

export function parseEd25519PublicKeysV1(raw: string | undefined): Record<string, string> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const entries = Object.entries(parsed as Record<string, unknown>)
    if (entries.length < 1 || entries.length > 3) return {}
    const keys: Record<string, string> = {}
    for (const [version, pem] of entries) {
      if (!keyVersion.safeParse(version).success || typeof pem !== 'string' || pem.length > 4096) return {}
      const key = createPublicKey(pem)
      if (key.asymmetricKeyType !== 'ed25519') return {}
      keys[version] = pem
    }
    return keys
  } catch {
    return {}
  }
}

export function parseEd25519PrivateKeyV1(raw: string | undefined): KeyObject | null {
  if (!raw || raw.length > 8192) return null
  try {
    const key = createPrivateKey(raw)
    return key.asymmetricKeyType === 'ed25519' ? key : null
  } catch {
    return null
  }
}
