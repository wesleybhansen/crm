import type { EntityManager } from '@mikro-orm/postgresql'
import { registerCommand, type CommandHandler } from '@open-mercato/shared/lib/commands'
import {
  IntegrationsApiAmsEvent,
  IntegrationsApiConsentVersion,
  IntegrationsApiSuppressionVersion,
} from '../data/entities'
import {
  crmAmsAuthorityProjectionInputV1Schema,
  crmAmsAuthoritySignerV1Schema,
  type CrmAmsAuthorityProjectionInputV1,
  type CrmAmsAuthoritySignerV1,
} from '../data/validators'
import {
  CRM_AMS_EVENT_AUDIENCE_V1,
  CRM_AMS_EVENT_CONTRACT_V1,
  CRM_AMS_EVENT_ISSUER_V1,
  canonicalJsonV1,
  crmAmsEventEnvelopeV1Schema,
  eventCanonicalHashV1,
  eventNonceDigestV1,
  eventPayloadHashV1,
  sha256HexV1,
  signCrmAmsEventV1,
  type CrmAmsEventEnvelopeV1,
} from '../lib/ams-crm-contract-v1'

export const CRM_AMS_PROJECT_AUTHORITY_V1 = 'integrations_api.crm_ams.project_authority_v1' as const
export const CRM_AMS_AUTHORITY_PROJECTION_FLAG_V1 = 'NOLI_CRM_AMS_AUTHORITY_PROJECTION_V1_ENABLED' as const
export const CRM_AMS_EVENT_HELD_DARK_STATE_V1 = 'held_dark' as const

type AuthorityProjectionConflictCodeV1 =
  | 'consent_version_conflict'
  | 'stale_consent_version'
  | 'suppression_version_conflict'
  | 'stale_suppression_version'
  | 'event_id_conflict'
  | 'event_nonce_conflict'
  | 'projection_conflict'
  | 'invalid_event_window'
  | 'projection_disabled'

export class CrmAmsAuthorityProjectionConflict extends Error {
  constructor(readonly code: AuthorityProjectionConflictCodeV1) {
    super(code)
    this.name = 'CrmAmsAuthorityProjectionConflict'
  }
}

export type CrmAmsAuthorityProjectionResultV1 = {
  action: 'inserted' | 'replayed'
  state: typeof CRM_AMS_EVENT_HELD_DARK_STATE_V1
  eventId: string
  projectionDigest: string
  consentVersion: string
  suppressionVersion: string
  eventDelivery: false
  providerDispatch: false
}

type ProjectionStateV1 = {
  consentExact: IntegrationsApiConsentVersion | null
  consentLatest: IntegrationsApiConsentVersion | null
  suppressionExact: IntegrationsApiSuppressionVersion | null
  suppressionLatest: IntegrationsApiSuppressionVersion | null
  eventCandidates: IntegrationsApiAmsEvent[]
}

type ProjectionDecisionV1 =
  | { action: 'insert'; insertConsent: boolean; insertSuppression: boolean }
  | { action: 'replay' }

function eventPayload(input: CrmAmsAuthorityProjectionInputV1): CrmAmsEventEnvelopeV1['payload'] {
  return {
    eventType: input.event.eventType,
    crmContactRef: input.crmContactRef,
    commandRef: input.event.commandRef,
    deliveryRef: null,
    purpose: input.purpose,
    consentVersion: input.consent.version,
    suppressionVersion: input.suppression.version,
    safeOutcome: input.consent.state === 'granted' && !input.suppression.active ? 'accepted' : 'denied',
    receiptRef: input.event.receiptRef,
  }
}

function projectionCanonicalValue(input: CrmAmsAuthorityProjectionInputV1): unknown {
  return {
    contractVersion: 'noli.crm-ams.authority-projection.v1',
    organizationId: input.organizationId,
    tenantId: input.tenantId,
    sourceOrganizationId: input.sourceOrganizationId,
    crmContactRef: input.crmContactRef,
    purpose: input.purpose,
    eventType: input.event.eventType,
    commandRef: input.event.commandRef,
    receiptRef: input.event.receiptRef,
    consent: input.consent,
    suppression: input.suppression,
  }
}

export function crmAmsAuthorityProjectionDigestV1(value: unknown): string {
  const input = crmAmsAuthorityProjectionInputV1Schema.parse(value)
  return sha256HexV1(canonicalJsonV1(projectionCanonicalValue(input)))
}

function incomingNonceDigest(input: CrmAmsAuthorityProjectionInputV1): string {
  return sha256HexV1(
    `noli:crm-ams:event-nonce:v1\0${input.sourceOrganizationId}\0${input.event.nonce}`,
  )
}

function sameInstant(value: Date | null | undefined, expected: string | null): boolean {
  if (expected === null) return value === null || value === undefined
  return value instanceof Date && value.toISOString() === expected
}

function consentMatches(
  row: IntegrationsApiConsentVersion | null,
  input: CrmAmsAuthorityProjectionInputV1,
): boolean {
  return Boolean(
    row
    && row.deletedAt == null
    && row.crmContactRef === input.crmContactRef
    && row.purpose === input.purpose
    && row.version === input.consent.version
    && row.state === input.consent.state
    && row.policyRef === input.consent.policyRef
    && row.sourceRef === input.consent.sourceRef
    && sameInstant(row.effectiveAt, input.consent.effectiveAt)
    && sameInstant(row.expiresAt, input.consent.expiresAt),
  )
}

function suppressionMatches(
  row: IntegrationsApiSuppressionVersion | null,
  input: CrmAmsAuthorityProjectionInputV1,
): boolean {
  return Boolean(
    row
    && row.deletedAt == null
    && row.crmContactRef === input.crmContactRef
    && row.channel === 'email'
    && row.version === input.suppression.version
    && row.active === input.suppression.active
    && row.reasonCode === input.suppression.reasonCode
    && sameInstant(row.effectiveAt, input.suppression.effectiveAt),
  )
}

function eventMatches(
  row: IntegrationsApiAmsEvent,
  input: CrmAmsAuthorityProjectionInputV1,
  projectionDigest: string,
  nonceDigest: string,
): boolean {
  const parsedEnvelope = crmAmsEventEnvelopeV1Schema.safeParse(row.signedEnvelope)
  if (!parsedEnvelope.success) return false
  const envelope = parsedEnvelope.data
  return (
    row.deletedAt == null
    && row.state === CRM_AMS_EVENT_HELD_DARK_STATE_V1
    && row.eventId === input.event.eventId
    && row.nonceDigest === nonceDigest
    && row.projectionDigest === projectionDigest
    && row.sourceOrganizationId === input.sourceOrganizationId
    && row.eventType === input.event.eventType
    && row.contractVersion === CRM_AMS_EVENT_CONTRACT_V1
    && row.schemaVersion === 1
    && row.issuer === CRM_AMS_EVENT_ISSUER_V1
    && row.audience === CRM_AMS_EVENT_AUDIENCE_V1
    && row.keyVersion === envelope.keyVersion
    && sameInstant(row.occurredAt, input.event.occurredAt)
    && sameInstant(row.expiresAt, input.event.expiresAt)
    && envelope.eventId === input.event.eventId
    && envelope.sourceOrganizationId === input.sourceOrganizationId
    && envelope.occurredAt === input.event.occurredAt
    && envelope.expiresAt === input.event.expiresAt
    && envelope.nonce === input.event.nonce
    && canonicalJsonV1(envelope.payload) === canonicalJsonV1(eventPayload(input))
    && row.canonicalHash === eventCanonicalHashV1(envelope)
    && row.payloadDigest === eventPayloadHashV1(envelope)
    && row.nonceDigest === eventNonceDigestV1(envelope)
  )
}

function eventConflictCode(
  row: IntegrationsApiAmsEvent,
  input: CrmAmsAuthorityProjectionInputV1,
  projectionDigest: string,
  nonceDigest: string,
): AuthorityProjectionConflictCodeV1 {
  if (row.eventId === input.event.eventId) return 'event_id_conflict'
  if (row.nonceDigest === nonceDigest) return 'event_nonce_conflict'
  if (row.projectionDigest === projectionDigest) return 'projection_conflict'
  return 'projection_conflict'
}

function decideProjection(
  state: ProjectionStateV1,
  input: CrmAmsAuthorityProjectionInputV1,
  projectionDigest: string,
  nonceDigest: string,
): ProjectionDecisionV1 {
  if (state.consentExact && !consentMatches(state.consentExact, input)) {
    throw new CrmAmsAuthorityProjectionConflict('consent_version_conflict')
  }
  if (!state.consentExact && state.consentLatest
    && BigInt(state.consentLatest.version) >= BigInt(input.consent.version)) {
    throw new CrmAmsAuthorityProjectionConflict('stale_consent_version')
  }
  if (state.suppressionExact && !suppressionMatches(state.suppressionExact, input)) {
    throw new CrmAmsAuthorityProjectionConflict('suppression_version_conflict')
  }
  if (!state.suppressionExact && state.suppressionLatest
    && BigInt(state.suppressionLatest.version) >= BigInt(input.suppression.version)) {
    throw new CrmAmsAuthorityProjectionConflict('stale_suppression_version')
  }

  if (state.eventCandidates.length > 0) {
    const exact = state.eventCandidates.length === 1
      && eventMatches(state.eventCandidates[0], input, projectionDigest, nonceDigest)
      && consentMatches(state.consentExact, input)
      && suppressionMatches(state.suppressionExact, input)
    if (exact) return { action: 'replay' }
    throw new CrmAmsAuthorityProjectionConflict(
      eventConflictCode(state.eventCandidates[0], input, projectionDigest, nonceDigest),
    )
  }

  return {
    action: 'insert',
    insertConsent: state.consentExact === null,
    insertSuppression: state.suppressionExact === null,
  }
}

async function loadProjectionState(
  em: EntityManager,
  input: CrmAmsAuthorityProjectionInputV1,
  projectionDigest: string,
  nonceDigest: string,
): Promise<ProjectionStateV1> {
  const consentScope = {
    organizationId: input.organizationId,
    tenantId: input.tenantId,
    crmContactRef: input.crmContactRef,
    purpose: input.purpose,
  }
  const suppressionScope = {
    organizationId: input.organizationId,
    tenantId: input.tenantId,
    crmContactRef: input.crmContactRef,
    channel: 'email',
  }
  const eventScope = {
    organizationId: input.organizationId,
    tenantId: input.tenantId,
  }

  const consentExact = await em.findOne(IntegrationsApiConsentVersion, {
    ...consentScope,
    version: input.consent.version,
  })
  const consentLatest = await em.findOne(
    IntegrationsApiConsentVersion,
    { ...consentScope, deletedAt: null },
    { orderBy: { version: 'DESC' } },
  )
  const suppressionExact = await em.findOne(IntegrationsApiSuppressionVersion, {
    ...suppressionScope,
    version: input.suppression.version,
  })
  const suppressionLatest = await em.findOne(
    IntegrationsApiSuppressionVersion,
    { ...suppressionScope, deletedAt: null },
    { orderBy: { version: 'DESC' } },
  )
  const eventCandidates = await em.find(IntegrationsApiAmsEvent, {
    ...eventScope,
    $or: [
      { eventId: input.event.eventId },
      { nonceDigest },
      { projectionDigest },
    ],
  })

  return { consentExact, consentLatest, suppressionExact, suppressionLatest, eventCandidates }
}

function assertInsertableEventWindow(input: CrmAmsAuthorityProjectionInputV1, nowMs: number): void {
  const occurredMs = Date.parse(input.event.occurredAt)
  const expiresMs = Date.parse(input.event.expiresAt)
  if (
    !Number.isFinite(occurredMs)
    || !Number.isFinite(expiresMs)
    || occurredMs > nowMs + 30_000
    || expiresMs <= nowMs
    || expiresMs <= occurredMs
    || expiresMs - occurredMs > 600_000
  ) {
    throw new CrmAmsAuthorityProjectionConflict('invalid_event_window')
  }
}

function result(
  action: 'inserted' | 'replayed',
  input: CrmAmsAuthorityProjectionInputV1,
  projectionDigest: string,
): CrmAmsAuthorityProjectionResultV1 {
  return {
    action,
    state: CRM_AMS_EVENT_HELD_DARK_STATE_V1,
    eventId: input.event.eventId,
    projectionDigest,
    consentVersion: input.consent.version,
    suppressionVersion: input.suppression.version,
    eventDelivery: false,
    providerDispatch: false,
  }
}

async function projectAuthority(
  em: EntityManager,
  value: unknown,
  signerValue: unknown,
  nowMs = Date.now(),
): Promise<CrmAmsAuthorityProjectionResultV1> {
  const input = crmAmsAuthorityProjectionInputV1Schema.parse(value)
  const projectionDigest = crmAmsAuthorityProjectionDigestV1(input)
  const nonceDigest = incomingNonceDigest(input)
  const state = await loadProjectionState(em, input, projectionDigest, nonceDigest)
  const decision = decideProjection(state, input, projectionDigest, nonceDigest)
  if (decision.action === 'replay') return result('replayed', input, projectionDigest)

  assertInsertableEventWindow(input, nowMs)
  const signer = crmAmsAuthoritySignerV1Schema.parse(signerValue)
  const envelope = signCrmAmsEventV1({
    contractVersion: CRM_AMS_EVENT_CONTRACT_V1,
    schemaVersion: 1,
    issuer: CRM_AMS_EVENT_ISSUER_V1,
    audience: CRM_AMS_EVENT_AUDIENCE_V1,
    keyVersion: signer.keyVersion,
    eventId: input.event.eventId,
    sourceOrganizationId: input.sourceOrganizationId,
    occurredAt: input.event.occurredAt,
    expiresAt: input.event.expiresAt,
    nonce: input.event.nonce,
    payload: eventPayload(input),
  }, signer.privateKeyPem)

  const records: Array<IntegrationsApiConsentVersion | IntegrationsApiSuppressionVersion | IntegrationsApiAmsEvent> = []
  if (decision.insertConsent) {
    records.push(em.create(IntegrationsApiConsentVersion, {
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      crmContactRef: input.crmContactRef,
      purpose: input.purpose,
      version: input.consent.version,
      state: input.consent.state,
      policyRef: input.consent.policyRef,
      sourceRef: input.consent.sourceRef,
      effectiveAt: new Date(input.consent.effectiveAt),
      expiresAt: input.consent.expiresAt === null ? null : new Date(input.consent.expiresAt),
    }))
  }
  if (decision.insertSuppression) {
    records.push(em.create(IntegrationsApiSuppressionVersion, {
      organizationId: input.organizationId,
      tenantId: input.tenantId,
      crmContactRef: input.crmContactRef,
      channel: 'email',
      version: input.suppression.version,
      active: input.suppression.active,
      reasonCode: input.suppression.reasonCode,
      effectiveAt: new Date(input.suppression.effectiveAt),
    }))
  }
  records.push(em.create(IntegrationsApiAmsEvent, {
    organizationId: input.organizationId,
    tenantId: input.tenantId,
    sourceOrganizationId: input.sourceOrganizationId,
    eventId: input.event.eventId,
    eventType: input.event.eventType,
    contractVersion: envelope.contractVersion,
    schemaVersion: envelope.schemaVersion,
    issuer: envelope.issuer,
    audience: envelope.audience,
    canonicalHash: eventCanonicalHashV1(envelope),
    payloadDigest: eventPayloadHashV1(envelope),
    nonceDigest: eventNonceDigestV1(envelope),
    projectionDigest,
    signedEnvelope: { ...envelope },
    keyVersion: envelope.keyVersion,
    occurredAt: new Date(envelope.occurredAt),
    expiresAt: new Date(envelope.expiresAt),
    state: CRM_AMS_EVENT_HELD_DARK_STATE_V1,
  }))

  em.persist(records)
  await em.flush()
  return result('inserted', input, projectionDigest)
}

function signerFromEnvironment(): CrmAmsAuthoritySignerV1 {
  return crmAmsAuthoritySignerV1Schema.parse({
    keyVersion: process.env.NOLI_CRM_AMS_SIGNING_KEY_VERSION_V1,
    privateKeyPem: process.env.NOLI_CRM_AMS_SIGNING_PRIVATE_KEY_V1,
  })
}

async function executeProjection(
  value: CrmAmsAuthorityProjectionInputV1,
  ctx: { container: { resolve(name: 'em'): unknown } },
): Promise<CrmAmsAuthorityProjectionResultV1> {
  if (process.env[CRM_AMS_AUTHORITY_PROJECTION_FLAG_V1] !== 'true') {
    throw new CrmAmsAuthorityProjectionConflict('projection_disabled')
  }
  const input = crmAmsAuthorityProjectionInputV1Schema.parse(value)
  const signer = signerFromEnvironment()
  const root = ctx.container.resolve('em') as EntityManager
  const em = root.fork()
  try {
    return await em.transactional((transaction) => projectAuthority(transaction, input, signer))
  } catch (error) {
    if (error instanceof CrmAmsAuthorityProjectionConflict) throw error
    const retryEm = root.fork()
    const projectionDigest = crmAmsAuthorityProjectionDigestV1(input)
    const nonceDigest = incomingNonceDigest(input)
    const state = await loadProjectionState(retryEm, input, projectionDigest, nonceDigest)
    const decision = decideProjection(state, input, projectionDigest, nonceDigest)
    if (decision.action === 'replay') return result('replayed', input, projectionDigest)
    throw error
  }
}

const authorityProjectionCommand: CommandHandler<
  CrmAmsAuthorityProjectionInputV1,
  CrmAmsAuthorityProjectionResultV1
> = {
  id: CRM_AMS_PROJECT_AUTHORITY_V1,
  execute: executeProjection,
  buildLog({ input, result: commandResult }) {
    if (commandResult.action === 'replayed') return null
    return {
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      resourceKind: 'integrations_api.ams_event',
      resourceId: commandResult.eventId,
      actionLabel: 'Project CRM authority into the held-dark AMS event outbox',
      context: {
        action: commandResult.action,
        eventType: input.event.eventType,
        projectionDigest: commandResult.projectionDigest,
        state: commandResult.state,
      },
    }
  },
}

registerCommand(authorityProjectionCommand)

export const __test = {
  decideProjection,
  executeProjection,
  incomingNonceDigest,
  loadProjectionState,
  projectAuthority,
}
