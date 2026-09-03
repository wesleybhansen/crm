import { FakeEm } from './support/fake-em'
import { ORG, OTHER_ORG, TENANT, ctx, seedCandidate, seedPlay, seedRun } from './support/campaign-fixtures'
import { LAUNCH_ISO, fixedClock, seedLaunchedCampaign } from './support/execution-fixtures'
import {
  GLOBAL_SUPPRESSION_ORG_ID,
  GLOBAL_SUPPRESSION_TENANT_ID,
  applyRemovalRequest,
  applyProfileRemovalRequest,
  normalizeRemovalEmail,
  normalizeRemovalSource,
} from '../removal-request'
import { candidateDedupeKey, consumerProfileDedupeKey, normalizeConsumerProfileUrl } from '../research/execute'
import { computeExclusions, hashAddress } from '../campaign/exclusions'
import { EmailMessage } from '../../../email/data/schema'
import {
  GtmAuditEvent,
  GtmCandidateRelation,
  GtmContactPoint,
  GtmDeletionRequest,
  GtmDsrOperation,
  GtmEnrollment,
  GtmEvidence,
  GtmInboundEvent,
  GtmRenderedMessage,
  GtmReply,
  GtmSendAttempt,
  GtmSuppression,
} from '../../data/entities'

async function seedLinkedInboundEmail(
  em: FakeEm,
  input: { enrollment: GtmEnrollment; attempt: GtmSendAttempt; address: string; occurredAt: Date },
) {
  const message = em.create(EmailMessage, {
    organizationId: input.enrollment.organizationId,
    tenantId: input.enrollment.tenantId,
    accountId: null,
    direction: 'inbound',
    fromAddress: input.address,
    toAddress: 'sender@fixture.example',
    cc: `copy-${input.address}`,
    bcc: null,
    subject: `Reply from ${input.address}`,
    bodyHtml: `<p>Please remove ${input.address}</p>`,
    bodyText: `Please remove ${input.address}`,
    threadId: `thread-${input.address}`,
    metadata: { provider_message_id: `provider-${input.address}`, from: input.address },
    sentiment: 'neutral',
    createdAt: input.occurredAt,
  })
  const event = em.create(GtmInboundEvent, {
    organizationId: input.enrollment.organizationId,
    tenantId: input.enrollment.tenantId,
    mailboxConnectionId: null,
    provider: 'gmail',
    providerEventId: `event-${message.id}`,
    dedupeKey: `dedupe-${message.id}`,
    eventKind: 'human_reply',
    providerMessageId: `provider-${message.id}`,
    rfcMessageId: `<${message.id}@fixture.example>`,
    emailMessageId: message.id,
    sendAttemptId: input.attempt.id,
    enrollmentId: input.enrollment.id,
    correlationMethod: 'header',
    correlationConfidence: 'exact_header',
    evidenceRedacted: { from: input.address },
    processingState: 'processed',
    occurredAt: input.occurredAt,
    processedAt: input.occurredAt,
  })
  const reply = em.create(GtmReply, {
    organizationId: input.enrollment.organizationId,
    tenantId: input.enrollment.tenantId,
    enrollmentId: input.enrollment.id,
    sendAttemptId: input.attempt.id,
    stepId: null,
    channel: 'email',
    direction: 'inbound',
    emailMessageId: message.id,
    inboundEventId: event.id,
    eventKind: 'human_reply',
    correlationConfidence: 'exact_header',
    draftResponse: { body: `Reply to ${input.address}` },
  })
  em.persist(message)
  em.persist(event)
  em.persist(reply)
  await em.flush()
  return { message, event, reply }
}

/*
 * Public prospect-removal request (privacy policy 3.8). Every address here is
 * synthetic (SPEC-066 section 11.3).
 */
describe('prospect removal request', () => {
  const ADDRESS = 'someone@fixture.example'
  const HASH = hashAddress(ADDRESS)

  it('normalizes the address exactly as the suppression code does', () => {
    expect(normalizeRemovalEmail('  SomeOne@Fixture.Example  ')).toBe(ADDRESS)
    expect(hashAddress(normalizeRemovalEmail('SOMEONE@FIXTURE.EXAMPLE') as string)).toBe(HASH)
    for (const bad of ['', '   ', 'not-an-email', 'no@domain', null, undefined, 42, `${'a'.repeat(300)}@x.com`]) {
      expect(normalizeRemovalEmail(bad)).toBeNull()
    }
  })

  it('writes a global-scope email suppression keyed by address hash, with no readable address', async () => {
    const em = new FakeEm()
    const result = await applyRemovalRequest(em, { email: '  SomeOne@Fixture.Example ' })

    expect(result).toMatchObject({
      ok: true,
      suppressed: true,
      addressHash: HASH,
      suppressionCreated: true,
      enrollmentsStopped: 0,
      attemptsCancelled: 0,
    })

    const rows = await em.find(GtmSuppression, {})
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      scope: 'global',
      channel: 'email',
      addressHash: HASH,
      reason: 'removal_request',
      organizationId: GLOBAL_SUPPRESSION_ORG_ID,
      tenantId: GLOBAL_SUPPRESSION_TENANT_ID,
    })
    // Hash only: the readable address is never stored.
    expect(rows[0].addressDisplay).toBeNull()
    expect(rows[0].expiresAt).toBeNull()
    expect(JSON.stringify(rows[0].source)).not.toContain('fixture.example')
  })

  it('removes and permanently suppresses an exact public consumer profile', async () => {
    const em = new FakeEm()
    const profileUrl = 'https://www.linkedin.com/in/Avery-Example/'
    const normalized = normalizeConsumerProfileUrl(profileUrl)
    const profileHash = consumerProfileDedupeKey(profileUrl)
    expect(normalized).toBe('https://linkedin.com/in/avery-example')
    expect(profileHash).toMatch(/^[0-9a-f]{64}$/)
    const run = await seedRun(em, await seedPlay(em))
    const candidate = await seedCandidate(em, run, { email: null })
    candidate.entityKind = 'person'
    candidate.identity = { name: 'Avery Example', urls: [profileUrl] }
    candidate.dedupeKey = profileHash as string

    const result = await applyProfileRemovalRequest(em, { profileUrl })

    expect(result).toMatchObject({ ok: true, suppressed: true })
    expect(result.recordsAnonymized).toBeGreaterThan(0)
    expect(candidate.identity).toMatchObject({ removed: true })
    const suppression = await em.findOne(GtmSuppression, {
      scope: 'global',
      channel: 'public_profile',
      addressHash: profileHash,
    })
    expect(suppression).not.toBeNull()
    expect(suppression?.addressDisplay).toBeNull()
  })

  it('removes an engager keyed by a name|title fingerprint through the profile URL it carries (C3 / H4)', async () => {
    const em = new FakeEm()
    const profileUrl = 'https://www.linkedin.com/in/jane-doe-realtor/'
    const profileHash = consumerProfileDedupeKey(profileUrl) as string
    const fingerprint = 'c'.repeat(64)
    const run = await seedRun(em, await seedPlay(em))
    // Legacy row: keyed by sha256(person|linkedin-engagement|fingerprint),
    // profile URL only inside identity.urls.
    const engager = await seedCandidate(em, run, { email: null })
    engager.entityKind = 'person'
    engager.identity = {
      name: 'Jane Doe',
      title: 'Realtor',
      urls: [profileUrl],
      linkedin_engagement_fingerprint: fingerprint,
    }
    engager.dedupeKey = candidateDedupeKey({
      entity_kind: 'person',
      identity: { name: 'Jane Doe', linkedin_engagement_fingerprint: fingerprint },
    })
    // Unrelated person stays untouched.
    const other = await seedCandidate(em, run, { email: null })
    other.entityKind = 'person'
    other.identity = { name: 'Someone Else', urls: ['https://www.linkedin.com/in/someone-else'] }

    const result = await applyProfileRemovalRequest(em, { profileUrl })

    expect(result.recordsAnonymized).toBeGreaterThan(0)
    expect(engager.identity).toMatchObject({ removed: true })
    expect(other.identity).toMatchObject({ name: 'Someone Else' })
    expect(await em.findOne(GtmSuppression, { scope: 'global', channel: 'public_profile', addressHash: profileHash })).not.toBeNull()
  })

  it('records only an allowlisted removal source (L13)', async () => {
    const em = new FakeEm()
    await applyRemovalRequest(em, { email: ADDRESS, source: 'javascript:alert(1)' })
    const suppression = await em.findOne(GtmSuppression, { scope: 'global', channel: 'email', addressHash: hashAddress(ADDRESS) })
    expect(suppression?.source).toEqual({ via: 'removal_request', channel: 'public_form' })
    expect(normalizeRemovalSource('support')).toBe('support')
    expect(normalizeRemovalSource('anything else')).toBe('public_form')
  })

  it('the global row excludes the address in an unrelated org', async () => {
    const em = new FakeEm()
    // Suppress first, then simulate the same address being sourced later.
    // The permanent hash must survive anonymization and prevent re-entry.
    await applyRemovalRequest(em, { email: ADDRESS })
    const run = await seedRun(em, await seedPlay(em))
    const candidate = await seedCandidate(em, run, { email: ADDRESS })

    const result = await computeExclusions(em, ctx, {
      workspaceId: run.workspaceId,
      candidateIds: [candidate.id],
      channel: 'email',
    })
    expect(result.byCandidate.get(candidate.id)).toMatchObject({
      excluded: true,
      reason: 'removal_request',
      source: 'gtm_suppression',
    })
  })

  it('anonymizes a row re-sourced after an earlier empty removal completed', async () => {
    const em = new FakeEm()
    const first = await applyRemovalRequest(em, { email: ADDRESS })
    expect(first.deletionStatus).toBe('completed')

    const run = await seedRun(em, await seedPlay(em))
    const candidate = await seedCandidate(em, run, { email: ADDRESS })
    const point = (await em.find(GtmContactPoint, { candidateId: candidate.id }))[0]

    const replay = await applyRemovalRequest(em, { email: ADDRESS })

    expect(replay.suppressionCreated).toBe(false)
    expect(replay.recordsAnonymized).toBeGreaterThan(0)
    expect(candidate.identity).toMatchObject({ removed: true })
    expect(point.deletedAt).toBeInstanceOf(Date)
  })

  it('is idempotent: a repeat request is a no-op success, still one suppression row', async () => {
    const em = new FakeEm()
    const first = await applyRemovalRequest(em, { email: ADDRESS })
    const second = await applyRemovalRequest(em, { email: ADDRESS.toUpperCase() })

    expect(first.suppressionCreated).toBe(true)
    expect(second).toMatchObject({ ok: true, suppressed: true, suppressionCreated: false })
    expect(await em.find(GtmSuppression, {})).toHaveLength(1)
    const audits = (await em.find(GtmAuditEvent, {})).filter(
      (event) => event.action === 'gtm.suppression.removal_requested',
    )
    expect(audits).toHaveLength(1)
  })

  it('stops the active enrollment and cancels its remaining attempts', async () => {
    const em = new FakeEm()
    const clock = fixedClock(LAUNCH_ISO)
    const fixture = await seedLaunchedCampaign(em, { clock, recipients: 2, emails: 2 })
    const target = fixture.enrollments[0]
    const bystander = fixture.enrollments[1]
    const address = fixture.addressFor(target)

    const result = await applyRemovalRequest(em, { email: address }, { clock })
    expect(result).toMatchObject({
      ok: true,
      suppressed: true,
      enrollmentsStopped: 1,
      attemptsCancelled: 2,
    })

    expect(target.status).toBe('stopped')
    expect(target.stopReason).toBe('removal_request')
    expect(target.stoppedAt).toBeInstanceOf(Date)
    for (const attempt of await em.find(GtmSendAttempt, { enrollmentId: target.id })) {
      expect(attempt.state).toBe('failed')
      expect(attempt.failureReason).toBe('stopped')
    }

    // The other recipient's mail is untouched.
    expect(bystander.status).toBe('active')
    for (const attempt of await em.find(GtmSendAttempt, { enrollmentId: bystander.id })) {
      expect(attempt.state).toBe('approved')
    }
  })

  it('never stops an enrollment whose address merely looks like the request (LIKE wildcards escaped)', async () => {
    const em = new FakeEm()
    const clock = fixedClock(LAUNCH_ISO)
    const fixture = await seedLaunchedCampaign(em, { clock, recipients: 1, emails: 1 })
    const enrollment = fixture.enrollments[0]
    const address = fixture.addressFor(enrollment)
    // `_` is a single-character LIKE wildcard; an unescaped pattern built
    // from this request would sweep up the seeded address.
    const wildcarded = address.replace(/^(.)/, '_')

    const result = await applyRemovalRequest(em, { email: wildcarded }, { clock })
    expect(result.enrollmentsStopped).toBe(0)
    expect(enrollment.status).toBe('active')
  })

  it('stops matching enrollments in every organization, case-insensitively', async () => {
    const em = new FakeEm()
    const clock = fixedClock(LAUNCH_ISO)
    const fixture = await seedLaunchedCampaign(em, { clock, recipients: 1, emails: 1 })
    const enrollment = fixture.enrollments[0]
    const address = fixture.addressFor(enrollment)

    // The same person, sourced by a different customer, stored mixed-case.
    const foreignRun = await seedRun(em, await seedPlay(em))
    foreignRun.organizationId = OTHER_ORG
    const foreignCandidate = await seedCandidate(em, foreignRun, { email: address.toUpperCase() })
    const foreignEnrollment = em.create(GtmEnrollment, {
      organizationId: OTHER_ORG,
      tenantId: TENANT,
      campaignId: 'ffffffff-1111-4111-8111-aaaaaaaaaaaa',
      campaignVersionId: 'ffffffff-2222-4222-8222-bbbbbbbbbbbb',
      candidateId: foreignCandidate.id,
      status: 'active',
    })
    em.persist(foreignEnrollment)
    await em.flush()

    const result = await applyRemovalRequest(em, { email: address.toUpperCase() }, { clock })
    expect(result.enrollmentsStopped).toBe(2)
    expect(enrollment.status).toBe('stopped')
    expect(foreignEnrollment.status).toBe('stopped')
    expect(foreignEnrollment.stopReason).toBe('removal_request')
  })

  it('audits with the hash and counts only, never the readable address', async () => {
    const em = new FakeEm()
    const clock = fixedClock(LAUNCH_ISO)
    const fixture = await seedLaunchedCampaign(em, { clock, recipients: 1, emails: 2 })
    const address = fixture.addressFor(fixture.enrollments[0])

    await applyRemovalRequest(em, { email: address, reason: 'stop emailing me at once' }, { clock })

    const audits = await em.find(GtmAuditEvent, {})
    const actions = audits.map((event) => event.action)
    expect(actions).toContain('gtm.suppression.removal_requested')
    expect(actions).toContain('gtm.enrollment.removal_requested')
    for (const event of audits) {
      const serialized = JSON.stringify(event.metadata ?? {})
      expect(serialized).not.toContain(address)
      expect(serialized).not.toContain(address.split('@')[1])
      // The requester's free-text reason is never persisted either.
      expect(serialized).not.toContain('stop emailing me')
    }
    const enrollmentAudit = audits.find((event) => event.action === 'gtm.enrollment.removal_requested')
    expect(enrollmentAudit!.metadata).toMatchObject({
      address_hash: hashAddress(address),
      attempts_cancelled: 2,
    })
    expect(enrollmentAudit!.organizationId).toBe(ORG)
  })

  it('returns the same shape whether or not anything matched', async () => {
    const matched = new FakeEm()
    const clock = fixedClock(LAUNCH_ISO)
    const fixture = await seedLaunchedCampaign(matched, { clock, recipients: 1, emails: 1 })
    const hit = await applyRemovalRequest(
      matched,
      { email: fixture.addressFor(fixture.enrollments[0]) },
      { clock },
    )

    const empty = new FakeEm()
    const miss = await applyRemovalRequest(empty, { email: 'nobody@fixture.example' }, { clock })

    expect(Object.keys(hit).sort()).toEqual(Object.keys(miss).sort())
    expect(hit.ok).toBe(miss.ok)
    expect(hit.suppressed).toBe(miss.suppressed)
    // Both are unconditional successes; only the internal counts differ, and
    // the public route never forwards them.
    expect(miss).toMatchObject({ ok: true, suppressed: true, enrollmentsStopped: 0 })
  })

  it('cancels a claimed in-flight attempt so the removal cannot be mailed over', async () => {
    const em = new FakeEm()
    const clock = fixedClock(LAUNCH_ISO)
    const fixture = await seedLaunchedCampaign(em, { clock, recipients: 1, emails: 2 })
    const enrollment = fixture.enrollments[0]
    const address = fixture.addressFor(enrollment)
    const claimed = (await em.find(GtmSendAttempt, { enrollmentId: enrollment.id }))[0]
    claimed.state = 'claimed'
    claimed.claimToken = 'aaaaaaaa-1111-4111-8111-000000000000'

    const result = await applyRemovalRequest(em, { email: address }, { clock })

    // Both the claimed row and the still-planned one are cancelled. send.ts
    // does recheck the global suppression before provider contact, which
    // narrows this race, but that read happens several statements before the
    // transport call - cancelling the claim is what actually closes it.
    expect(result.attemptsCancelled).toBe(2)
    expect(claimed.state).toBe('failed')
    expect(claimed.failureReason).toBe('stopped')
    expect(claimed.claimToken).toBeNull()
    expect(enrollment.status).toBe('stopped')
  })

  it('fans out tenant-scoped deletion work, anonymizes the local graph, and retains only billing-safe receipt fields', async () => {
    const em = new FakeEm()
    const clock = fixedClock(LAUNCH_ISO)
    const fixture = await seedLaunchedCampaign(em, { clock, recipients: 1, emails: 1 })
    const enrollment = fixture.enrollments[0]
    const candidate = fixture.candidates[0]
    const address = fixture.addressFor(enrollment)
    const attempt = fixture.attempts[0]
    attempt.providerReceipt = {
      status: 'accepted',
      cost_usd: 0.01,
      recipient: address,
      provider_response: 'synthetic receipt detail',
    }
    const relation = em.create(GtmCandidateRelation, {
      organizationId: ORG,
      tenantId: TENANT,
      workspaceId: candidate.workspaceId,
      playId: fixture.campaign.playId,
      researchRunId: candidate.researchRunId,
      parentMatchId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      parentCandidateId: candidate.id,
      childCandidateId: candidate.id,
      providerOperationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      relationshipKind: 'current_employee',
      observedTitle: 'Synthetic Decision Maker',
      confidence: '0.950',
      observedAt: clock.now(),
    })
    em.persist(relation)
    await em.flush()

    const result = await applyRemovalRequest(em, { email: address }, { clock })

    expect(result).toMatchObject({ deletionStatus: 'completed' })
    expect(result.recordsAnonymized).toBeGreaterThan(0)
    expect(candidate.identity).toMatchObject({ removed: true })
    expect(candidate.promotedContactId).toBeNull()
    const evidence = await em.find(GtmEvidence, { candidateId: candidate.id })
    expect(evidence[0]).toMatchObject({ claim: '[removed]', sourceUrl: null, providerRef: null })
    const points = await em.find(GtmContactPoint, { candidateId: candidate.id })
    expect(points[0].value).toMatch(/^removed:/)
    expect(points[0].deletedAt).toBeInstanceOf(Date)
    expect(relation).toMatchObject({ observedTitle: '[removed]', confidence: '0.000' })
    expect(relation.deletedAt).toBeInstanceOf(Date)
    const rendered = await em.find(GtmRenderedMessage, { enrollmentId: enrollment.id })
    expect(rendered[0]).toMatchObject({ subject: null, bodyHtml: null, bodyText: null })
    expect(attempt.providerReceipt).toMatchObject({ redacted: true, status: 'accepted', cost_usd: 0.01 })
    expect(JSON.stringify(attempt.providerReceipt)).not.toContain(address)

    const requests = await em.find(GtmDeletionRequest, {})
    expect(requests).toHaveLength(2)
    const tenantRequest = requests.find((row) => row.scope === 'tenant_email')!
    expect(tenantRequest).toMatchObject({ organizationId: ORG, tenantId: TENANT, status: 'completed' })
    expect(tenantRequest.organizationId).not.toBe(GLOBAL_SUPPRESSION_ORG_ID)
    const operations = await em.find(GtmDsrOperation, { deletionRequestId: tenantRequest.id })
    expect(operations).toHaveLength(1)
    expect(operations[0]).toMatchObject({ provider: 'gtm_local', status: 'completed' })

    for (const row of [...requests, ...operations, ...(await em.find(GtmAuditEvent, {}))]) {
      expect(JSON.stringify(row)).not.toContain(address)
    }
  })

  it('anonymizes the exact linked CRM email row and severs both GTM links', async () => {
    const em = new FakeEm()
    const clock = fixedClock(LAUNCH_ISO)
    const fixture = await seedLaunchedCampaign(em, { clock, recipients: 1, emails: 1 })
    const enrollment = fixture.enrollments[0]
    const attempt = fixture.attempts[0]
    const address = fixture.addressFor(enrollment)
    const { message, event, reply } = await seedLinkedInboundEmail(em, {
      enrollment,
      attempt,
      address,
      occurredAt: clock.now(),
    })

    const result = await applyRemovalRequest(em, { email: address }, { clock })

    expect(result.deletionStatus).toBe('completed')
    expect(message).toMatchObject({
      fromAddress: 'removed@deleted.invalid',
      toAddress: 'removed@deleted.invalid',
      cc: null,
      bcc: null,
      subject: '[removed]',
      bodyHtml: '',
      bodyText: null,
      threadId: null,
      contactId: null,
      dealId: null,
      campaignId: null,
      sentiment: null,
    })
    expect(message.deletedAt).toBeInstanceOf(Date)
    expect(message.metadata).toMatchObject({ removed: true })
    expect(message.metadata?.original_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(reply.emailMessageId).toBeNull()
    expect(reply.draftResponse).toBeNull()
    expect(event.emailMessageId).toBeNull()
    expect(event.evidenceRedacted).toMatchObject({ removed: true })

    const tenantRequest = (await em.find(GtmDeletionRequest, { scope: 'tenant_email' }))[0]
    const emailOperation = await em.findOne(GtmDsrOperation, {
      deletionRequestId: tenantRequest.id,
      provider: 'crm_email',
    })
    expect(emailOperation).toMatchObject({
      status: 'completed',
      receipt: { completed_locally: true, records_anonymized: 1 },
    })
    for (const row of [message, event, reply, emailOperation]) {
      expect(JSON.stringify(row)).not.toContain(address)
      expect(JSON.stringify(row)).not.toContain(address.split('@')[1])
    }
  })

  it('resumes a legacy partial crm_email operation after the contact point is already removed', async () => {
    const em = new FakeEm()
    const clock = fixedClock(LAUNCH_ISO)
    const fixture = await seedLaunchedCampaign(em, { clock, recipients: 1, emails: 1 })
    const enrollment = fixture.enrollments[0]
    const attempt = fixture.attempts[0]
    const candidate = fixture.candidates[0]
    const address = fixture.addressFor(enrollment)
    const addressHash = hashAddress(address)
    const point = (await em.find(GtmContactPoint, { candidateId: candidate.id }))[0]
    const { message, event, reply } = await seedLinkedInboundEmail(em, {
      enrollment,
      attempt,
      address,
      occurredAt: clock.now(),
    })
    const globalRequest = em.create(GtmDeletionRequest, {
      organizationId: GLOBAL_SUPPRESSION_ORG_ID,
      tenantId: GLOBAL_SUPPRESSION_TENANT_ID,
      idempotencyKey: `global-email:${addressHash}`,
      scope: 'global_email',
      addressHash,
      status: 'partial',
      legalHold: false,
      requestedAt: clock.now(),
      resultCounts: {
        candidates_anonymized: 1,
        contact_points_anonymized: 1,
        dsr_operations: 2,
      },
    })
    const tenantRequest = em.create(GtmDeletionRequest, {
      organizationId: ORG,
      tenantId: TENANT,
      idempotencyKey: `tenant-email:${TENANT}:${addressHash}`,
      scope: 'tenant_email',
      addressHash,
      status: 'partial',
      legalHold: false,
      requestedAt: clock.now(),
      resultCounts: { candidates_anonymized: 1, contact_points_anonymized: 1, dsr_operations: 2 },
    })
    const localOperation = em.create(GtmDsrOperation, {
      organizationId: ORG,
      tenantId: TENANT,
      deletionRequestId: tenantRequest.id,
      provider: 'gtm_local',
      kind: 'local_anonymize',
      idempotencyKey: `${tenantRequest.id}:${ORG}:gtm_local:local_anonymize`,
      status: 'completed',
      completedAt: clock.now(),
    })
    const emailOperation = em.create(GtmDsrOperation, {
      organizationId: ORG,
      tenantId: TENANT,
      deletionRequestId: tenantRequest.id,
      provider: 'crm_email',
      kind: 'local_anonymize',
      idempotencyKey: `${tenantRequest.id}:${ORG}:crm_email:local_anonymize`,
      status: 'blocked_authority',
    })
    // Shape of a row the first removal pass leaves behind: the identity
    // stamp plus the reject fields executeRemovalDeletion always writes (the
    // resume path now narrows its scan on reject_reason instead of loading
    // every candidate in the org).
    candidate.identity = { removed: true, removal_request_id: tenantRequest.id }
    candidate.fitStatus = 'rejected'
    candidate.rejectReason = 'removed'
    point.value = `removed:${addressHash}`
    point.deletedAt = clock.now()
    em.persist(candidate)
    em.persist(point)
    em.persist(globalRequest)
    em.persist(tenantRequest)
    em.persist(localOperation)
    em.persist(emailOperation)
    await em.flush()

    const result = await applyRemovalRequest(em, { email: address }, { clock })

    expect(result).toMatchObject({
      suppressionCreated: true,
      deletionStatus: 'completed',
    })
    expect(message).toMatchObject({
      fromAddress: 'removed@deleted.invalid',
      toAddress: 'removed@deleted.invalid',
      subject: '[removed]',
      bodyHtml: '',
    })
    expect(message.deletedAt).toBeInstanceOf(Date)
    expect(reply.emailMessageId).toBeNull()
    expect(event.emailMessageId).toBeNull()
    expect(emailOperation.status).toBe('completed')
    expect(tenantRequest.status).toBe('completed')
    expect(globalRequest.status).toBe('completed')
    expect(tenantRequest.resultCounts).toMatchObject({ email_messages_anonymized: 1 })
    expect(globalRequest.resultCounts).toMatchObject({ email_messages_anonymized: 1 })
    const replay = await applyRemovalRequest(em, { email: address.toUpperCase() }, { clock })
    expect(replay.recordsAnonymized).toBe(result.recordsAnonymized)
    expect(
      (await em.find(GtmAuditEvent, {})).filter(
        (row) => row.action === 'gtm.privacy.crm_email_anonymized',
      ),
    ).toHaveLength(1)
    for (const row of [message, event, reply, emailOperation, tenantRequest, globalRequest]) {
      expect(JSON.stringify(row)).not.toContain(address)
      expect(JSON.stringify(row)).not.toContain(address.split('@')[1])
    }
  })

  it('honors a tenant-scoped legal hold while still suppressing and stopping immediately', async () => {
    const em = new FakeEm()
    const clock = fixedClock(LAUNCH_ISO)
    const fixture = await seedLaunchedCampaign(em, { clock, recipients: 1, emails: 1 })
    const enrollment = fixture.enrollments[0]
    const candidate = fixture.candidates[0]
    const address = fixture.addressFor(enrollment)
    const addressHash = hashAddress(address)
    em.persist(
      em.create(GtmDeletionRequest, {
        organizationId: ORG,
        tenantId: TENANT,
        idempotencyKey: `tenant-email:${TENANT}:${addressHash}`,
        scope: 'tenant_email',
        addressHash,
        status: 'pending',
        legalHold: true,
        legalHoldReason: 'synthetic_litigation_hold',
        requestedAt: clock.now(),
      }),
    )
    await em.flush()

    const result = await applyRemovalRequest(em, { email: address }, { clock })

    expect(result.deletionStatus).toBe('partial')
    expect(enrollment).toMatchObject({ status: 'stopped', stopReason: 'removal_request' })
    expect(candidate.identity).not.toMatchObject({ removed: true })
    const held = await em.findOne(GtmDeletionRequest, {
      organizationId: ORG,
      tenantId: TENANT,
      scope: 'tenant_email',
    })
    expect(held).toMatchObject({ status: 'blocked_legal_hold', legalHold: true })
    expect(await em.find(GtmSuppression, { scope: 'global', addressHash })).toHaveLength(1)
  })
})
