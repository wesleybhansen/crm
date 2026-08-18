import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { gtmInternalOpenApi } from '../../openapi'

export const openApi = gtmInternalOpenApi('Manage GTM campaigns and immutable approvals')
import type { EntityManager } from '@mikro-orm/postgresql'
import { gtmEnabled } from '../../../lib/flags'
import { gtmCampaignsBodySchema } from '../../../data/validators'
import { isUuid } from '../../../lib/play-shape'
import { GtmCampaignError, type CampaignEm } from '../../../lib/campaign/build'
import type { GtmCampaign } from '../../../data/entities'
import type { ApproveCampaignResult, CampaignDraftState } from '../../../lib/campaign/approve'
import type { CommandBus } from '@open-mercato/shared/lib/commands'

/*
 * Internal GTM campaigns (SPEC-066 sections 4, 5, 7, 8, 12, 14 Tranche 5).
 *
 * The Noli hub calls this server-to-server - proven by the shared
 * NOLI_INTERNAL_SERVICE_SECRET - to draft, preview, and approve outbound
 * campaigns. Identity is re-resolved at this boundary (noliUserId -> Clerk
 * -> Mercato auth context, gated on the 'crm' entitlement); the caller's
 * claims about org/tenant ownership are never trusted and every query
 * self-scopes by organization_id + tenant_id.
 *
 * Ops (body.op):
 * - 'list'            workspace-wide campaign summaries (optionally filtered
 *                     by workspaceId), org+tenant self-scoped, soft-deleted
 *                     excluded, capped at 50, newest first (lib/listing.ts)
 * - 'create'          drafts a campaign on an EXECUTABLE play (section 7
 *                     boundary 4; strategy_only plays fail closed)
 * - 'draft-state'     recipients + rendered previews + exclusions +
 *                     projected credits + the draft content_hash the
 *                     reviewer must echo back on approve
 * - 'update-template' re-renders on next draft-state; invalidates the
 *                     current approved version if any
 * - 'exclude' / 'include'  manual recipient overrides; invalidate likewise
 * - 'approve'         the immutable freeze (lib/campaign/approve.ts):
 *                     eligibility recheck, exclusion recompute, version +
 *                     steps + enrollments + frozen rendered messages in one
 *                     transaction; 'stale_draft' when expected_content_hash
 *                     no longer matches; a repeat approve with the live
 *                     version's hash returns that version idempotently
 * - 'invalidate'      explicit invalidation with a caller-supplied reason
 * - 'status'          campaign + current version summary
 * - 'update-workspace-settings'  writes the workspace's CAN-SPAM sender
 *                     postal address (lib/workspace-settings.ts); approval
 *                     requires it and send rechecks it
 *
 * Audit events are written on create (build.ts), approve, and invalidate
 * (approve.ts), always inside the owning transaction.
 *
 * Public at the dispatcher level (requireAuth: false) - we authenticate with
 * the shared secret instead of a Clerk/JWT session, mirroring
 * internal/import-audience-play.
 */
export const metadata = {
  path: '/internal/gtm/campaigns',
  POST: { requireAuth: false },
}

function opaqueNotFound() {
  return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
}

function campaignShape(campaign: GtmCampaign) {
  return {
    id: campaign.id,
    workspaceId: campaign.workspaceId,
    playId: campaign.playId,
    name: campaign.name,
    status: campaign.status,
    current_version_id: campaign.currentVersionId ?? null,
    channel_mix: campaign.channelMix ?? null,
    settings: campaign.settings ?? null,
  }
}

function draftShape(draft: CampaignDraftState) {
  return {
    content_hash: draft.contentHash,
    eligibility: draft.eligibility,
    template: draft.template,
    steps: draft.steps,
    settings: {
      daily_cap: draft.settings.daily_cap,
      send_window: draft.settings.send_window,
      jitter_minutes: draft.settings.jitter_minutes,
      mailbox_connection_id: draft.settings.mailbox_connection_id,
      sender: draft.sender,
      duplicate_override: draft.settings.duplicate_override,
      // CAN-SPAM sender address presence so the UI can prompt before approve
      postal_address: draft.postalAddress,
      postal_address_set: draft.postalAddress != null,
    },
    recipients: draft.recipients.map((recipient) => ({
      candidate_id: recipient.candidateId,
      address: recipient.address,
      contact_id: recipient.contactId,
      contact_point_id: recipient.contactPointId,
    })),
    rendered: draft.rendered.map((row) => ({
      candidate_id: row.candidateId,
      subject: row.subject,
      body_html: row.bodyHtml,
      body_text: row.bodyText,
      content_hash: row.contentHash,
      needs_review: row.needsReview,
      missing_fields: row.missingFields,
      // template merge vs AI draft (locked voice); display metadata for the
      // reviewer, both freeze identically.
      provenance: row.provenance,
    })),
    exclusions: {
      entries: draft.exclusions.entries.filter((entry) => entry.excluded),
      summary: draft.exclusions.summary,
    },
    projected_credits: draft.projectedCredits,
  }
}

function errorResponse(err: GtmCampaignError) {
  // Opaque 404 for anything the caller should not be able to distinguish
  // from a missing row; explicit codes for draft-flow errors.
  if (
    err.code === 'campaign_not_found' ||
    err.code === 'play_not_found' ||
    err.code === 'candidate_not_found' ||
    err.code === 'workspace_not_found'
  ) {
    return opaqueNotFound()
  }
  const status = err.code === 'stale_draft' ? 409 : 422
  return NextResponse.json({ ok: false, error: err.message, code: err.code }, { status })
}

export async function POST(req: Request) {
  // 0. Feature gate: the GTM Engineer ships dark; flag-off fails closed.
  if (!gtmEnabled()) {
    return opaqueNotFound()
  }

  // 1. Shared-secret auth (length-guarded constant-time compare)
  const secret = process.env.NOLI_INTERNAL_SERVICE_SECRET
  const authHeader = (req.headers.get('authorization') || '').trim()
  const expected = secret ? `Bearer ${secret}` : ''
  if (
    !secret ||
    authHeader.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))
  ) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  // 2. Body
  const raw = await req.json().catch(() => ({}))
  const parsed = gtmCampaignsBodySchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where = first?.path?.length ? `${first.path.join('.')}: ` : ''
    return NextResponse.json({ ok: false, error: `${where}${first?.message ?? 'Invalid body'}` }, { status: 400 })
  }
  const body = parsed.data

  try {
    // 3. noli-core user -> Clerk id
    const { findNoliUserById } = await import('@open-mercato/shared/lib/noli/core-client')
    const noliUser = await findNoliUserById(body.noliUserId)
    if (!noliUser?.clerk_user_id) {
      return NextResponse.json({ ok: false, error: 'Noli user not found' }, { status: 404 })
    }

    // 4. Resolve to a Mercato auth context (provisions on first contact and
    //    gates on the 'crm' entitlement - same path a Clerk session takes).
    const { resolveClerkUserToAuthContext } = await import('@open-mercato/shared/lib/auth/clerk')
    const auth = await resolveClerkUserToAuthContext(noliUser.clerk_user_id)
    if (!auth || !auth.userId || !auth.orgId || !auth.tenantId) {
      return NextResponse.json({ ok: false, error: 'User has no CRM access' }, { status: 403 })
    }
    const ctx = {
      organizationId: auth.orgId as string,
      tenantId: auth.tenantId as string,
      userId: auth.userId as string,
      requestId: req.headers.get('x-request-id') || null,
    }

    const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
    const container = await createRequestContainer()
    const { campaignFeatureForOp, hasGtmFeature } = await import('../../../lib/authorize')
    if (!(await hasGtmFeature(container, ctx, campaignFeatureForOp(body.op)))) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })
    }
    const em = container.resolve('em') as EntityManager as unknown as CampaignEm

    if (body.op === 'list') {
      // Opaque 404 for a malformed workspace filter, same as a missing row.
      if (body.workspaceId != null && !isUuid(body.workspaceId)) return opaqueNotFound()
      const { listCampaigns, GTM_LIST_CAP } = await import('../../../lib/listing')
      const campaigns = await listCampaigns(
        em as unknown as import('../../../lib/listing').ListEm,
        ctx,
        { workspaceId: body.workspaceId ?? null },
      )
      return NextResponse.json({
        ok: true,
        campaigns: campaigns.map((campaign) => ({
          id: campaign.id,
          name: campaign.name,
          status: campaign.status,
          current_version_id: campaign.currentVersionId ?? null,
          created_at: campaign.createdAt,
          play_id: campaign.playId,
        })),
        cap: GTM_LIST_CAP,
      })
    }

    if (body.op === 'create') {
      if (!isUuid(body.workspaceId) || !isUuid(body.playId)) return opaqueNotFound()
      const { createCampaign } = await import('../../../lib/campaign/build')
      const result = await createCampaign(em, ctx, {
        workspaceId: body.workspaceId,
        playId: body.playId,
        name: body.name,
        channelMix: body.channelMix ?? null,
        settings: body.settings ?? null,
      })
      return NextResponse.json({ ok: true, campaign: campaignShape(result.campaign) })
    }

    if (body.op === 'update-workspace-settings') {
      if (!isUuid(body.workspaceId)) return opaqueNotFound()
      const { updateWorkspacePostalAddress } = await import('../../../lib/workspace-settings')
      const result = await updateWorkspacePostalAddress(
        em,
        ctx,
        body.workspaceId,
        body.postal_address ?? null,
      )
      return NextResponse.json({
        ok: true,
        workspace: {
          id: result.workspace.id,
          postal_address: result.postalAddress,
          postal_address_set: result.postalAddress != null,
        },
      })
    }

    // Every other op targets an existing campaign.
    if (!isUuid(body.campaignId)) return opaqueNotFound()
    const approveLib = await import('../../../lib/campaign/approve')

    if (body.op === 'draft-state') {
      const campaign = await approveLib.loadCampaign(em, ctx, body.campaignId)
      const draft = await approveLib.computeDraftState(em, ctx, campaign)
      return NextResponse.json({
        ok: true,
        campaign: campaignShape(campaign),
        draft: draftShape(draft),
      })
    }

    if (body.op === 'update-template') {
      const result = await approveLib.updateCampaignTemplate(em, ctx, body.campaignId, {
        subject: body.template.subject,
        body: body.template.body,
      })
      return NextResponse.json({
        ok: true,
        campaign: campaignShape(result.campaign),
        invalidated: result.invalidated,
      })
    }

    if (body.op === 'exclude' || body.op === 'include') {
      if (!isUuid(body.candidateId)) return opaqueNotFound()
      const result = await approveLib.setCandidateExclusion(
        em,
        ctx,
        body.campaignId,
        body.candidateId,
        body.op === 'exclude',
      )
      return NextResponse.json({
        ok: true,
        campaign: campaignShape(result.campaign),
        invalidated: result.invalidated,
      })
    }

    if (body.op === 'approve') {
      const commandBus = container.resolve('commandBus') as CommandBus
      const executed = await commandBus.execute<
        { campaignId: string; expectedContentHash: string },
        ApproveCampaignResult
      >('gtm.campaigns.approve', {
        input: {
          campaignId: body.campaignId,
          expectedContentHash: body.expected_content_hash,
        },
        ctx: {
          container,
          auth,
          organizationScope: null,
          selectedOrganizationId: ctx.organizationId,
          organizationIds: [ctx.organizationId],
          request: req,
        },
      })
      const result = executed.result
      return NextResponse.json({
        ok: true,
        campaign: campaignShape(result.campaign),
        alreadyApproved: result.alreadyApproved,
        version: {
          id: result.version.id,
          version: result.version.version,
          content_hash: result.version.contentHash,
          approved_at: result.version.approvedAt ?? null,
          approved_by_user_id: result.version.approvedByUserId ?? null,
        },
      })
    }

    if (body.op === 'regenerate-message') {
      if (!isUuid(body.candidateId)) return opaqueNotFound()
      // AI drafting is opt-in and gated on a LOCKED voice profile. Resolve the
      // model + metering through the existing CRM AI usage path; the library
      // returns an honest template fallback when no locked voice exists or the
      // model call/parse fails (never a hard failure).
      const { checkCustomersAiAllowance } = await import('@/lib/usage/allowance')
      const { meterCustomersAi } = await import('@/lib/usage/meter')
      const gate = await checkCustomersAiAllowance({ orgId: ctx.organizationId })
      if (!gate.allowed) {
        return NextResponse.json({ ok: false, error: gate.message, code: 'ai_allowance' }, { status: 402 })
      }
      const apiKey = gate.byoApiKey || process.env.GOOGLE_GENERATIVE_AI_API_KEY
      if (!apiKey) {
        return NextResponse.json({ ok: false, error: 'AI is not configured', code: 'ai_unconfigured' }, { status: 400 })
      }
      const { createGeminiDraftModel } = await import('../../../lib/ai/model')
      const { regenerateMessageForCandidate } = await import('../../../lib/campaign/ai-draft')
      const model = createGeminiDraftModel(apiKey)
      const canonicalMeter = async (usage: {
        model: string
        tokensIn: number
        tokensOut: number
        tokenUsageKnown?: boolean
        feature: string
        status?: 'succeeded' | 'failed'
        failureCode?: string | null
        retryCount?: number
      }) => {
        await meterCustomersAi({ orgId: ctx.organizationId }, {
          model: usage.model,
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
          feature: usage.feature,
          byoKey: !!gate.byoApiKey,
          idempotencyKey: body.idempotency_key
            ? `gtm:campaign-draft:${ctx.organizationId}:${body.campaignId}:${body.candidateId}:${body.idempotency_key}`
            : null,
          metadata: {
            status: usage.status === 'failed' ? 'failed' : 'completed',
            attempt: 1,
            token_usage_known: usage.tokenUsageKnown !== false,
            failure_code: usage.failureCode ?? null,
            retry_count: usage.retryCount ?? 0,
          },
        })
      }
      const { createGtmTelemetryMeter } = await import('../../../lib/ai/telemetry')
      const meter = createGtmTelemetryMeter({
        em,
        ctx,
        surface: 'campaign_message_draft',
        operationKey: body.idempotency_key
          ? `gtm:campaign-draft:${ctx.organizationId}:${body.campaignId}:${body.candidateId}:${body.idempotency_key}`
          : `gtm:campaign-draft:${ctx.organizationId}:${body.campaignId}:${body.candidateId}:${crypto.randomUUID()}`,
        canonicalMeter,
      })
      const result = await regenerateMessageForCandidate(em, ctx, { model, meter }, {
        campaignId: body.campaignId,
        candidateId: body.candidateId,
        idempotencyKey: body.idempotency_key ?? null,
      })
      return NextResponse.json({
        ok: true,
        provenance: result.provenance,
        invalidated: result.invalidated,
        reason: result.provenance === 'template' ? result.reason : null,
        draft: result.provenance === 'ai' ? result.draft : null,
      })
    }

    if (body.op === 'invalidate') {
      const result = await approveLib.invalidateCurrentVersion(
        em,
        ctx,
        body.campaignId,
        body.reason,
      )
      return NextResponse.json({
        ok: true,
        campaign: campaignShape(result.campaign),
        invalidated: result.invalidated,
        version: result.version
          ? {
              id: result.version.id,
              version: result.version.version,
              invalidated_at: result.version.invalidatedAt ?? null,
              invalidated_reason: result.version.invalidatedReason ?? null,
            }
          : null,
      })
    }

    // status
    const campaign = await approveLib.loadCampaign(em, ctx, body.campaignId)
    const entities = await import('../../../data/entities')
    const version = campaign.currentVersionId
      ? await em.findOne(entities.GtmCampaignVersion, {
          id: campaign.currentVersionId,
          organizationId: ctx.organizationId,
          tenantId: ctx.tenantId,
        })
      : null
    return NextResponse.json({
      ok: true,
      campaign: campaignShape(campaign),
      version: version
        ? {
            id: version.id,
            version: version.version,
            content_hash: version.contentHash,
            approved_at: version.approvedAt ?? null,
            approved_by_user_id: version.approvedByUserId ?? null,
            invalidated_at: version.invalidatedAt ?? null,
            invalidated_reason: version.invalidatedReason ?? null,
          }
        : null,
    })
  } catch (err) {
    if (err instanceof GtmCampaignError) {
      return errorResponse(err)
    }
    console.error('[internal.gtm.campaigns]', err)
    return NextResponse.json({ ok: false, error: 'Campaign operation failed' }, { status: 500 })
  }
}
