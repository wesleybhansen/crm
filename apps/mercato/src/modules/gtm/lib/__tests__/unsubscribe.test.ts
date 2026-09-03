import { FakeEm } from './support/fake-em'
import { ctx, ORG, TENANT } from './support/campaign-fixtures'
import {
  FakeTransport,
  LAUNCH_ISO,
  fixedClock,
  seedLaunchedCampaign,
} from './support/execution-fixtures'
import {
  applyUnsubscribe,
  buildUnsubscribeUrl,
  signUnsubscribeToken,
  signScopedUnsubscribeToken,
  verifyUnsubscribeToken,
} from '../unsubscribe'
import { hashAddress } from '../campaign/exclusions'
import { claimDueAttempts } from '../execute/claim'
import { executeClaimedAttempt } from '../execute/send'
import {
  GtmAuditEvent,
  GtmSendAttempt,
  GtmSuppression,
} from '../../data/entities'

const TICK_ISO = '2026-07-22T16:30:00.000Z'

describe('unsubscribe token + one-click suppress-and-stop (SPEC-066 section 8)', () => {
  beforeAll(() => {
    process.env.GTM_UNSUBSCRIBE_SECRET = 'test-unsubscribe-secret'
    process.env.GTM_UNSUBSCRIBE_KEYRING = JSON.stringify({
      test: 'test-versioned-unsubscribe-secret',
    })
    process.env.GTM_UNSUBSCRIBE_ACTIVE_KEY_ID = 'test'
    process.env.GTM_PUBLIC_BASE_URL = 'https://crm.fixture.example'
  })

  const ENROLLMENT = 'abababab-1111-4111-8111-121212121212'
  const HASH = hashAddress('someone@fixture.example')

  it('sign/verify roundtrip', () => {
    const token = signUnsubscribeToken(ENROLLMENT, HASH)
    expect(token).toBeTruthy()
    expect(verifyUnsubscribeToken(token)).toEqual({
      version: 'v1',
      enrollmentId: ENROLLMENT,
      addressHash: HASH,
    })
  })

  it('rejects tampered, truncated, malformed, and wrong-secret tokens', () => {
    const token = signUnsubscribeToken(ENROLLMENT, HASH)!
    // Tampered payload: the signature no longer covers it.
    const otherEnrollment = 'cdcdcdcd-2222-4222-8222-343434343434'
    const [, addressHash, sig] = token.split('.')
    expect(verifyUnsubscribeToken(`${otherEnrollment}.${addressHash}.${sig}`)).toBeNull()
    // Tampered signature (same length: constant-time comparable).
    const flipped = sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0')
    expect(verifyUnsubscribeToken(`${ENROLLMENT}.${addressHash}.${flipped}`)).toBeNull()
    // Truncated / malformed.
    expect(verifyUnsubscribeToken(token.slice(0, -4))).toBeNull()
    expect(verifyUnsubscribeToken('not-a-token')).toBeNull()
    expect(verifyUnsubscribeToken(null)).toBeNull()
    expect(verifyUnsubscribeToken(undefined)).toBeNull()
    // Signed under a different secret.
    const foreign = signUnsubscribeToken(ENROLLMENT, HASH, 'other-secret')
    expect(verifyUnsubscribeToken(foreign)).toBeNull()
  })

  it('the List-Unsubscribe URL embeds a verifiable token', () => {
    const url = buildUnsubscribeUrl({
      organizationId: ORG,
      tenantId: TENANT,
      enrollmentId: ENROLLMENT,
      addressHash: HASH,
    })!
    expect(url.startsWith('https://crm.fixture.example/api/gtm/unsubscribe?token=')).toBe(true)
    const token = decodeURIComponent(url.split('token=')[1])
    expect(verifyUnsubscribeToken(token)).toEqual({
      version: 'v2',
      organizationId: ORG,
      tenantId: TENANT,
      enrollmentId: ENROLLMENT,
      addressHash: HASH,
    })
  })

  it('does not mint a new signed link from the verify-only legacy secret', () => {
    delete process.env.GTM_UNSUBSCRIBE_KEYRING
    delete process.env.GTM_UNSUBSCRIBE_ACTIVE_KEY_ID
    expect(
      buildUnsubscribeUrl({
        organizationId: ORG,
        tenantId: TENANT,
        enrollmentId: ENROLLMENT,
        addressHash: HASH,
      }),
    ).toBeNull()
    process.env.GTM_UNSUBSCRIBE_KEYRING = JSON.stringify({
      test: 'test-versioned-unsubscribe-secret',
    })
    process.env.GTM_UNSUBSCRIBE_ACTIVE_KEY_ID = 'test'
  })

  it('rotates versioned signing keys without invalidating retained tokens', () => {
    process.env.GTM_UNSUBSCRIBE_KEYRING = JSON.stringify({
      k1: 'retained-key-secret-0001',
      k2: 'active-key-secret-0000002',
    })
    process.env.GTM_UNSUBSCRIBE_ACTIVE_KEY_ID = 'k1'
    const oldToken = signScopedUnsubscribeToken({
      organizationId: ORG,
      tenantId: TENANT,
      enrollmentId: ENROLLMENT,
      addressHash: HASH,
    })!
    expect(oldToken.startsWith('v2.k1.')).toBe(true)

    process.env.GTM_UNSUBSCRIBE_ACTIVE_KEY_ID = 'k2'
    const newToken = signScopedUnsubscribeToken({
      organizationId: ORG,
      tenantId: TENANT,
      enrollmentId: ENROLLMENT,
      addressHash: HASH,
    })!
    expect(newToken.startsWith('v2.k2.')).toBe(true)
    expect(verifyUnsubscribeToken(oldToken)).toMatchObject({
      version: 'v2',
      organizationId: ORG,
      tenantId: TENANT,
      enrollmentId: ENROLLMENT,
      addressHash: HASH,
    })
    expect(verifyUnsubscribeToken(newToken)).toMatchObject({
      version: 'v2',
      organizationId: ORG,
      tenantId: TENANT,
      enrollmentId: ENROLLMENT,
      addressHash: HASH,
    })

    process.env.GTM_UNSUBSCRIBE_KEYRING = JSON.stringify({ k2: 'active-key-secret-0000002' })
    expect(verifyUnsubscribeToken(oldToken)).toBeNull()
    process.env.GTM_UNSUBSCRIBE_KEYRING = JSON.stringify({
      test: 'test-versioned-unsubscribe-secret',
    })
    process.env.GTM_UNSUBSCRIBE_ACTIVE_KEY_ID = 'test'
  })

  it('one-click POST: suppression + enrollment stop + attempt cancel + audit in one transaction', async () => {
    const em = new FakeEm()
    const clock = fixedClock(LAUNCH_ISO)
    const fixture = await seedLaunchedCampaign(em, { clock, recipients: 1, emails: 2 })
    const enrollment = fixture.enrollments[0]
    const address = fixture.addressFor(enrollment)
    const addressHash = hashAddress(address)

    const result = await applyUnsubscribe(
      em,
      { enrollmentId: enrollment.id, addressHash },
      { clock },
    )
    expect(result).toMatchObject({
      ok: true,
      enrollmentFound: true,
      suppressionCreated: true,
      enrollmentStopped: true,
      attemptsCancelled: 2,
    })

    const suppression = await em.findOne(GtmSuppression, {
      organizationId: ORG,
      channel: 'email',
      addressHash,
    })
    expect(suppression).not.toBeNull()
    expect(suppression!.reason).toBe('unsubscribe')
    expect(suppression!.scope).toBe('org')

    expect(enrollment.status).toBe('stopped')
    expect(enrollment.stopReason).toBe('unsubscribe')
    expect(enrollment.stoppedAt).toBeInstanceOf(Date)

    const attempts = await em.find(GtmSendAttempt, { enrollmentId: enrollment.id })
    for (const attempt of attempts) {
      expect(attempt.state).toBe('failed')
      expect(attempt.failureReason).toBe('stopped')
    }

    const audits = (await em.find(GtmAuditEvent, {})).filter(
      (event) => event.action === 'gtm.enrollment.unsubscribed',
    )
    expect(audits).toHaveLength(1)
  })

  it('is idempotent: a repeat POST changes nothing and still succeeds', async () => {
    const em = new FakeEm()
    const clock = fixedClock(LAUNCH_ISO)
    const fixture = await seedLaunchedCampaign(em, { clock, recipients: 1, emails: 1 })
    const enrollment = fixture.enrollments[0]
    const addressHash = hashAddress(fixture.addressFor(enrollment))

    await applyUnsubscribe(em, { enrollmentId: enrollment.id, addressHash }, { clock })
    const again = await applyUnsubscribe(em, { enrollmentId: enrollment.id, addressHash }, { clock })
    expect(again).toMatchObject({
      ok: true,
      suppressionCreated: false,
      enrollmentStopped: false,
      attemptsCancelled: 0,
    })
    const suppressions = (await em.find(GtmSuppression, { organizationId: ORG })).filter(
      (row) => row.addressHash === addressHash,
    )
    expect(suppressions).toHaveLength(1)
    expect(enrollment.stopReason).toBe('unsubscribe')
  })

  it('an unknown enrollment is reported not-found without writes', async () => {
    const em = new FakeEm()
    const result = await applyUnsubscribe(em, {
      enrollmentId: 'ffffffff-9999-4999-8999-000000000000',
      addressHash: HASH,
    })
    expect(result.ok).toBe(false)
    expect(result.enrollmentFound).toBe(false)
    expect(await em.find(GtmSuppression, {})).toHaveLength(0)
  })

  it('races a claimed send: the stop cancels the claim so an in-flight executor cannot send', async () => {
    const em = new FakeEm()
    const launchClock = fixedClock(LAUNCH_ISO)
    const fixture = await seedLaunchedCampaign(em, { clock: launchClock, recipients: 1, emails: 2 })
    const enrollment = fixture.enrollments[0]
    const addressHash = hashAddress(fixture.addressFor(enrollment))

    const clock = fixedClock(TICK_ISO)
    const claim = await claimDueAttempts(em, ctx, { clock })
    expect(claim.claimed).toHaveLength(1)
    const claimedRow = claim.claimed[0].attempt
    expect(claimedRow.state).toBe('claimed')

    await applyUnsubscribe(em, { enrollmentId: enrollment.id, addressHash }, { clock })

    // The claim is CANCELLED, not left in flight. This is the guarantee: the
    // executor reads enrollment.status early, then performs nine more DB round
    // trips before contacting the provider, so relying on that recheck alone
    // lets a stop that commits mid-window be mailed over anyway.
    //
    // Cancelling is safe because execute/send.ts writes 'provider_started'
    // BEFORE the transport, so a row still in 'claimed' has provably not
    // reached the provider.
    expect(claimedRow.state).toBe('failed')
    expect(claimedRow.failureReason).toBe('stopped')
    // Nulling the token is what fences an executor that ALREADY passed its
    // pre-send recheck: its conditional write can no longer match this row.
    expect(claimedRow.claimToken).toBeNull()

    // And nothing is sent.
    const transport = new FakeTransport()
    const outcome = await executeClaimedAttempt(em, ctx, claimedRow, { transport, clock })
    expect(outcome.outcome).not.toBe('accepted')
    expect(transport.calls).toHaveLength(0)
  })
})

/*
 * Review M7: a v2 token carries the signed org + tenant, so the compliance
 * promise must not depend on the enrollment row still existing.
 */
describe('applyUnsubscribe with a purged enrollment (review M7)', () => {
  beforeAll(() => {
    process.env.GTM_UNSUBSCRIBE_KEYRING = JSON.stringify({ test: 'test-versioned-unsubscribe-secret' })
    process.env.GTM_UNSUBSCRIBE_ACTIVE_KEY_ID = 'test'
  })

  it('writes the org-scoped suppression from the v2 token scope alone, idempotently', async () => {
    const em = new FakeEm()
    const enrollmentId = 'abababab-1111-4111-8111-121212121212'
    const addressHash = hashAddress('purged@fixture.example')
    const token = signScopedUnsubscribeToken({ organizationId: ORG, tenantId: TENANT, enrollmentId, addressHash })!
    const payload = verifyUnsubscribeToken(token)!
    expect(payload.version).toBe('v2')

    const first = await applyUnsubscribe(em, payload)
    expect(first).toMatchObject({ ok: true, enrollmentFound: false, suppressionCreated: true })
    const rows = await em.find(GtmSuppression, { organizationId: ORG, channel: 'email', addressHash })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ scope: 'org', tenantId: TENANT, reason: 'unsubscribe' })
    expect(rows[0].addressDisplay ?? null).toBeNull()
    expect(rows[0].source).toMatchObject({ via: 'one_click', enrollment_missing: true })
    const audits = await em.find(GtmAuditEvent, { action: 'gtm.enrollment.unsubscribed' })
    expect(audits).toHaveLength(1)
    expect(audits[0].metadata).toMatchObject({ address_hash: addressHash, enrollment_missing: true })

    const second = await applyUnsubscribe(em, payload)
    expect(second).toMatchObject({ ok: true, enrollmentFound: false, suppressionCreated: false })
    expect(await em.find(GtmSuppression, { organizationId: ORG, channel: 'email', addressHash })).toHaveLength(1)
  })

  it('still reports nothing to do for a legacy v1 token with no scope', async () => {
    const em = new FakeEm()
    const result = await applyUnsubscribe(em, {
      enrollmentId: 'abababab-1111-4111-8111-121212121212',
      addressHash: hashAddress('legacy@fixture.example'),
    })
    expect(result).toMatchObject({ ok: false, enrollmentFound: false, suppressionCreated: false })
    expect(await em.find(GtmSuppression, {})).toHaveLength(0)
  })
})
