import { NextResponse } from 'next/server'
import { internalServiceBearerAuthorized } from '../../../lib/authorize'
import { gtmInternalOpenApi } from '../../openapi'

export const openApi = gtmInternalOpenApi('Coordinate bounded GTM asset and KB handoffs')
import type { EntityManager } from '@mikro-orm/postgresql'
import { gtmEnabled } from '../../../lib/flags'
import { gtmHandoffBodySchema } from '../../../data/validators'
import { isUuid } from '../../../lib/play-shape'
import type { ExecutionEm } from '../../../lib/execute/schedule'
import { GtmCampaignError } from '../../../lib/campaign/build'

/*
 * Internal GTM cross-app handoff (SPEC-066 section 13, Tranche 7; AMS
 * contract in blog-ops docs/gtm-asset-handoff-contract-2026-07-23.md).
 *
 * Ops (body.op):
 * - 'assets-list'        list attachable published AMS artifacts
 * - 'asset-request'      request creation of a new AMS asset (brief only,
 *                        never prospect PII)
 * - 'asset-status'       poll an AMS asset request
 * - 'attach-asset'       store an asset REFERENCE on the campaign draft
 *                        (frozen into the approval snapshot)
 * - 'kb-mirror-icp'      push a read-only mirror of a LOCKED ICP version to
 *                        the KB (canonical record stays in the CRM)
 * - 'kb-mirror-campaign' push a read-only summary of the current approved
 *                        campaign version to the KB
 *
 * Fail closed and honest: AMS/KB ops return 503 handoff_unconfigured when
 * the respective base/secret is unset; upstream failures surface as 502
 * handoff_upstream_failed, never as fake success.
 *
 * Auth/identity mirrors internal/campaigns: shared-secret bearer, noliUserId
 * re-resolved server-side, every query self-scoped by org + tenant.
 */
export const metadata = {
  path: '/internal/gtm/handoff',
  POST: { requireAuth: false },
}

function opaqueNotFound() {
  return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
}

function unconfigured() {
  return NextResponse.json({ ok: false, error: 'handoff_unconfigured' }, { status: 503 })
}

export async function POST(req: Request) {
  if (!gtmEnabled()) {
    return opaqueNotFound()
  }

  // Byte-length guarded constant-time compare (lib/authorize.ts).
  if (!internalServiceBearerAuthorized(req)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const raw = await req.json().catch(() => ({}))
  const parsed = gtmHandoffBodySchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where = first?.path?.length ? `${first.path.join('.')}: ` : ''
    return NextResponse.json(
      { ok: false, error: `${where}${first?.message ?? 'Invalid body'}` },
      { status: 400 },
    )
  }
  const body = parsed.data

  try {
    const { findNoliUserById } = await import('@open-mercato/shared/lib/noli/core-client')
    const noliUser = await findNoliUserById(body.noliUserId)
    if (!noliUser?.clerk_user_id) {
      return NextResponse.json({ ok: false, error: 'Noli user not found' }, { status: 404 })
    }
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
    const { handoffFeatureForOp, hasGtmFeature } = await import('../../../lib/authorize')
    if (!(await hasGtmFeature(container, ctx, handoffFeatureForOp(body.op)))) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })
    }
    const em = container.resolve('em') as EntityManager as unknown as ExecutionEm
    const entities = await import('../../../data/entities')
    const httpLib = await import('../../../lib/handoff/http')
    const amsLib = await import('../../../lib/handoff/ams-assets')

    const audit = async (action: string, objectType: string, objectId: string | null, metadata: Record<string, unknown>) => {
      await em.transactional(async (tem) => {
        tem.persist(
          tem.create(entities.GtmAuditEvent, {
            organizationId: ctx.organizationId,
            tenantId: ctx.tenantId,
            actor: 'user_id',
            actorUserId: ctx.userId,
            action,
            objectType,
            objectId,
            requestId: ctx.requestId ?? null,
            metadata,
          }),
        )
        await tem.flush()
      })
    }

    try {
      if (body.op === 'assets-list') {
        if (!amsLib.isAmsHandoffConfigured()) return unconfigured()
        const client = amsLib.createAmsAssetClient()
        const key = await client.mintKey(body.noliUserId)
        const assets = await client.listAssets(key)
        return NextResponse.json({ ok: true, assets })
      }

      if (body.op === 'asset-request') {
        if (!amsLib.isAmsHandoffConfigured()) return unconfigured()
        const client = amsLib.createAmsAssetClient()
        const key = await client.mintKey(body.noliUserId)
        const result = await client.requestAsset(key, {
          kind: body.kind,
          brief: body.brief,
          platform: body.platform ?? null,
          play_context: body.play_context,
        })
        await audit('gtm.handoff.asset_requested', 'gtm_campaign', null, {
          kind: body.kind,
          platform: body.platform ?? null,
          request_id: result.request_id,
        })
        return NextResponse.json({
          ok: true,
          request_id: result.request_id,
          job_id: result.job_id,
        })
      }

      if (body.op === 'asset-status') {
        if (!amsLib.isAmsHandoffConfigured()) return unconfigured()
        const client = amsLib.createAmsAssetClient()
        const key = await client.mintKey(body.noliUserId)
        const status = await client.getRequestStatus(key, body.requestId)
        return NextResponse.json({ ok: true, ...status })
      }

      if (body.op === 'attach-asset') {
        if (!isUuid(body.campaignId)) return opaqueNotFound()
        let assetRef = body.assetRef
        // When AMS is reachable the reference is resolved through it: the id
        // must exist in the org's attachable assets and the frozen URL comes
        // from AMS, not from the caller. The validator already limits the
        // caller-supplied URLs to https; this closes the "attach an id AMS
        // never issued" path. Without AMS configured the validated body is
        // the only source and is used as-is.
        if (amsLib.isAmsHandoffConfigured()) {
          const client = amsLib.createAmsAssetClient()
          const key = await client.mintKey(body.noliUserId)
          const assets = await client.listAssets(key)
          const resolved = assets.find((asset) => asset.id === body.assetRef.id)
          if (!resolved) {
            return NextResponse.json(
              { ok: false, error: 'Asset is not attachable from AMS', code: 'asset_not_found' },
              { status: 422 },
            )
          }
          const resolvedUrl = resolved.publishedUrl ?? null
          if (resolvedUrl && !/^https:\/\//i.test(resolvedUrl)) {
            return NextResponse.json(
              { ok: false, error: 'AMS returned a non-https asset URL', code: 'asset_url_invalid' },
              { status: 422 },
            )
          }
          assetRef = {
            ...body.assetRef,
            kind: resolved.kind || body.assetRef.kind,
            title: resolved.title || body.assetRef.title,
            publishedUrl: resolvedUrl ?? body.assetRef.publishedUrl,
            frozen_url: resolvedUrl ?? body.assetRef.frozen_url ?? body.assetRef.publishedUrl,
          }
        }
        const result = await amsLib.attachAssetRef(em, ctx, {
          campaignId: body.campaignId,
          assetRef,
        })
        return NextResponse.json({
          ok: true,
          campaign_id: result.campaignId,
          asset_refs: result.assetRefs,
          invalidated_current_version: result.invalidated,
        })
      }

      const kbLib = await import('../../../lib/handoff/kb-mirror')

      if (body.op === 'kb-mirror-icp') {
        if (!kbLib.isKbHandoffConfigured()) return unconfigured()
        if (!isUuid(body.workspaceId) || !isUuid(body.icpVersionId)) return opaqueNotFound()
        const icpVersion = await em.findOne(entities.GtmIcpVersion, {
          id: body.icpVersionId,
          organizationId: ctx.organizationId,
          tenantId: ctx.tenantId,
          workspaceId: body.workspaceId,
          deletedAt: null,
        })
        if (!icpVersion) return opaqueNotFound()
        if (!icpVersion.locked) {
          return NextResponse.json(
            { ok: false, error: 'Only a locked ICP version can be mirrored', code: 'not_locked' },
            { status: 422 },
          )
        }
        const doc = kbLib.buildIcpMirrorDoc(icpVersion)
        const client = kbLib.createKbMirrorClient()
        const key = await client.mintKey(body.noliUserId)
        const pushed = await client.pushMirror(key, doc)
        await audit('gtm.handoff.kb_mirror_pushed', 'gtm_icp_version', icpVersion.id, {
          kind: 'icp',
          version: icpVersion.version,
          kb_document_id: pushed.id,
        })
        return NextResponse.json({ ok: true, title: doc.title, kb_document_id: pushed.id })
      }

      // kb-mirror-campaign
      if (!kbLib.isKbHandoffConfigured()) return unconfigured()
      if (!isUuid(body.campaignId)) return opaqueNotFound()
      const campaign = await em.findOne(entities.GtmCampaign, {
        id: body.campaignId,
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        deletedAt: null,
      })
      if (!campaign) return opaqueNotFound()
      if (!campaign.currentVersionId) {
        return NextResponse.json(
          {
            ok: false,
            error: 'Only an approved campaign version can be mirrored',
            code: 'not_approved',
          },
          { status: 422 },
        )
      }
      const version = await em.findOne(entities.GtmCampaignVersion, {
        id: campaign.currentVersionId,
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
      })
      if (!version) return opaqueNotFound()
      const doc = kbLib.buildCampaignSummaryDoc(campaign, version)
      const client = kbLib.createKbMirrorClient()
      const key = await client.mintKey(body.noliUserId)
      const pushed = await client.pushMirror(key, doc)
      await audit('gtm.handoff.kb_mirror_pushed', 'gtm_campaign_version', version.id, {
        kind: 'campaign_summary',
        campaign_id: campaign.id,
        version: version.version,
        kb_document_id: pushed.id,
      })
      return NextResponse.json({ ok: true, title: doc.title, kb_document_id: pushed.id })
    } catch (err) {
      if (err instanceof httpLib.GtmHandoffError) {
        if (err.code === 'handoff_unconfigured') return unconfigured()
        return NextResponse.json(
          { ok: false, error: 'handoff_upstream_failed', detail: err.message, code: err.code },
          { status: 502 },
        )
      }
      throw err
    }
  } catch (err) {
    if (err instanceof GtmCampaignError) {
      if (err.code === 'campaign_not_found') return opaqueNotFound()
      return NextResponse.json({ ok: false, error: err.message, code: err.code }, { status: 422 })
    }
    console.error('[internal.gtm.handoff]', err)
    return NextResponse.json({ ok: false, error: 'Handoff operation failed' }, { status: 500 })
  }
}
