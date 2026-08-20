import { FakeEm } from './support/fake-em'
import {
  ctx,
  ORG,
  seedCandidate,
  seedPlay,
  seedRun,
  TENANT,
  WORKSPACE,
} from './support/campaign-fixtures'
import { computeExclusions, hashAddress } from '../campaign/exclusions'
import {
  GtmCampaign,
  GtmEnrollment,
  GtmSuppression,
} from '../../data/entities'
import { EmailUnsubscribe } from '../../../email/data/schema'

async function seedSuppression(
  em: FakeEm,
  address: string,
  overrides: Partial<{
    channel: string
    reason: string
    scope: string
    expiresAt: Date | null
    organizationId: string
  }> = {},
) {
  const row = em.create(GtmSuppression, {
    organizationId: overrides.organizationId ?? ORG,
    tenantId: TENANT,
    scope: overrides.scope ?? 'org',
    channel: overrides.channel ?? 'email',
    addressHash: hashAddress(address),
    addressDisplay: address,
    reason: overrides.reason ?? 'unsubscribe',
    expiresAt: overrides.expiresAt ?? null,
  })
  em.persist(row)
  await em.flush()
  return row
}

async function seedLiveCampaignEnrollment(
  em: FakeEm,
  candidateId: string,
  status: { campaign?: string; enrollment?: string } = {},
) {
  const campaign = em.create(GtmCampaign, {
    organizationId: ORG,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    playId: 'ffffffff-0000-4000-8000-000000000001',
    name: 'Other live campaign',
    status: status.campaign ?? 'active',
  })
  em.persist(campaign)
  const enrollment = em.create(GtmEnrollment, {
    organizationId: ORG,
    tenantId: TENANT,
    campaignId: campaign.id,
    campaignVersionId: 'ffffffff-0000-4000-8000-000000000002',
    candidateId,
    status: status.enrollment ?? 'active',
  })
  em.persist(enrollment)
  await em.flush()
  return { campaign, enrollment }
}

describe('computeExclusions (SPEC-066 section 8 at build time)', () => {
  it('excludes candidates without a verified email contact point', async () => {
    const em = new FakeEm()
    const run = await seedRun(em, await seedPlay(em))
    const unverified = await seedCandidate(em, run, { verificationState: 'found' })
    const missing = await seedCandidate(em, run, { email: null })
    const good = await seedCandidate(em, run, {})

    const result = await computeExclusions(em, ctx, {
      workspaceId: WORKSPACE,
      candidateIds: [unverified.id, missing.id, good.id],
      channel: 'email',
    })
    expect(result.byCandidate.get(unverified.id)).toMatchObject({
      excluded: true,
      reason: 'no_verified_contact_point',
    })
    expect(result.byCandidate.get(missing.id)).toMatchObject({
      excluded: true,
      reason: 'no_verified_contact_point',
    })
    expect(result.byCandidate.get(good.id)).toMatchObject({ excluded: false, reason: null })
    expect(result.summary).toMatchObject({ total: 3, excluded: 2 })
  })

  it('excludes on an org-scoped gtm suppression and surfaces the row reason', async () => {
    const em = new FakeEm()
    const run = await seedRun(em, await seedPlay(em))
    const candidate = await seedCandidate(em, run, { email: 'bounced@fixture.example' })
    await seedSuppression(em, 'bounced@fixture.example', { reason: 'hard_bounce' })

    const result = await computeExclusions(em, ctx, {
      workspaceId: WORKSPACE,
      candidateIds: [candidate.id],
      channel: 'email',
    })
    expect(result.byCandidate.get(candidate.id)).toMatchObject({
      excluded: true,
      reason: 'hard_bounce',
      source: 'gtm_suppression',
    })
  })

  it("matches channel 'all' suppressions and ignores expired ones", async () => {
    const em = new FakeEm()
    const run = await seedRun(em, await seedPlay(em))
    const allChannel = await seedCandidate(em, run, { email: 'legal@fixture.example' })
    const expired = await seedCandidate(em, run, { email: 'expired@fixture.example' })
    await seedSuppression(em, 'legal@fixture.example', { channel: 'all', reason: 'legal' })
    await seedSuppression(em, 'expired@fixture.example', {
      reason: 'manual',
      expiresAt: new Date('2026-01-01T00:00:00.000Z'),
    })

    const result = await computeExclusions(em, ctx, {
      workspaceId: WORKSPACE,
      candidateIds: [allChannel.id, expired.id],
      channel: 'email',
    })
    expect(result.byCandidate.get(allChannel.id)).toMatchObject({ excluded: true, reason: 'legal' })
    expect(result.byCandidate.get(expired.id)).toMatchObject({ excluded: false })
  })

  it('does not apply another org suppression unless it is global scope', async () => {
    const em = new FakeEm()
    const run = await seedRun(em, await seedPlay(em))
    const foreign = await seedCandidate(em, run, { email: 'foreign@fixture.example' })
    const global = await seedCandidate(em, run, { email: 'global@fixture.example' })
    await seedSuppression(em, 'foreign@fixture.example', {
      organizationId: 'aaaaaaaa-9999-4999-8999-999999999999',
    })
    await seedSuppression(em, 'global@fixture.example', {
      organizationId: 'aaaaaaaa-9999-4999-8999-999999999999',
      scope: 'global',
      reason: 'complaint',
    })

    const result = await computeExclusions(em, ctx, {
      workspaceId: WORKSPACE,
      candidateIds: [foreign.id, global.id],
      channel: 'email',
    })
    expect(result.byCandidate.get(foreign.id)).toMatchObject({ excluded: false })
    expect(result.byCandidate.get(global.id)).toMatchObject({ excluded: true, reason: 'complaint' })
  })

  it('imports legacy email_unsubscribes one-way as unsubscribe annotations without writing anything', async () => {
    const em = new FakeEm()
    const run = await seedRun(em, await seedPlay(em))
    const candidate = await seedCandidate(em, run, { email: 'OptedOut@Fixture.example' })
    em.persist(
      em.create(EmailUnsubscribe, {
        organizationId: ORG,
        tenantId: TENANT,
        email: 'optedout@fixture.example',
      }),
    )
    await em.flush()

    const before = em.table(EmailUnsubscribe).length
    const result = await computeExclusions(em, ctx, {
      workspaceId: WORKSPACE,
      candidateIds: [candidate.id],
      channel: 'email',
    })
    expect(result.byCandidate.get(candidate.id)).toMatchObject({
      excluded: true,
      reason: 'unsubscribe',
      source: 'legacy',
    })
    // Read-only import semantics: neither table is written.
    expect(em.table(EmailUnsubscribe)).toHaveLength(before)
    expect(em.table(GtmSuppression)).toHaveLength(0)
  })

  it('excludes an address actively enrolled in another live campaign as a duplicate', async () => {
    const em = new FakeEm()
    const run = await seedRun(em, await seedPlay(em))
    const shared = 'shared@fixture.example'
    const enrolledElsewhere = await seedCandidate(em, run, { email: shared })
    const target = await seedCandidate(em, run, { email: shared })
    await seedLiveCampaignEnrollment(em, enrolledElsewhere.id)

    const result = await computeExclusions(em, ctx, {
      workspaceId: WORKSPACE,
      candidateIds: [target.id],
      channel: 'email',
    })
    expect(result.byCandidate.get(target.id)).toMatchObject({
      excluded: true,
      reason: 'duplicate',
      source: 'duplicate',
    })
  })

  it('lets the explicit override flag bypass duplicate protection only', async () => {
    const em = new FakeEm()
    const run = await seedRun(em, await seedPlay(em))
    const shared = 'shared2@fixture.example'
    const enrolledElsewhere = await seedCandidate(em, run, { email: shared })
    const target = await seedCandidate(em, run, { email: shared })
    const suppressed = await seedCandidate(em, run, { email: 'still-out@fixture.example' })
    await seedLiveCampaignEnrollment(em, enrolledElsewhere.id)
    await seedSuppression(em, 'still-out@fixture.example')

    const result = await computeExclusions(em, ctx, {
      workspaceId: WORKSPACE,
      candidateIds: [target.id, suppressed.id],
      channel: 'email',
      allowDuplicates: true,
    })
    expect(result.byCandidate.get(target.id)).toMatchObject({ excluded: false })
    expect(result.byCandidate.get(suppressed.id)).toMatchObject({
      excluded: true,
      reason: 'unsubscribe',
    })
  })

  it('ignores stopped enrollments and the campaign being built when detecting duplicates', async () => {
    const em = new FakeEm()
    const run = await seedRun(em, await seedPlay(em))
    const shared = 'stopped@fixture.example'
    const stoppedElsewhere = await seedCandidate(em, run, { email: shared })
    const target = await seedCandidate(em, run, { email: shared })
    const { campaign: ownCampaign } = await seedLiveCampaignEnrollment(em, stoppedElsewhere.id, {
      enrollment: 'stopped',
    })

    const result = await computeExclusions(em, ctx, {
      workspaceId: WORKSPACE,
      candidateIds: [target.id],
      channel: 'email',
      excludeCampaignId: ownCampaign.id,
    })
    expect(result.byCandidate.get(target.id)).toMatchObject({ excluded: false })
  })
})
