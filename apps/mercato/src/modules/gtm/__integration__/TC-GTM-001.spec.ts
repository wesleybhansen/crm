/**
 * R2 synthetic activation rehearsal.
 *
 * Runs the real shared-secret identity resolution, CRM authorization, durable
 * PostgreSQL state, immutable quote/approval hashes, capacity materialization,
 * and execution kill switch. Noli Core, provider rows, credits, and mailbox
 * identity are synthetic; no provider or transport endpoint exists.
 */
import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import {
  createSyntheticMailbox,
  GTM_FIXTURE_NOLI_USER_ID,
  postGtm,
  resetSyntheticGtmState,
} from './helpers/gtmFixtures'

type Json = Record<string, any>

async function body(response: { json(): Promise<unknown> }): Promise<Json> {
  return await response.json() as Json
}

test.describe('GTM R2 no-send activation rehearsal', () => {
  let mailboxId: string | null = null

  test.afterEach(async () => {
    await resetSyntheticGtmState(mailboxId)
    mailboxId = null
  })

  test('TC-GTM-001: R2 synthetic audience-to-launched-state stays transport-dark', async ({ request }) => {
    const reportTokenHash = randomUUID().replaceAll('-', '').padEnd(64, '0')
    const importData = {
      noliUserId: GTM_FIXTURE_NOLI_USER_ID,
      report_token_hash: reportTokenHash,
      likely_buyer: 'Heads of Operations at US B2B companies',
      play: {
        market_type: 'b2b',
        audience: 'Heads of Operations at growing B2B companies',
        signal: 'Hiring revenue operations leaders',
        signal_kind: 'hiring_activity',
        provider_query: { titles: ['Head of Operations'] },
        source_hint: 'Synthetic hiring fixture',
        geography: 'United States',
        recency_window: '90 days',
        why_now: 'A new revenue operations hire indicates an active process change.',
        recommended_angle: 'Offer a concise operating-system gap assessment.',
        supported_channels: ['email'],
        entity_unit: 'people',
        estimate_basis: 'modeled',
        confidence: 'high',
      },
    }

    const unauthorized = await request.post('/api/internal/gtm/import-audience-play', {
      data: importData,
    })
    expect(unauthorized.status()).toBe(401)

    const importedResponse = await postGtm(
      request,
      '/internal/gtm/import-audience-play',
      importData,
    )
    expect(importedResponse.status()).toBe(200)
    const imported = await body(importedResponse)
    expect(imported).toMatchObject({
      ok: true,
      data: {
        execution_eligibility: 'executable',
        alreadyImported: false,
      },
    })

    const replay = await body(await postGtm(
      request,
      '/internal/gtm/import-audience-play',
      importData,
    ))
    expect(replay.data).toMatchObject({
      playId: imported.data.playId,
      workspaceId: imported.data.workspaceId,
      alreadyImported: true,
    })

    const limits = { targetAccepted: 1, maxRawCandidates: 2, maxCredits: 10 }
    const planResponse = await postGtm(request, '/internal/gtm/research-runs', {
      op: 'plan',
      noliUserId: GTM_FIXTURE_NOLI_USER_ID,
      playId: imported.data.playId,
      limits,
    })
    expect(planResponse.status()).toBe(200)
    const plan = await body(planResponse)
    expect(plan.plan.adapterPlan).toEqual([
      expect.objectContaining({ adapter_id: 'fixture-source' }),
    ])
    expect(plan.plan.plan_hash).toMatch(/^[a-f0-9]{64}$/)

    const staleCreate = await postGtm(request, '/internal/gtm/research-runs', {
      op: 'create',
      noliUserId: GTM_FIXTURE_NOLI_USER_ID,
      playId: imported.data.playId,
      limits,
      expectedPlanHash: '0'.repeat(64),
    })
    expect(staleCreate.status()).toBe(409)
    expect(await body(staleCreate)).toMatchObject({ ok: false, code: 'plan_changed' })

    const createdResponse = await postGtm(request, '/internal/gtm/research-runs', {
      op: 'create',
      noliUserId: GTM_FIXTURE_NOLI_USER_ID,
      playId: imported.data.playId,
      limits,
      expectedPlanHash: plan.plan.plan_hash,
    })
    expect(createdResponse.status()).toBe(200)
    const created = await body(createdResponse)
    expect(created.run.status).toBe('priced')

    const staleExecute = await postGtm(request, '/internal/gtm/research-runs', {
      op: 'execute',
      noliUserId: GTM_FIXTURE_NOLI_USER_ID,
      runId: created.run.id,
      expectedPlanHash: 'f'.repeat(64),
    })
    expect(staleExecute.status()).toBe(409)
    expect(await body(staleExecute)).toMatchObject({ ok: false, code: 'plan_hash_mismatch' })

    const executedResponse = await postGtm(request, '/internal/gtm/research-runs', {
      op: 'execute',
      noliUserId: GTM_FIXTURE_NOLI_USER_ID,
      runId: created.run.id,
      expectedPlanHash: plan.plan.plan_hash,
    })
    expect(executedResponse.status()).toBe(200)
    const executed = await body(executedResponse)
    expect(executed.result).toMatchObject({
      status: 'completed',
      reconciliationRequired: false,
    })
    expect(executed.result.funnel.accepted).toBeGreaterThanOrEqual(1)

    const enrichmentPlanResponse = await postGtm(request, '/internal/gtm/enrich', {
      op: 'plan',
      noliUserId: GTM_FIXTURE_NOLI_USER_ID,
      runId: created.run.id,
    })
    expect(enrichmentPlanResponse.status()).toBe(200)
    const enrichmentPlan = await body(enrichmentPlanResponse)
    expect(enrichmentPlan.plan.providers.map((row: Json) => row.adapter_id)).toEqual([
      'fixture-enrich',
      'fixture-verify',
    ])

    const enrichmentResponse = await postGtm(request, '/internal/gtm/enrich', {
      op: 'run',
      noliUserId: GTM_FIXTURE_NOLI_USER_ID,
      runId: created.run.id,
      maxCredits: enrichmentPlan.plan.maximum_credits,
      expectedPlanHash: enrichmentPlan.plan.plan_hash,
    })
    expect(enrichmentResponse.status()).toBe(200)
    const enrichment = await body(enrichmentResponse)
    expect(enrichment.summary.verified).toBeGreaterThanOrEqual(1)

    const mailbox = await createSyntheticMailbox()
    mailboxId = mailbox.id
    const campaignResponse = await postGtm(request, '/internal/gtm/campaigns', {
      op: 'create',
      noliUserId: GTM_FIXTURE_NOLI_USER_ID,
      workspaceId: imported.data.workspaceId,
      playId: imported.data.playId,
      name: 'Synthetic no-send campaign',
      channelMix: { emails: 1 },
      settings: {
        daily_cap: 5,
        send_window: { start_hour: 9, end_hour: 17, timezone: 'America/Los_Angeles' },
        jitter_minutes: 0,
        mailbox_connection_id: mailbox.id,
      },
    })
    expect(campaignResponse.status()).toBe(200)
    const campaign = await body(campaignResponse)

    const postalResponse = await postGtm(request, '/internal/gtm/campaigns', {
      op: 'update-workspace-settings',
      noliUserId: GTM_FIXTURE_NOLI_USER_ID,
      workspaceId: imported.data.workspaceId,
      postal_address: '100 Synthetic Way, Test City, CA 94105',
    })
    expect(postalResponse.status()).toBe(200)

    const overviewResponse = await postGtm(request, '/internal/gtm/overview', {
      noliUserId: GTM_FIXTURE_NOLI_USER_ID,
    })
    expect(overviewResponse.status()).toBe(200)
    const overview = await body(overviewResponse)
    expect(overview.workspace).toMatchObject({
      id: imported.data.workspaceId,
      postal_address: '100 Synthetic Way, Test City, CA 94105',
      postal_address_set: true,
    })

    const draftResponse = await postGtm(request, '/internal/gtm/campaigns', {
      op: 'draft-state',
      noliUserId: GTM_FIXTURE_NOLI_USER_ID,
      campaignId: campaign.campaign.id,
    })
    expect(draftResponse.status()).toBe(200)
    const draft = await body(draftResponse)
    expect(draft.draft.recipients.length).toBeGreaterThanOrEqual(1)
    expect(draft.draft.settings).toMatchObject({
      mailbox_connection_id: mailbox.id,
      postal_address_set: true,
    })

    const staleApproval = await postGtm(request, '/internal/gtm/campaigns', {
      op: 'approve',
      noliUserId: GTM_FIXTURE_NOLI_USER_ID,
      campaignId: campaign.campaign.id,
      expected_content_hash: '0'.repeat(64),
    })
    expect(staleApproval.status()).toBe(409)
    expect(await body(staleApproval)).toMatchObject({ ok: false, code: 'stale_draft' })

    const approvalResponse = await postGtm(request, '/internal/gtm/campaigns', {
      op: 'approve',
      noliUserId: GTM_FIXTURE_NOLI_USER_ID,
      campaignId: campaign.campaign.id,
      expected_content_hash: draft.draft.content_hash,
    })
    expect(approvalResponse.status()).toBe(200)
    const approval = await body(approvalResponse)
    expect(approval.version.content_hash).toBe(draft.draft.content_hash)

    const launchResponse = await postGtm(request, '/internal/gtm/execution', {
      op: 'launch',
      noliUserId: GTM_FIXTURE_NOLI_USER_ID,
      campaignId: campaign.campaign.id,
      expectedContentHash: approval.version.content_hash,
    })
    expect(launchResponse.status()).toBe(200)
    const launched = await body(launchResponse)
    expect(launched).toMatchObject({ ok: true, status: 'active', already_launched: false })
    expect(launched.attempts).toBeGreaterThanOrEqual(1)

    const tickResponse = await postGtm(request, '/internal/gtm/execution', {
      op: 'tick',
      noliUserId: GTM_FIXTURE_NOLI_USER_ID,
      limit: 10,
    })
    expect(tickResponse.status()).toBe(200)
    expect(await body(tickResponse)).toMatchObject({
      ok: true,
      dry_run: true,
    })

    const statusResponse = await postGtm(request, '/internal/gtm/execution', {
      op: 'status',
      noliUserId: GTM_FIXTURE_NOLI_USER_ID,
      campaignId: campaign.campaign.id,
    })
    expect(statusResponse.status()).toBe(200)
    const status = await body(statusResponse)
    expect(status).toMatchObject({
      ok: true,
      status: 'active',
      attempts: { total: launched.attempts },
    })
    expect(status.attempts.by_state.approved).toBe(launched.attempts)
  })
})
