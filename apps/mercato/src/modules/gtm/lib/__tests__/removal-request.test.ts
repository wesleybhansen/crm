import { FakeEm } from './support/fake-em'
import { ORG, OTHER_ORG, TENANT, ctx, seedCandidate, seedPlay, seedRun } from './support/campaign-fixtures'
import { LAUNCH_ISO, fixedClock, seedLaunchedCampaign } from './support/execution-fixtures'
import {
  GLOBAL_SUPPRESSION_ORG_ID,
  GLOBAL_SUPPRESSION_TENANT_ID,
  applyRemovalRequest,
  normalizeRemovalEmail,
} from '../removal-request'
import { computeExclusions, hashAddress } from '../campaign/exclusions'
import { GtmAuditEvent, GtmEnrollment, GtmSendAttempt, GtmSuppression } from '../../data/entities'

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

  it('the global row excludes the address in an unrelated org', async () => {
    const em = new FakeEm()
    const run = await seedRun(em, await seedPlay(em))
    const candidate = await seedCandidate(em, run, { email: ADDRESS })
    await applyRemovalRequest(em, { email: ADDRESS })

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
})
