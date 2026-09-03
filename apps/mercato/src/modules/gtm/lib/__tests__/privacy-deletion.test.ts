import { FakeEm } from './support/fake-em'
import { ORG, TENANT, USER, seedCandidate, seedPlay, seedRun, WORKSPACE } from './support/campaign-fixtures'
import { LAUNCH_ISO, fixedClock, seedLaunchedCampaign } from './support/execution-fixtures'
import { applyRemovalRequest } from '../removal-request'
import { completeCrmContactDeletion, setLegalHold } from '../privacy/deletion'
import { hashAddress } from '../campaign/exclusions'
import { EmailMessage } from '../../../email/data/schema'
import {
  GtmAuditEvent,
  GtmCandidate,
  GtmChatMessage,
  GtmChatThread,
  GtmDeletionRequest,
  GtmDsrOperation,
  GtmInboundEvent,
  GtmSuppression,
} from '../../data/entities'
import { gtmGetOpportunityTool } from '../../ai-tools'

/*
 * Removal-request deletion coverage for the review findings H5 (readable
 * address on suppression rows), H6 (promoted CRM contact receipt + operator
 * completion), M12 (chat scan), M13 (uncorrelated mail and hashed inbound
 * events), L14 (soft delete), and M11 (legal-hold ops). All identities are
 * synthetic.
 */

// Stand-ins for the customers-module rows the CRM-contact completion touches.
class FakeCustomerEntity {
  id!: string
  organizationId!: string
  tenantId!: string
  displayName!: string
  description?: string | null
  primaryEmail?: string | null
  primaryEmailHash?: string | null
  primaryPhone?: string | null
  primaryPhoneHash?: string | null
  isActive?: boolean
  updatedAt?: Date
  deletedAt?: Date | null
}
class FakeCustomerPerson {
  id!: string
  organizationId!: string
  tenantId!: string
  entity!: string
  firstName?: string | null
  lastName?: string | null
  preferredName?: string | null
  jobTitle?: string | null
  department?: string | null
  linkedInUrl?: string | null
  twitterUrl?: string | null
  updatedAt?: Date
}

const CONTACT_ID = 'c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0'

describe('removal deletion hardening', () => {
  it('clears the readable address from every suppression row carrying the removed hash (H5)', async () => {
    const em = new FakeEm()
    const address = 'unsubscribed@fixture.example'
    const hash = hashAddress(address)
    // The reply classifier wrote a readable address on an org suppression.
    em.persist(
      em.create(GtmSuppression, {
        organizationId: ORG,
        tenantId: TENANT,
        scope: 'org',
        channel: 'email',
        addressHash: hash,
        addressDisplay: address,
        reason: 'unsubscribe',
      }),
    )
    em.persist(
      em.create(GtmSuppression, {
        organizationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        tenantId: TENANT,
        scope: 'org',
        channel: 'email',
        addressHash: hash,
        addressDisplay: address,
        reason: 'unsubscribe',
      }),
    )
    await em.flush()

    const result = await applyRemovalRequest(em, { email: address })
    expect(result.suppressed).toBe(true)
    for (const row of await em.find(GtmSuppression, { addressHash: hash })) {
      expect(row.addressDisplay).toBeNull()
    }
    // A replay keeps it cleared and still reports the durable result.
    const again = await applyRemovalRequest(em, { email: address })
    expect(again.deletionStatus).toBe(result.deletionStatus)
    expect(JSON.stringify(await em.find(GtmSuppression, {}))).not.toContain(address)
  })

  it('records the promoted CRM contact id in the blocked DSR receipt and lets an operator close it (H6)', async () => {
    const em = new FakeEm()
    const clock = fixedClock(LAUNCH_ISO)
    const play = await seedPlay(em)
    const run = await seedRun(em, play)
    const candidate = await seedCandidate(em, run, { promotedContactId: CONTACT_ID })
    const address = (await em.find(GtmCandidate, { id: candidate.id })).length ? 'synthetic-promoted@fixture.example' : ''
    const point = (await em.find(GtmCandidate, { id: candidate.id }))[0]
    expect(point).toBeDefined()
    // Give the candidate the address we will remove.
    const { GtmContactPoint } = await import('../../data/entities')
    const contactPoints = await em.find(GtmContactPoint, { candidateId: candidate.id })
    contactPoints[0].value = address
    em.persist(contactPoints[0])
    const contact = em.create(FakeCustomerEntity, {
      id: CONTACT_ID,
      organizationId: ORG,
      tenantId: TENANT,
      displayName: 'Synthetic Promoted Person',
      description: 'Met at the synthetic expo',
      primaryEmail: address,
      primaryEmailHash: hashAddress(address),
      primaryPhone: '+1 555 0100',
      primaryPhoneHash: 'phonehash',
      isActive: true,
    })
    const person = em.create(FakeCustomerPerson, {
      organizationId: ORG,
      tenantId: TENANT,
      entity: CONTACT_ID,
      firstName: 'Synthetic',
      lastName: 'Promoted',
      jobTitle: 'Broker',
      linkedInUrl: 'https://profile.example/synthetic',
    })
    em.persist(contact)
    em.persist(person)
    await em.flush()

    const result = await applyRemovalRequest(em, { email: address }, { clock })
    expect(result.deletionStatus).toBe('partial')
    expect(candidate.promotedContactId).toBeNull()
    const tenantRequest = (await em.find(GtmDeletionRequest, { scope: 'tenant_email' }))[0]
    const operation = (await em.find(GtmDsrOperation, {
      deletionRequestId: tenantRequest.id,
      provider: 'crm_customers',
    }))[0]
    expect(operation.status).toBe('blocked_authority')
    // The pointer survives in the receipt even though the candidate lost it.
    expect(operation.receipt).toMatchObject({ promoted_contact_ids: [CONTACT_ID] })
    expect(JSON.stringify(operation.receipt)).not.toContain(address)

    const ctx = { organizationId: ORG, tenantId: TENANT, userId: USER }
    const entities = { contact: FakeCustomerEntity as never, person: FakeCustomerPerson as never }
    const completed = await completeCrmContactDeletion(em, ctx, entities, { requestId: tenantRequest.id }, { clock })
    expect(completed).toMatchObject({ contactsAnonymized: 1, alreadyCompleted: false })
    expect(operation.status).toBe('completed')
    expect(contact).toMatchObject({
      displayName: 'Removed contact',
      description: null,
      primaryEmail: `removed+${CONTACT_ID}@deleted.invalid`,
      primaryEmailHash: null,
      primaryPhone: null,
      primaryPhoneHash: null,
      isActive: false,
    })
    expect(contact.deletedAt).toBeInstanceOf(Date)
    expect(person).toMatchObject({ firstName: null, lastName: null, jobTitle: null, linkedInUrl: null })
    expect(tenantRequest.status).toBe('completed')
    expect(await em.find(GtmAuditEvent, { action: 'gtm.privacy.crm_contact_anonymized' })).toHaveLength(1)
    for (const row of [...(await em.find(GtmAuditEvent, {})), operation, tenantRequest]) {
      expect(JSON.stringify(row)).not.toContain(address)
      expect(JSON.stringify(row)).not.toContain('Synthetic Promoted')
    }
    // Idempotent: a second completion changes nothing.
    const again = await completeCrmContactDeletion(em, ctx, entities, { requestId: tenantRequest.id }, { clock })
    expect(again).toMatchObject({ contactsAnonymized: 0, alreadyCompleted: true })
    // Foreign scope is opaque.
    expect(
      await completeCrmContactDeletion(
        em,
        { ...ctx, organizationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
        entities,
        { requestId: tenantRequest.id },
      ),
    ).toBeNull()
  })

  it('redacts chat turns and thread titles that carry the address or the removed name (M12)', async () => {
    const em = new FakeEm()
    const play = await seedPlay(em)
    const run = await seedRun(em, play)
    const candidate = await seedCandidate(em, run, { name: 'Jane Synthetic', email: 'jane.synthetic@fixture.example' })
    const thread = em.create(GtmChatThread, {
      organizationId: ORG,
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      title: 'Jane Synthetic outreach',
      status: 'active',
    })
    const otherThread = em.create(GtmChatThread, {
      organizationId: ORG,
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      title: 'Quarterly plan',
      status: 'active',
    })
    em.persist(thread)
    em.persist(otherThread)
    const mention = em.create(GtmChatMessage, {
      organizationId: ORG,
      tenantId: TENANT,
      threadId: thread.id,
      role: 'user',
      content: { text: 'draft a note to JANE.synthetic@fixture.example about her listing' },
      toolRef: null,
      seq: 1,
    })
    const byName = em.create(GtmChatMessage, {
      organizationId: ORG,
      tenantId: TENANT,
      threadId: otherThread.id,
      role: 'assistant',
      content: { text: 'I suggest reaching out to Jane Synthetic first.' },
      toolRef: null,
      seq: 1,
    })
    const unrelated = em.create(GtmChatMessage, {
      organizationId: ORG,
      tenantId: TENANT,
      threadId: otherThread.id,
      role: 'assistant',
      content: { text: 'Here is the quarterly plan.' },
      toolRef: null,
      seq: 2,
    })
    em.persist(mention)
    em.persist(byName)
    em.persist(unrelated)
    await em.flush()

    const result = await applyRemovalRequest(em, { email: 'jane.synthetic@fixture.example' })
    expect(result.deletionStatus).toBe('completed')
    expect(mention.content).toEqual({ removed: true, removal_request_id: expect.any(String) })
    expect(byName.content).toEqual({ removed: true, removal_request_id: expect.any(String) })
    expect(unrelated.content).toEqual({ text: 'Here is the quarterly plan.' })
    expect(thread.title).toBe('[removed]')
    expect(otherThread.title).toBe('Quarterly plan')
    expect(candidate.identity).toMatchObject({ removed: true })
  })

  it('anonymizes uncorrelated GTM-cursor mail and hashed inbound events from the removed address (M13)', async () => {
    const em = new FakeEm()
    const clock = fixedClock(LAUNCH_ISO)
    const fixture = await seedLaunchedCampaign(em, { clock, recipients: 1, emails: 1 })
    const address = fixture.addressFor(fixture.enrollments[0])
    const cursorMail = em.create(EmailMessage, {
      organizationId: ORG,
      tenantId: TENANT,
      direction: 'inbound',
      fromAddress: `Someone <${address.toUpperCase()}>`,
      toAddress: 'sender@fixture.example',
      subject: 'fresh email, no In-Reply-To',
      bodyHtml: `<p>hi from ${address}</p>`,
      bodyText: `hi from ${address}`,
      metadata: { source: 'gtm_mailbox_cursor', provider: 'gmail' },
    })
    const personalMail = em.create(EmailMessage, {
      organizationId: ORG,
      tenantId: TENANT,
      direction: 'inbound',
      fromAddress: address,
      toAddress: 'owner@fixture.example',
      subject: 'personal correspondence',
      bodyHtml: '<p>personal</p>',
      bodyText: 'personal',
      metadata: { source: 'personal_inbox' },
    })
    const lookalike = em.create(EmailMessage, {
      organizationId: ORG,
      tenantId: TENANT,
      direction: 'inbound',
      fromAddress: `not-${address}`,
      toAddress: 'sender@fixture.example',
      subject: 'lookalike address',
      bodyHtml: '<p>x</p>',
      bodyText: 'x',
      metadata: { source: 'gtm_mailbox_cursor' },
    })
    const hashedEvent = em.create(GtmInboundEvent, {
      organizationId: ORG,
      tenantId: TENANT,
      provider: 'gmail',
      providerEventId: 'evt-uncorrelated',
      dedupeKey: 'dedupe-uncorrelated',
      eventKind: 'human_reply',
      addressHash: hashAddress(address),
      enrollmentId: null,
      evidenceRedacted: { from: address },
      processingState: 'unmatched',
      occurredAt: clock.now(),
    })
    em.persist(cursorMail)
    em.persist(personalMail)
    em.persist(lookalike)
    em.persist(hashedEvent)
    await em.flush()

    await applyRemovalRequest(em, { email: address }, { clock })
    expect(cursorMail).toMatchObject({ fromAddress: 'removed@deleted.invalid', subject: '[removed]', bodyText: null })
    expect(personalMail.fromAddress).toBe(address)
    expect(lookalike.fromAddress).toBe(`not-${address}`)
    expect(hashedEvent.evidenceRedacted).toMatchObject({ removed: true })
  })

  it('soft-deletes the removed candidate so listing and MCP no longer return the husk (L14)', async () => {
    const em = new FakeEm()
    const play = await seedPlay(em)
    const run = await seedRun(em, play)
    const candidate = await seedCandidate(em, run, { email: 'husk@fixture.example' })
    await applyRemovalRequest(em, { email: 'husk@fixture.example' })
    expect(candidate.deletedAt).toBeInstanceOf(Date)
    const ctx = {
      organizationId: ORG,
      tenantId: TENANT,
      userId: USER,
      container: { resolve: (name: string) => (name === 'em' ? { fork: () => em } : null) },
    } as never
    await expect(gtmGetOpportunityTool.handler({ candidateId: candidate.id } as never, ctx)).rejects.toThrow(
      'GTM result not found',
    )
  })

  it('sets and clears an audited legal hold that blocks anonymization until lifted (M11)', async () => {
    const em = new FakeEm()
    const clock = fixedClock(LAUNCH_ISO)
    const play = await seedPlay(em)
    const run = await seedRun(em, play)
    const candidate = await seedCandidate(em, run, { email: 'held@fixture.example' })
    const first = await applyRemovalRequest(em, { email: 'held@fixture.example' }, { clock })
    const tenantRequest = (await em.find(GtmDeletionRequest, { scope: 'tenant_email' }))[0]
    expect(first.deletionStatus).toBe('completed')

    const ctx = { organizationId: ORG, tenantId: TENANT, userId: USER }
    const held = await setLegalHold(em, ctx, { requestId: tenantRequest.id, hold: true, reason: 'litigation hold 42' })
    expect(held).toMatchObject({ legalHold: true, legalHoldReason: 'litigation hold 42' })
    expect(await em.find(GtmAuditEvent, { action: 'gtm.privacy.legal_hold_set' })).toHaveLength(1)
    // A completed request stays completed; a hold on it protects the sweep.
    expect(held!.status).toBe('completed')

    const cleared = await setLegalHold(em, ctx, { requestId: tenantRequest.id, hold: false, reason: 'hold released' })
    expect(cleared).toMatchObject({ legalHold: false })
    expect(await em.find(GtmAuditEvent, { action: 'gtm.privacy.legal_hold_cleared' })).toHaveLength(1)
    expect(candidate.identity).toMatchObject({ removed: true })

    // Foreign tenant: opaque.
    expect(
      await setLegalHold(em, { ...ctx, tenantId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }, {
        requestId: tenantRequest.id,
        hold: true,
        reason: 'x',
      }),
    ).toBeNull()
  })
})
