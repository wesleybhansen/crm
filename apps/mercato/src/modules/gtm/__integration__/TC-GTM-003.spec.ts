/**
 * R5 disposable public-unsubscribe integration.
 *
 * Crosses the real public GET/POST handler and disposable PostgreSQL state.
 * The ephemeral runtime supplies the v2 keyring; execution, ingestion, real
 * providers, and email delivery all remain disabled.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { Pool } from 'pg'
import {
  createSyntheticMailbox,
  GTM_FIXTURE_NOLI_USER_ID,
  postGtm,
  resetSyntheticGtmState,
  type SyntheticMailbox,
} from './helpers/gtmFixtures'

type Json = Record<string, any>

function hashAddress(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex')
}

function signScopedUnsubscribeToken(input: {
  organizationId: string
  tenantId: string
  enrollmentId: string
  addressHash: string
}): string {
  const activeKeyId = process.env.GTM_UNSUBSCRIBE_ACTIVE_KEY_ID?.trim()
  const rawKeyring = process.env.GTM_UNSUBSCRIBE_KEYRING
  if (!activeKeyId || !rawKeyring) throw new Error('Disposable unsubscribe keyring is required')
  const keyring = JSON.parse(rawKeyring) as Record<string, unknown>
  const key = keyring[activeKeyId]
  if (typeof key !== 'string' || key.length < 16) {
    throw new Error('Disposable unsubscribe signing key is invalid')
  }
  const payload = [
    'v2',
    activeKeyId,
    input.organizationId,
    input.tenantId,
    input.enrollmentId,
    input.addressHash,
  ].join('.')
  const signature = createHmac('sha256', key).update(payload).digest('hex')
  return `${payload}.${signature}`
}

async function body(response: { json(): Promise<unknown> }): Promise<Json> {
  return await response.json() as Json
}

async function expectOk(response: { status(): number; json(): Promise<unknown> }): Promise<Json> {
  expect(response.status()).toBe(200)
  return await body(response)
}

async function createLaunchedSyntheticCampaign(
  request: APIRequestContext,
  onMailbox: (mailbox: SyntheticMailbox) => void,
): Promise<{ campaignId: string; mailbox: SyntheticMailbox }> {
  const imported = await expectOk(await postGtm(request, '/internal/gtm/import-audience-play', {
    noliUserId: GTM_FIXTURE_NOLI_USER_ID,
    report_token_hash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
    likely_buyer: 'Synthetic compliance fixture',
    play: {
      market_type: 'b2b',
      audience: 'Synthetic US operations leaders',
      signal: 'Synthetic operations hiring activity',
      signal_kind: 'hiring_activity',
      provider_query: { titles: ['Head of Operations'] },
      source_hint: 'Deterministic R5 fixture',
      geography: 'United States',
      recency_window: '90 days',
      why_now: 'A synthetic change provides a bounded compliance trigger.',
      recommended_angle: 'Exercise the disposable unsubscribe boundary.',
      supported_channels: ['email'],
      entity_unit: 'people',
      estimate_basis: 'modeled',
      confidence: 'high',
    },
  }))
  const limits = { targetAccepted: 1, maxRawCandidates: 2, maxCredits: 10 }
  const plan = await expectOk(await postGtm(request, '/internal/gtm/research-runs', {
    op: 'plan',
    noliUserId: GTM_FIXTURE_NOLI_USER_ID,
    playId: imported.data.playId,
    limits,
  }))
  const created = await expectOk(await postGtm(request, '/internal/gtm/research-runs', {
    op: 'create',
    noliUserId: GTM_FIXTURE_NOLI_USER_ID,
    playId: imported.data.playId,
    limits,
    expectedPlanHash: plan.plan.plan_hash,
  }))
  await expectOk(await postGtm(request, '/internal/gtm/research-runs', {
    op: 'execute',
    noliUserId: GTM_FIXTURE_NOLI_USER_ID,
    runId: created.run.id,
    expectedPlanHash: plan.plan.plan_hash,
  }))
  const enrichmentPlan = await expectOk(await postGtm(request, '/internal/gtm/enrich', {
    op: 'plan',
    noliUserId: GTM_FIXTURE_NOLI_USER_ID,
    runId: created.run.id,
  }))
  await expectOk(await postGtm(request, '/internal/gtm/enrich', {
    op: 'run',
    noliUserId: GTM_FIXTURE_NOLI_USER_ID,
    runId: created.run.id,
    maxCredits: enrichmentPlan.plan.maximum_credits,
    expectedPlanHash: enrichmentPlan.plan.plan_hash,
  }))

  const mailbox = await createSyntheticMailbox()
  onMailbox(mailbox)
  const campaign = await expectOk(await postGtm(request, '/internal/gtm/campaigns', {
    op: 'create',
    noliUserId: GTM_FIXTURE_NOLI_USER_ID,
    workspaceId: imported.data.workspaceId,
    playId: imported.data.playId,
    name: 'Synthetic unsubscribe integration',
    channelMix: { emails: 2 },
    settings: {
      daily_cap: 5,
      send_window: { start_hour: 9, end_hour: 17, timezone: 'America/Los_Angeles' },
      jitter_minutes: 0,
      mailbox_connection_id: mailbox.id,
    },
  }))
  await expectOk(await postGtm(request, '/internal/gtm/campaigns', {
    op: 'update-workspace-settings',
    noliUserId: GTM_FIXTURE_NOLI_USER_ID,
    workspaceId: imported.data.workspaceId,
    postal_address: '100 Synthetic Compliance Way, Test City, CA 94105',
  }))
  const draft = await expectOk(await postGtm(request, '/internal/gtm/campaigns', {
    op: 'draft-state',
    noliUserId: GTM_FIXTURE_NOLI_USER_ID,
    campaignId: campaign.campaign.id,
  }))
  const approval = await expectOk(await postGtm(request, '/internal/gtm/campaigns', {
    op: 'approve',
    noliUserId: GTM_FIXTURE_NOLI_USER_ID,
    campaignId: campaign.campaign.id,
    expected_content_hash: draft.draft.content_hash,
  }))
  await expectOk(await postGtm(request, '/internal/gtm/execution', {
    op: 'launch',
    noliUserId: GTM_FIXTURE_NOLI_USER_ID,
    campaignId: campaign.campaign.id,
    expectedContentHash: approval.version.content_hash,
  }))
  return { campaignId: campaign.campaign.id, mailbox }
}

test.describe('GTM R5 disposable public-unsubscribe integration', () => {
  let mailboxId: string | null = null

  test.afterEach(async () => {
    await resetSyntheticGtmState(mailboxId)
    mailboxId = null
  })

  test('TC-GTM-003: public one-click unsubscribe is atomic, opaque, and idempotent', async ({ request }) => {
    const fixture = await createLaunchedSyntheticCampaign(request, (mailbox) => {
      mailboxId = mailbox.id
    })
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
    try {
      const enrollmentResult = await pool.query(
        `select enrollment.id,
                enrollment.organization_id,
                enrollment.tenant_id,
                point.value as address
           from gtm_enrollments enrollment
           join gtm_contact_points point
             on point.candidate_id = enrollment.candidate_id
            and point.organization_id = enrollment.organization_id
            and point.tenant_id = enrollment.tenant_id
            and point.channel = 'email'
            and point.verification_state = 'verified'
            and point.deleted_at is null
          where enrollment.campaign_id = $1
            and enrollment.deleted_at is null
          order by enrollment.created_at, enrollment.id
          limit 1`,
        [fixture.campaignId],
      ) as { rows: Array<{
        id: string
        organization_id: string
        tenant_id: string
        address: string
      }> }
      const enrollment = enrollmentResult.rows[0]
      expect(enrollment).toBeTruthy()
      const addressHash = hashAddress(enrollment.address)
      const token = signScopedUnsubscribeToken({
        organizationId: enrollment.organization_id,
        tenantId: enrollment.tenant_id,
        enrollmentId: enrollment.id,
        addressHash,
      })
      const encoded = encodeURIComponent(token)
      const path = `/api/gtm/unsubscribe?token=${encoded}`
      const tampered = `${path.slice(0, -1)}${path.endsWith('0') ? '1' : '0'}`

      expect((await request.get(tampered)).status()).toBe(404)
      const confirmation = await request.get(path)
      expect(confirmation.status()).toBe(200)
      const html = await confirmation.text()
      expect(html).toContain('method="post"')
      expect(html).toContain('name="List-Unsubscribe" value="One-Click"')

      const oneClick = await request.post(path, {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        data: 'List-Unsubscribe=One-Click',
      })
      expect(oneClick.status()).toBe(200)
      expect(await oneClick.text()).toBe('You have been unsubscribed.')

      const lifecycle = await pool.query(
        `select
           (select count(*)::int from gtm_suppressions
             where organization_id = $1 and tenant_id = $2
               and channel = 'email' and address_hash = $3
               and reason = 'unsubscribe' and deleted_at is null) as suppressions,
           (select count(*)::int from gtm_enrollments
             where id = $4 and organization_id = $1 and tenant_id = $2
               and status = 'stopped' and stop_reason = 'unsubscribe') as stopped,
           (select count(*)::int from gtm_send_attempts
             where enrollment_id = $4 and organization_id = $1 and tenant_id = $2) as attempts,
           (select count(*)::int from gtm_send_attempts
             where enrollment_id = $4 and organization_id = $1 and tenant_id = $2
               and state = 'failed' and failure_reason = 'stopped') as cancelled,
           (select count(*)::int from gtm_audit_events
             where organization_id = $1 and tenant_id = $2
               and object_id = $4 and action = 'gtm.enrollment.unsubscribed') as audits`,
        [enrollment.organization_id, enrollment.tenant_id, addressHash, enrollment.id],
      )
      expect(lifecycle.rows[0]).toEqual({
        suppressions: 1,
        stopped: 1,
        attempts: 2,
        cancelled: 2,
        audits: 1,
      })

      const replay = await request.post(path, {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        data: 'List-Unsubscribe=One-Click',
      })
      expect(replay.status()).toBe(200)
      const afterReplay = await pool.query(
        `select
           (select count(*)::int from gtm_suppressions
             where organization_id = $1 and tenant_id = $2
               and channel = 'email' and address_hash = $3
               and reason = 'unsubscribe' and deleted_at is null) as suppressions,
           (select count(*)::int from gtm_audit_events
             where organization_id = $1 and tenant_id = $2
               and object_id = $4 and action = 'gtm.enrollment.unsubscribed') as audits`,
        [enrollment.organization_id, enrollment.tenant_id, addressHash, enrollment.id],
      )
      expect(afterReplay.rows[0]).toEqual({ suppressions: 1, audits: 1 })
    } finally {
      await pool.end()
    }
  })
})
