/**
 * R4 controlled owned-mailbox rehearsal.
 *
 * This spec is skipped unless the dedicated loopback broker supplies the
 * explicit gate and in-memory owned-mailbox inputs. It permits one SMTP send
 * and one exact-header IMAP reply. It must never run in normal CI.
 */
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, test } from '@playwright/test'
import { Pool } from 'pg'
import {
  bindSingleOwnedRecipient,
  createOwnedGmailMailbox,
  GTM_FIXTURE_NOLI_USER_ID,
  postGtm,
  resetSyntheticGtmState,
} from './helpers/gtmFixtures'

type Json = Record<string, any>

const enabled = process.env.OM_GTM_OWNED_MAILBOX_E2E_ENABLED === '1'

function requiredInput(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`R4 input ${name} is required`)
  return value
}

function validateOwnedInputs() {
  const senderEmail = requiredInput('OM_GTM_OWNED_SENDER_EMAIL').toLowerCase()
  const recipientEmail = requiredInput('OM_GTM_OWNED_RECIPIENT_EMAIL').toLowerCase()
  const appPassword = requiredInput('OM_GTM_OWNED_GMAIL_APP_PASSWORD').replaceAll(' ', '')
  if (!/^[^\s@]+@(gmail|googlemail)\.com$/.test(senderEmail)) {
    throw new Error('R4 sender must be an owned Gmail address')
  }
  if (!/^[^\s@]+@(yahoo\.com|proton\.me|protonmail\.com|pm\.me)$/.test(recipientEmail)) {
    throw new Error('R4 recipient must be an owned Yahoo or Proton address')
  }
  if (senderEmail === recipientEmail) throw new Error('R4 sender and recipient must differ')
  if (appPassword.length < 16 || appPassword.length > 128) {
    throw new Error('R4 Gmail app password has an invalid length')
  }
  return { senderEmail, recipientEmail, appPassword }
}

function databasePool() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is required for R4')
  return new Pool({ connectionString, max: 2 })
}

async function body(response: { json(): Promise<unknown> }): Promise<Json> {
  return await response.json() as Json
}

function currentSendWindow(): { start_hour: number; end_hour: number; timezone: string } {
  const zones = [
    'America/Los_Angeles',
    'America/Denver',
    'America/Chicago',
    'America/New_York',
    'Europe/London',
    'Europe/Berlin',
    'Asia/Tokyo',
    'Australia/Sydney',
  ]
  for (const timezone of zones) {
    const hour = Number(new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: timezone,
    }).format(new Date())) % 24
    if (hour >= 1 && hour <= 22) {
      return { start_hour: hour - 1, end_hour: hour + 1, timezone }
    }
  }
  throw new Error('Unable to choose a bounded current send window')
}

async function ingestOwnedMailbox(input: {
  request: Parameters<typeof postGtm>[0]
  mailboxId: string
  inReplyTo?: string | null
}) {
  const response = await postGtm(input.request, '/internal/gtm/execution', {
    op: 'r4-owned-mailbox-ingest',
    noliUserId: GTM_FIXTURE_NOLI_USER_ID,
    mailboxConnectionId: input.mailboxId,
    ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
  })
  expect(response.status()).toBe(200)
  return await body(response)
}

test.describe('GTM R4 owned-mailbox activation rehearsal', () => {
  test.describe.configure({ retries: 0 })
  test.skip(!enabled, 'R4 requires the explicit owned-mailbox loopback broker')
  test.setTimeout(15 * 60 * 1000)

  let mailboxId: string | null = null

  test.afterEach(async () => {
    await resetSyntheticGtmState(mailboxId)
    mailboxId = null
  })

  test('TC-GTM-002: one owned send and one exact-header reply stop the enrollment', async ({ request }) => {
    const owned = validateOwnedInputs()
    const pool = databasePool()
    try {
      const reportTokenHash = randomUUID().replaceAll('-', '').padEnd(64, '0')
      const importedResponse = await postGtm(request, '/internal/gtm/import-audience-play', {
        noliUserId: GTM_FIXTURE_NOLI_USER_ID,
        report_token_hash: reportTokenHash,
        likely_buyer: 'Owned mailbox lifecycle rehearsal',
        play: {
          market_type: 'b2b',
          audience: 'Synthetic operations leaders',
          signal: 'Synthetic hiring activity',
          signal_kind: 'hiring_activity',
          provider_query: { titles: ['Head of Operations'] },
          source_hint: 'Deterministic R4 fixture',
          geography: 'United States',
          recency_window: '90 days',
          why_now: 'A synthetic operations change provides a bounded test trigger.',
          recommended_angle: 'Confirm the owned mailbox lifecycle.',
          supported_channels: ['email'],
          entity_unit: 'people',
          estimate_basis: 'modeled',
          confidence: 'high',
        },
      })
      expect(importedResponse.status()).toBe(200)
      const imported = await body(importedResponse)

      const limits = { targetAccepted: 1, maxRawCandidates: 2, maxCredits: 10 }
      const plan = await body(await postGtm(request, '/internal/gtm/research-runs', {
        op: 'plan',
        noliUserId: GTM_FIXTURE_NOLI_USER_ID,
        playId: imported.data.playId,
        limits,
      }))
      const created = await body(await postGtm(request, '/internal/gtm/research-runs', {
        op: 'create',
        noliUserId: GTM_FIXTURE_NOLI_USER_ID,
        playId: imported.data.playId,
        limits,
        expectedPlanHash: plan.plan.plan_hash,
      }))
      const executed = await postGtm(request, '/internal/gtm/research-runs', {
        op: 'execute',
        noliUserId: GTM_FIXTURE_NOLI_USER_ID,
        runId: created.run.id,
        expectedPlanHash: plan.plan.plan_hash,
      })
      expect(executed.status()).toBe(200)

      const enrichmentPlan = await body(await postGtm(request, '/internal/gtm/enrich', {
        op: 'plan',
        noliUserId: GTM_FIXTURE_NOLI_USER_ID,
        runId: created.run.id,
      }))
      const enrichment = await postGtm(request, '/internal/gtm/enrich', {
        op: 'run',
        noliUserId: GTM_FIXTURE_NOLI_USER_ID,
        runId: created.run.id,
        maxCredits: enrichmentPlan.plan.maximum_credits,
        expectedPlanHash: enrichmentPlan.plan.plan_hash,
      })
      expect(enrichment.status()).toBe(200)

      const mailbox = await createOwnedGmailMailbox({
        senderEmail: owned.senderEmail,
        appPassword: owned.appPassword,
      })
      mailboxId = mailbox.id
      await bindSingleOwnedRecipient({
        organizationId: mailbox.organizationId,
        tenantId: mailbox.tenantId,
        recipientEmail: owned.recipientEmail,
      })

      const baseline = await ingestOwnedMailbox({
        request,
        mailboxId: mailbox.id,
      })
      expect(baseline).toMatchObject({ messages: 0, resync_required: false })
      const historicalRows = await pool.query(
        `select count(*)::int as count
           from email_messages
          where organization_id = $1 and tenant_id = $2 and account_id = $3`,
        [mailbox.organizationId, mailbox.tenantId, mailbox.id],
      )
      expect(historicalRows.rows[0].count).toBe(0)

      const campaignResponse = await postGtm(request, '/internal/gtm/campaigns', {
        op: 'create',
        noliUserId: GTM_FIXTURE_NOLI_USER_ID,
        workspaceId: imported.data.workspaceId,
        playId: imported.data.playId,
        name: 'Owned mailbox lifecycle rehearsal',
        channelMix: { emails: 1 },
        settings: {
          daily_cap: 1,
          send_window: currentSendWindow(),
          jitter_minutes: 0,
          mailbox_connection_id: mailbox.id,
        },
      })
      expect(campaignResponse.status()).toBe(200)
      const campaign = await body(campaignResponse)

      expect((await postGtm(request, '/internal/gtm/campaigns', {
        op: 'update-workspace-settings',
        noliUserId: GTM_FIXTURE_NOLI_USER_ID,
        workspaceId: imported.data.workspaceId,
        postal_address: '100 Owned Mailbox Test Way, Test City, CA 94105',
      })).status()).toBe(200)

      const draft = await body(await postGtm(request, '/internal/gtm/campaigns', {
        op: 'draft-state',
        noliUserId: GTM_FIXTURE_NOLI_USER_ID,
        campaignId: campaign.campaign.id,
      }))
      expect(draft.draft.recipients).toHaveLength(1)
      const approvalResponse = await postGtm(request, '/internal/gtm/campaigns', {
        op: 'approve',
        noliUserId: GTM_FIXTURE_NOLI_USER_ID,
        campaignId: campaign.campaign.id,
        expected_content_hash: draft.draft.content_hash,
      })
      expect(approvalResponse.status()).toBe(200)
      const approval = await body(approvalResponse)

      const launchResponse = await postGtm(request, '/internal/gtm/execution', {
        op: 'launch',
        noliUserId: GTM_FIXTURE_NOLI_USER_ID,
        campaignId: campaign.campaign.id,
        expectedContentHash: approval.version.content_hash,
      })
      expect(launchResponse.status()).toBe(200)
      const launched = await body(launchResponse)
      expect(launched.attempts).toBe(1)

      const beforeDispatch = await pool.query(
        `select count(*)::int as total,
                count(*) filter (where state in ('provider_started', 'accepted', 'sent', 'ambiguous'))::int as contacted
           from gtm_send_attempts
          where organization_id = $1 and tenant_id = $2 and campaign_version_id = $3`,
        [mailbox.organizationId, mailbox.tenantId, approval.version.id],
      )
      expect(beforeDispatch.rows[0]).toEqual({ total: 1, contacted: 0 })

      let acceptedRow: { id: string; rfc_message_id: string; provider_message_id: string | null } | null = null
      for (let attempt = 0; attempt < 10 && !acceptedRow; attempt += 1) {
        const tickResponse = await postGtm(request, '/internal/gtm/execution', {
          op: 'tick',
          noliUserId: GTM_FIXTURE_NOLI_USER_ID,
          limit: 1,
        })
        expect(tickResponse.status()).toBe(200)
        const rows = await pool.query(
          `select id, rfc_message_id, provider_message_id
             from gtm_send_attempts
            where organization_id = $1
              and tenant_id = $2
              and campaign_version_id = $3
              and state = 'accepted'`,
          [mailbox.organizationId, mailbox.tenantId, approval.version.id],
        ) as { rows: Array<{ id: string; rfc_message_id: string; provider_message_id: string | null }> }
        acceptedRow = rows.rows[0] ?? null
        if (!acceptedRow) await delay(1_000)
      }
      expect(acceptedRow?.rfc_message_id).toMatch(/^<[^>]+>$/)
      expect(acceptedRow?.provider_message_id).toBeTruthy()
      console.log('::gtm-owned-e2e:send-accepted::')

      let correlated = false
      const replyDeadline = Date.now() + 10 * 60 * 1000
      while (!correlated && Date.now() < replyDeadline) {
        const result = await ingestOwnedMailbox({
          request,
          mailboxId: mailbox.id,
          inReplyTo: acceptedRow?.rfc_message_id,
        })
        if (result.messages > 1) throw new Error('R4 received more than the one authorized reply')
        const replyCount = await pool.query(
          `select count(*)::int as count
             from gtm_replies
            where organization_id = $1 and tenant_id = $2 and send_attempt_id = $3`,
          [mailbox.organizationId, mailbox.tenantId, acceptedRow?.id],
        )
        correlated = replyCount.rows[0].count === 1
        if (!correlated) await delay(5_000)
      }
      expect(correlated).toBe(true)

      const lifecycle = await pool.query(
        `select
           (select count(*)::int from gtm_replies where organization_id = $1 and tenant_id = $2 and send_attempt_id = $3) as replies,
           (select count(*)::int from gtm_inbound_events where organization_id = $1 and tenant_id = $2 and send_attempt_id = $3) as events,
           (select count(*)::int from gtm_enrollments where organization_id = $1 and tenant_id = $2 and status = 'stopped' and stop_reason = 'email_reply') as stopped,
           (select count(*)::int from gtm_mailbox_cursors where organization_id = $1 and tenant_id = $2 and mailbox_connection_id = $4 and cursor_hash is not null) as cursors`,
        [mailbox.organizationId, mailbox.tenantId, acceptedRow?.id, mailbox.id],
      )
      expect(lifecycle.rows[0]).toEqual({ replies: 1, events: 1, stopped: 1, cursors: 1 })
      console.log('::gtm-owned-e2e:reply-correlated::')
    } finally {
      await pool.end()
    }
  })
})
