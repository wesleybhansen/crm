import crypto from 'crypto'
import { UniqueConstraintViolationException } from '@mikro-orm/core'
import { EmailMessage } from '../../../email/data/schema'
import {
  GtmAuditEvent,
  GtmCampaignVersion,
  GtmCandidate,
  GtmCandidateMatch,
  GtmCandidateRelation,
  GtmChatMessage,
  GtmContactPoint,
  GtmDeletionRequest,
  GtmDsrOperation,
  GtmEnrollment,
  GtmEvidence,
  GtmInboundEvent,
  GtmManualOutreachDraft,
  GtmProviderOperation,
  GtmRenderedMessage,
  GtmReply,
  GtmSendAttempt,
} from '../../data/entities'
import type { Clock, ExecutionEm } from '../execute/schedule'
import {
  GLOBAL_SUPPRESSION_ORG_ID,
  GLOBAL_SUPPRESSION_TENANT_ID,
} from './constants'

type RemovalPoint = Pick<
  GtmContactPoint,
  'id' | 'organizationId' | 'tenantId' | 'candidateId' | 'value'
>

export type DeletionResult = {
  request: GtmDeletionRequest
  candidatesAnonymized: number
  evidenceAnonymized: number
  contactPointsAnonymized: number
  relationsAnonymized: number
  renderedMessagesAnonymized: number
  repliesAnonymized: number
  emailMessagesAnonymized: number
  manualDraftsAnonymized: number
  providerReceiptsRedacted: number
  dsrOperations: number
}

function resultFromStoredRequest(request: GtmDeletionRequest): DeletionResult {
  const stored = request.resultCounts ?? {}
  const count = (key: string) => {
    const value = stored[key]
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
  }
  return {
    request,
    candidatesAnonymized: count('candidates_anonymized'),
    evidenceAnonymized: count('evidence_anonymized'),
    contactPointsAnonymized: count('contact_points_anonymized'),
    relationsAnonymized: count('relations_anonymized'),
    renderedMessagesAnonymized: count('rendered_messages_anonymized'),
    repliesAnonymized: count('replies_anonymized'),
    emailMessagesAnonymized: count('email_messages_anonymized'),
    manualDraftsAnonymized: count('manual_drafts_anonymized'),
    providerReceiptsRedacted: count('provider_receipts_redacted'),
    dsrOperations: count('dsr_operations'),
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

const BILLING_KEY = /(amount|bill|charge|cost|credit|currency|outcome|price|status|unit)/i

export function redactReceipt(receipt: Record<string, unknown> | null | undefined) {
  if (!receipt) return null
  const redacted: Record<string, unknown> = { original_hash: digest(receipt), redacted: true }
  for (const [key, value] of Object.entries(receipt)) {
    if (BILLING_KEY.test(key) && ['string', 'number', 'boolean'].includes(typeof value)) {
      redacted[key] = value
    }
  }
  return redacted
}

const REMOVED_EMAIL_ADDRESS = 'removed@deleted.invalid'

function linkedEmailMessageIds(
  ...groups: Array<Array<{ emailMessageId?: string | null }>>
): string[] {
  return [
    ...new Set(
      groups
        .flatMap((rows) => rows.map((row) => row.emailMessageId))
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ]
}

function anonymizeEmailMessage(row: EmailMessage, now: Date): void {
  const originalHash = digest({
    from_address: row.fromAddress,
    to_address: row.toAddress,
    cc: row.cc,
    bcc: row.bcc,
    subject: row.subject,
    body_html: row.bodyHtml,
    body_text: row.bodyText,
    thread_id: row.threadId,
    contact_id: row.contactId,
    deal_id: row.dealId,
    campaign_id: row.campaignId,
    metadata: row.metadata,
    sentiment: row.sentiment,
  })
  row.fromAddress = REMOVED_EMAIL_ADDRESS
  row.toAddress = REMOVED_EMAIL_ADDRESS
  row.cc = null
  row.bcc = null
  row.subject = '[removed]'
  row.bodyHtml = ''
  row.bodyText = null
  row.threadId = null
  row.contactId = null
  row.dealId = null
  row.campaignId = null
  row.metadata = { removed: true, original_hash: originalHash }
  row.sentiment = null
  row.deletedAt = now
  row.updatedAt = now
}

function completeLocalEmailOperation(
  operation: GtmDsrOperation,
  recordsAnonymized: number,
  now: Date,
): void {
  operation.status = 'completed'
  operation.nextAttemptAt = null
  operation.lastError = null
  operation.receipt = {
    completed_locally: true,
    completed_at: now.toISOString(),
    records_anonymized: recordsAnonymized,
  }
  operation.completedAt = now
  operation.updatedAt = now
}

function redactSnapshot(
  value: unknown,
  target: { normalizedAddress: string; addressHash: string; candidateIds: ReadonlySet<string> },
  insideTarget = false,
): unknown {
  if (typeof value === 'string') {
    if (value.trim().toLowerCase() === target.normalizedAddress) return '[removed]'
    return value
  }
  if (Array.isArray(value)) return value.map((item) => redactSnapshot(item, target, insideTarget))
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const candidateId = record.candidate_id ?? record.candidateId
  const recipientHash = record.address_hash ?? record.addressHash ?? record.recipient_address_hash
  const targetObject =
    insideTarget ||
    (typeof candidateId === 'string' && target.candidateIds.has(candidateId)) ||
    recipientHash === target.addressHash
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(record)) {
    if (targetObject && /^(address|email|name|display_name|recipient)$/i.test(key)) {
      out[key] = '[removed]'
    } else {
      out[key] = redactSnapshot(item, target, targetObject)
    }
  }
  return out
}

async function createOrLoadRequest(
  em: ExecutionEm,
  addressHash: string,
  now: Date,
): Promise<GtmDeletionRequest> {
  const idempotencyKey = `global-email:${addressHash}`
  const existing = await em.findOne(GtmDeletionRequest, {
    organizationId: GLOBAL_SUPPRESSION_ORG_ID,
    idempotencyKey,
    deletedAt: null,
  })
  if (existing) return existing
  const request = em.create(GtmDeletionRequest, {
    organizationId: GLOBAL_SUPPRESSION_ORG_ID,
    tenantId: GLOBAL_SUPPRESSION_TENANT_ID,
    idempotencyKey,
    scope: 'global_email',
    addressHash,
    status: 'pending',
    legalHold: false,
    requestedAt: now,
    dueAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
  })
  em.persist(request)
  try {
    await em.flush()
    return request
  } catch (error) {
    if (!(error instanceof UniqueConstraintViolationException)) throw error
    const winner = await em.findOne(GtmDeletionRequest, {
      organizationId: GLOBAL_SUPPRESSION_ORG_ID,
      idempotencyKey,
      deletedAt: null,
    })
    if (!winner) throw error
    return winner
  }
}

async function createOrLoadTenantRequest(
  em: ExecutionEm,
  scope: { organizationId: string; tenantId: string },
  addressHash: string,
  now: Date,
): Promise<GtmDeletionRequest> {
  const idempotencyKey = `tenant-email:${scope.tenantId}:${addressHash}`
  const existing = await em.findOne(GtmDeletionRequest, {
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    idempotencyKey,
    deletedAt: null,
  })
  if (existing) return existing
  const request = em.create(GtmDeletionRequest, {
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    idempotencyKey,
    scope: 'tenant_email',
    addressHash,
    status: 'pending',
    legalHold: false,
    requestedAt: now,
    dueAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
  })
  em.persist(request)
  try {
    await em.flush()
    return request
  } catch (error) {
    if (!(error instanceof UniqueConstraintViolationException)) throw error
    const winner = await em.findOne(GtmDeletionRequest, {
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      idempotencyKey,
      deletedAt: null,
    })
    if (!winner) throw error
    return winner
  }
}

async function ensureDsrOperation(
  em: ExecutionEm,
  request: GtmDeletionRequest,
  scope: { organizationId: string; tenantId: string },
  input: { provider: string; kind: 'local_anonymize' | 'provider_delete'; status: string },
  now: Date,
): Promise<GtmDsrOperation> {
  const existing = await em.findOne(GtmDsrOperation, {
    deletionRequestId: request.id,
    organizationId: scope.organizationId,
    provider: input.provider,
    kind: input.kind,
    deletedAt: null,
  })
  if (existing) return existing
  const operation = em.create(GtmDsrOperation, {
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    deletionRequestId: request.id,
    provider: input.provider,
    kind: input.kind,
    idempotencyKey: `${request.id}:${scope.organizationId}:${input.provider}:${input.kind}`,
    status: input.status,
    attemptCount: 0,
    nextAttemptAt: null,
    receipt:
      input.status === 'completed'
        ? { completed_locally: true, completed_at: now.toISOString() }
        : null,
    completedAt: input.status === 'completed' ? now : null,
  })
  em.persist(operation)
  try {
    await em.flush()
    return operation
  } catch (error) {
    if (!(error instanceof UniqueConstraintViolationException)) throw error
    const winner = await em.findOne(GtmDsrOperation, {
      deletionRequestId: request.id,
      organizationId: scope.organizationId,
      provider: input.provider,
      kind: input.kind,
      deletedAt: null,
    })
    if (!winner) throw error
    return winner
  }
}

function providerDsrStatus(provider: string): string {
  if (provider === 'fixture') return 'completed'
  if (['apify', 'leadmagic', 'dataforseo', 'bouncer'].some((name) => provider.includes(name))) {
    return 'not_supported'
  }
  return 'blocked_authority'
}

async function resumePartialEmailDeletion(
  em: ExecutionEm,
  request: GtmDeletionRequest,
  now: Date,
): Promise<DeletionResult> {
  const counts = resultFromStoredRequest(request)
  const tenantRequests = await em.find(GtmDeletionRequest, {
    scope: 'tenant_email',
    addressHash: request.addressHash,
    status: 'partial',
    deletedAt: null,
  })

  for (const tenantRequest of tenantRequests) {
    if (tenantRequest.legalHold) continue
    const operation = await em.findOne(GtmDsrOperation, {
      deletionRequestId: tenantRequest.id,
      organizationId: tenantRequest.organizationId,
      tenantId: tenantRequest.tenantId,
      provider: 'crm_email',
      kind: 'local_anonymize',
      deletedAt: null,
    })
    if (!operation || operation.status === 'completed') continue
    if (!['blocked_authority', 'failed', 'pending'].includes(operation.status)) continue
    const claimed = await em.nativeUpdate(
      GtmDsrOperation,
      {
        id: operation.id,
        organizationId: tenantRequest.organizationId,
        tenantId: tenantRequest.tenantId,
        status: operation.status,
      },
      {
        status: 'in_progress',
        startedAt: now,
        attemptCount: operation.attemptCount + 1,
        updatedAt: now,
      },
    )
    if (claimed !== 1) continue

    // The raw address has already been removed from contact points by the
    // first pass. Recover only candidates stamped by this exact tenant DSR;
    // then walk their enrollment links. This deliberately avoids a broad
    // organization-level email sweep.
    const scopedCandidates = await em.find(GtmCandidate, {
      organizationId: tenantRequest.organizationId,
      tenantId: tenantRequest.tenantId,
      deletedAt: null,
    })
    const candidateIds = scopedCandidates
      .filter((candidate) => candidate.identity?.removal_request_id === tenantRequest.id)
      .map((candidate) => candidate.id)
    const enrollments = candidateIds.length
      ? await em.find(GtmEnrollment, {
          organizationId: tenantRequest.organizationId,
          tenantId: tenantRequest.tenantId,
          candidateId: { $in: candidateIds },
        })
      : []
    const enrollmentIds = enrollments.map((row) => row.id)
    const [replies, inboundEvents] = enrollmentIds.length
      ? await Promise.all([
          em.find(GtmReply, {
            organizationId: tenantRequest.organizationId,
            tenantId: tenantRequest.tenantId,
            enrollmentId: { $in: enrollmentIds },
          }),
          em.find(GtmInboundEvent, {
            organizationId: tenantRequest.organizationId,
            tenantId: tenantRequest.tenantId,
            enrollmentId: { $in: enrollmentIds },
          }),
        ])
      : [[], []]
    const emailMessageIds = linkedEmailMessageIds(replies, inboundEvents)
    // A pre-existing blocked operation with no remaining exact link cannot
    // be completed honestly. Leave it partial for operator reconciliation.
    if (emailMessageIds.length === 0) continue
    const messages = await em.find(EmailMessage, {
      organizationId: tenantRequest.organizationId,
      tenantId: tenantRequest.tenantId,
      id: { $in: emailMessageIds },
    })

    await em.transactional(async (tem) => {
      for (const message of messages) {
        anonymizeEmailMessage(message, now)
        tem.persist(message)
      }
      for (const reply of replies) {
        if (reply.emailMessageId && emailMessageIds.includes(reply.emailMessageId)) {
          reply.emailMessageId = null
        }
        reply.draftResponse = null
        reply.updatedAt = now
        tem.persist(reply)
      }
      for (const event of inboundEvents) {
        if (event.emailMessageId && emailMessageIds.includes(event.emailMessageId)) {
          event.emailMessageId = null
        }
        event.providerMessageId = null
        event.rfcMessageId = null
        event.evidenceRedacted = { removed: true, original_hash: digest(event.evidenceRedacted) }
        event.updatedAt = now
        tem.persist(event)
      }
      completeLocalEmailOperation(operation, messages.length, now)
      tem.persist(operation)
      tem.persist(
        tem.create(GtmAuditEvent, {
          organizationId: tenantRequest.organizationId,
          tenantId: tenantRequest.tenantId,
          actor: 'system',
          actorUserId: null,
          action: 'gtm.privacy.crm_email_anonymized',
          objectType: 'gtm_deletion_request',
          objectId: tenantRequest.id,
          requestId: null,
          metadata: { email_messages: messages.length, resumed: true },
        }),
      )
      await tem.flush()
    })

    const tenantOps = await em.find(GtmDsrOperation, {
      deletionRequestId: tenantRequest.id,
      organizationId: tenantRequest.organizationId,
      tenantId: tenantRequest.tenantId,
      deletedAt: null,
    })
    const priorTenantCounts = tenantRequest.resultCounts ?? {}
    const priorEmailCount = priorTenantCounts.email_messages_anonymized
    tenantRequest.status = tenantOps.some((row) => row.status !== 'completed')
      ? 'partial'
      : 'completed'
    tenantRequest.completedAt = now
    tenantRequest.resultCounts = {
      ...priorTenantCounts,
      email_messages_anonymized:
        (typeof priorEmailCount === 'number' ? priorEmailCount : 0) + messages.length,
      dsr_operations: tenantOps.length,
    }
    tenantRequest.updatedAt = now
    em.persist(tenantRequest)
    await em.flush()
    counts.emailMessagesAnonymized += messages.length
  }

  const allTenantRequests = await em.find(GtmDeletionRequest, {
    scope: 'tenant_email',
    addressHash: request.addressHash,
    deletedAt: null,
  })
  request.status =
    allTenantRequests.length > 0 && allTenantRequests.every((row) => row.status === 'completed')
      ? 'completed'
      : 'partial'
  request.completedAt = now
  request.resultCounts = {
    ...(request.resultCounts ?? {}),
    email_messages_anonymized: counts.emailMessagesAnonymized,
  }
  request.updatedAt = now
  em.persist(request)
  await em.flush()
  counts.request = request
  return counts
}

export async function executeRemovalDeletion(
  em: ExecutionEm,
  input: {
    addressHash: string
    normalizedAddress: string
    points: RemovalPoint[]
  },
  deps: { clock?: Clock } = {},
): Promise<DeletionResult> {
  const now = deps.clock?.now() ?? new Date()
  const request = await createOrLoadRequest(em, input.addressHash, now)
  const empty = {
    request,
    candidatesAnonymized: 0,
    evidenceAnonymized: 0,
    contactPointsAnonymized: 0,
    relationsAnonymized: 0,
    renderedMessagesAnonymized: 0,
    repliesAnonymized: 0,
    emailMessagesAnonymized: 0,
    manualDraftsAnonymized: 0,
    providerReceiptsRedacted: 0,
    dsrOperations: 0,
  }
  // A permanent suppression can outlive buggy or delayed provider imports.
  // An exact replay with no newly reachable rows returns its durable result,
  // while a later re-sourced row reopens only the local fan-out work.
  if (request.status === 'partial' && input.points.length === 0) {
    return resumePartialEmailDeletion(em, request, now)
  }
  if (request.status === 'completed' && input.points.length === 0) {
    return resultFromStoredRequest(request)
  }
  if (request.legalHold) {
    request.status = 'blocked_legal_hold'
    request.updatedAt = now
    em.persist(request)
    await em.flush()
    return empty
  }

  const groups = new Map<string, RemovalPoint[]>()
  for (const point of input.points) {
    const key = `${point.organizationId}:${point.tenantId}`
    const group = groups.get(key) ?? []
    group.push(point)
    groups.set(key, group)
  }

  request.status = 'processing'
  request.updatedAt = now
  em.persist(request)
  await em.flush()
  const counts = { ...empty }
  let hasBlockedDsr = false

  for (const points of groups.values()) {
    const organizationId = points[0].organizationId
    const tenantId = points[0].tenantId
    const tenantRequest = await createOrLoadTenantRequest(
      em,
      { organizationId, tenantId },
      input.addressHash,
      now,
    )
    if (tenantRequest.legalHold) {
      tenantRequest.status = 'blocked_legal_hold'
      tenantRequest.updatedAt = now
      em.persist(tenantRequest)
      await em.flush()
      hasBlockedDsr = true
      continue
    }
    tenantRequest.status = 'processing'
    tenantRequest.updatedAt = now
    em.persist(tenantRequest)
    await em.flush()
    const candidateIds = [...new Set(points.map((point) => point.candidateId))]
    const candidateIdSet = new Set(candidateIds)
    const [candidates, candidateMatches, candidateRelations, evidence, contactPoints, enrollments, providerOperations, chatMessages, manualDrafts] =
      await Promise.all([
        em.find(GtmCandidate, { organizationId, tenantId, id: { $in: candidateIds } }),
        em.find(GtmCandidateMatch, { organizationId, tenantId, candidateId: { $in: candidateIds } }),
        em.find(GtmCandidateRelation, {
          organizationId,
          tenantId,
          $or: [
            { parentCandidateId: { $in: candidateIds } },
            { childCandidateId: { $in: candidateIds } },
          ],
        }),
        em.find(GtmEvidence, { organizationId, tenantId, candidateId: { $in: candidateIds } }),
        em.find(GtmContactPoint, { organizationId, tenantId, candidateId: { $in: candidateIds } }),
        em.find(GtmEnrollment, { organizationId, tenantId, candidateId: { $in: candidateIds } }),
        em.find(GtmProviderOperation, { organizationId, tenantId, candidateId: { $in: candidateIds } }),
        em.find(GtmChatMessage, {
          organizationId,
          tenantId,
          toolRef: { $in: candidateIds },
        }),
        em.find(GtmManualOutreachDraft, {
          organizationId,
          tenantId,
          candidateId: { $in: candidateIds },
          deletedAt: null,
        }),
      ])
    // Capture graph dependencies before local anonymization clears them.
    const hadPromotedContact = candidates.some((row) => Boolean(row.promotedContactId))
    const enrollmentIds = enrollments.map((row) => row.id)
    const versionIds = [...new Set(enrollments.map((row) => row.campaignVersionId))]
    const [rendered, replies, attempts, inboundEvents, versions] = await Promise.all([
      em.find(GtmRenderedMessage, { organizationId, tenantId, enrollmentId: { $in: enrollmentIds } }),
      em.find(GtmReply, { organizationId, tenantId, enrollmentId: { $in: enrollmentIds } }),
      em.find(GtmSendAttempt, { organizationId, tenantId, enrollmentId: { $in: enrollmentIds } }),
      em.find(GtmInboundEvent, { organizationId, tenantId, enrollmentId: { $in: enrollmentIds } }),
      em.find(GtmCampaignVersion, { organizationId, tenantId, id: { $in: versionIds } }),
    ])
    const emailMessageIds = linkedEmailMessageIds(replies, inboundEvents)
    const emailMessages = emailMessageIds.length
      ? await em.find(EmailMessage, {
          organizationId,
          tenantId,
          id: { $in: emailMessageIds },
        })
      : []

    await em.transactional(async (tem) => {
      for (const candidate of candidates) {
        candidate.identity = { removed: true, removal_request_id: tenantRequest.id }
        candidate.dedupeKey = digest({ removed: tenantRequest.id, candidate: candidate.id })
        candidate.fitStatus = 'rejected'
        candidate.fitScore = null
        candidate.rejectReason = 'removed'
        candidate.qualityStatus = null
        candidate.qualityScore = null
        candidate.qualification = null
        candidate.promotedContactId = null
        candidate.retentionExpiresAt = now
        candidate.updatedAt = now
        tem.persist(candidate)
      }
      for (const match of candidateMatches) {
        match.fitStatus = 'rejected'
        match.fitScore = null
        match.rejectReason = 'removed'
        match.qualityStatus = null
        match.qualityScore = null
        match.qualification = null
        match.updatedAt = now
        tem.persist(match)
      }
      for (const relation of candidateRelations) {
        relation.observedTitle = '[removed]'
        relation.confidence = '0.000'
        relation.deletedAt = now
        relation.updatedAt = now
        tem.persist(relation)
      }
      for (const row of evidence) {
        row.claim = '[removed]'
        row.sourceUrl = null
        row.providerRef = null
        row.qualityIssues = null
        row.updatedAt = now
        tem.persist(row)
      }
      for (const point of contactPoints) {
        point.value = `removed:${digest({ request: tenantRequest.id, point: point.id })}`
        point.verificationState = 'not_found'
        point.provenance = null
        point.verifiedAt = null
        point.deletedAt = now
        point.updatedAt = now
        tem.persist(point)
      }
      for (const row of rendered) {
        row.subject = null
        row.bodyHtml = null
        row.bodyText = null
        row.updatedAt = now
        tem.persist(row)
      }
      for (const row of replies) {
        row.draftResponse = null
        if (row.emailMessageId && emailMessageIds.includes(row.emailMessageId)) {
          row.emailMessageId = null
        }
        row.updatedAt = now
        tem.persist(row)
      }
      for (const row of attempts) {
        row.providerReceipt = redactReceipt(row.providerReceipt)
        row.updatedAt = now
        tem.persist(row)
      }
      for (const row of providerOperations) {
        row.receipt = redactReceipt(row.receipt)
        row.updatedAt = now
        tem.persist(row)
      }
      for (const row of inboundEvents) {
        row.evidenceRedacted = { removed: true, original_hash: digest(row.evidenceRedacted) }
        row.providerMessageId = null
        row.rfcMessageId = null
        if (row.emailMessageId && emailMessageIds.includes(row.emailMessageId)) {
          row.emailMessageId = null
        }
        row.updatedAt = now
        tem.persist(row)
      }
      for (const row of emailMessages) {
        anonymizeEmailMessage(row, now)
        tem.persist(row)
      }
      for (const row of chatMessages) {
        row.content = { removed: true, removal_request_id: tenantRequest.id }
        row.updatedAt = now
        tem.persist(row)
      }
      for (const row of manualDrafts) {
        row.destinationUrl = 'https://removed.invalid/'
        row.bodyText = '[removed]'
        row.contentHash = digest({ removed: tenantRequest.id, draft: row.id })
        row.evidenceHash = digest({ removed: tenantRequest.id, evidence: row.id })
        row.provenance = { removed: true, removal_request_id: tenantRequest.id }
        row.status = 'dismissed'
        row.dismissedAt = now
        row.deletedAt = now
        row.updatedAt = now
        tem.persist(row)
      }
      for (const row of versions) {
        row.snapshot = redactSnapshot(row.snapshot, {
          normalizedAddress: input.normalizedAddress,
          addressHash: input.addressHash,
          candidateIds: candidateIdSet,
        }) as Record<string, unknown>
        row.updatedAt = now
        tem.persist(row)
      }
      tem.persist(
        tem.create(GtmAuditEvent, {
          organizationId,
          tenantId,
          actor: 'system',
          actorUserId: null,
          action: 'gtm.privacy.local_anonymized',
          objectType: 'gtm_deletion_request',
          objectId: tenantRequest.id,
          requestId: null,
          metadata: {
            candidates: candidates.length,
            evidence: evidence.length,
            contact_points: contactPoints.length,
            relations: candidateRelations.length,
            rendered_messages: rendered.length,
            replies: replies.length,
            email_messages: emailMessages.length,
            manual_outreach_drafts: manualDrafts.length,
            provider_receipts: providerOperations.length + attempts.length,
          },
        }),
      )
      await tem.flush()
    })

    counts.candidatesAnonymized += candidates.length
    counts.evidenceAnonymized += evidence.length
    counts.contactPointsAnonymized += contactPoints.length
    counts.relationsAnonymized += candidateRelations.length
    counts.renderedMessagesAnonymized += rendered.length
    counts.repliesAnonymized += replies.length
    counts.emailMessagesAnonymized += emailMessages.length
    counts.manualDraftsAnonymized += manualDrafts.length
    counts.providerReceiptsRedacted += providerOperations.length + attempts.length

    await ensureDsrOperation(
      em,
      tenantRequest,
      { organizationId, tenantId },
      { provider: 'gtm_local', kind: 'local_anonymize', status: 'completed' },
      now,
    )
    counts.dsrOperations += 1
    if (hadPromotedContact) {
      await ensureDsrOperation(
        em,
        tenantRequest,
        { organizationId, tenantId },
        { provider: 'crm_customers', kind: 'local_anonymize', status: 'blocked_authority' },
        now,
      )
      counts.dsrOperations += 1
      hasBlockedDsr = true
    }
    if (emailMessageIds.length > 0) {
      const operation = await ensureDsrOperation(
        em,
        tenantRequest,
        { organizationId, tenantId },
        { provider: 'crm_email', kind: 'local_anonymize', status: 'completed' },
        now,
      )
      completeLocalEmailOperation(operation, emailMessages.length, now)
      em.persist(operation)
      await em.flush()
      counts.dsrOperations += 1
    }
    for (const provider of new Set(providerOperations.map((row) => row.provider))) {
      const status = providerDsrStatus(provider)
      await ensureDsrOperation(
        em,
        tenantRequest,
        { organizationId, tenantId },
        { provider, kind: 'provider_delete', status },
        now,
      )
      counts.dsrOperations += 1
      if (status !== 'completed') hasBlockedDsr = true
    }
    const tenantOps = await em.find(GtmDsrOperation, {
      deletionRequestId: tenantRequest.id,
      organizationId,
      tenantId,
      deletedAt: null,
    })
    tenantRequest.status = tenantOps.some((row) => row.status !== 'completed')
      ? 'partial'
      : 'completed'
    tenantRequest.completedAt = now
    tenantRequest.resultCounts = {
      candidates_anonymized: candidates.length,
      evidence_anonymized: evidence.length,
      contact_points_anonymized: contactPoints.length,
      relations_anonymized: candidateRelations.length,
      rendered_messages_anonymized: rendered.length,
      replies_anonymized: replies.length,
      email_messages_anonymized: emailMessages.length,
      manual_drafts_anonymized: manualDrafts.length,
      provider_receipts_redacted: providerOperations.length + attempts.length,
      dsr_operations: tenantOps.length,
    }
    tenantRequest.updatedAt = now
    em.persist(tenantRequest)
    await em.flush()
  }

  request.status = hasBlockedDsr ? 'partial' : 'completed'
  request.completedAt = now
  request.resultCounts = {
    candidates_anonymized: counts.candidatesAnonymized,
    evidence_anonymized: counts.evidenceAnonymized,
    contact_points_anonymized: counts.contactPointsAnonymized,
    relations_anonymized: counts.relationsAnonymized,
    rendered_messages_anonymized: counts.renderedMessagesAnonymized,
    replies_anonymized: counts.repliesAnonymized,
    email_messages_anonymized: counts.emailMessagesAnonymized,
    manual_drafts_anonymized: counts.manualDraftsAnonymized,
    provider_receipts_redacted: counts.providerReceiptsRedacted,
    dsr_operations: counts.dsrOperations,
  }
  request.updatedAt = now
  em.persist(request)
  await em.flush()
  return counts
}
