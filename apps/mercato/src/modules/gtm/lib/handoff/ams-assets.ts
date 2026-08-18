import type { CampaignEm, GtmCtx, AssetRef } from '../campaign/build'
import { parseAssetRefs } from '../campaign/build'
import { invalidateCurrentVersion, loadCampaign } from '../campaign/approve'
import { GtmAuditEvent } from '../../data/entities'
import {
  GtmHandoffError,
  defaultFetch,
  internalServiceSecret,
  parseProvisionedKey,
  requestJson,
  stripTrailingSlash,
  type FetchLike,
} from './http'

/*
 * AMS asset handoff client (Tranche 7; frozen contract in blog-ops
 * docs/gtm-asset-handoff-contract-2026-07-23.md, pointer SPEC-066
 * section 13).
 *
 * Direction: the CRM calls AMS, never the reverse. Auth: an org-scoped
 * `los_` key minted idempotently via AMS /api/internal/provision-key with
 * source 'gtm' (shared-secret bearer), then Bearer-key calls against the
 * /api/ext/assets... routes. AMS re-resolves the org from the key; the CRM
 * never sends org identifiers.
 *
 * GTM stores REFERENCES only (contract item 4): attachAssetRef writes
 * channel_mix.asset_refs on the campaign draft, and approval freezes the
 * refs (with the resolved frozen_url) into the immutable version snapshot.
 * Requests carry no prospect PII (contract item 6): only the brief and play
 * context ever leave the CRM.
 */

export const DEFAULT_AMS_BASE_URL = 'https://ams.noliai.com'

export function amsBaseUrl(): string {
  const configured = (process.env.AMS_INTERNAL_URL ?? '').trim()
  return stripTrailingSlash(configured || DEFAULT_AMS_BASE_URL)
}

// Fail closed and honest: without the shared secret (or an explicitly
// emptied base URL) the handoff surface reports itself unconfigured instead
// of attempting a call that cannot authenticate.
export function isAmsHandoffConfigured(): boolean {
  return Boolean(internalServiceSecret()) && amsBaseUrl().length > 0
}

export type AmsAssetSummary = {
  id: string
  kind: string
  title: string
  publishedUrl: string | null
  status: string | null
  updatedAt: string | null
}

export type AmsAssetRequestInput = {
  kind: string
  brief: string
  platform?: string | null
  play_context: Record<string, unknown>
}

export type AmsAssetRequestResult = {
  request_id: string
  job_id: string | null
}

export type AmsAssetRequestStatus = {
  request_id: string
  status: string
  asset: Record<string, unknown> | null
}

function unwrapList(data: unknown): unknown[] {
  if (Array.isArray(data)) return data
  const root = (data ?? {}) as Record<string, unknown>
  if (Array.isArray(root.assets)) return root.assets
  if (Array.isArray(root.data)) return root.data
  return []
}

function unwrapObject(data: unknown): Record<string, unknown> {
  const root = (data ?? {}) as Record<string, unknown>
  if (root.data && typeof root.data === 'object' && !Array.isArray(root.data)) {
    return root.data as Record<string, unknown>
  }
  return root
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export class AmsAssetClient {
  private fetchImpl: FetchLike
  private baseUrl: string
  private secret: string

  constructor(deps: { fetch: FetchLike; baseUrl: string; secret: string }) {
    this.fetchImpl = deps.fetch
    this.baseUrl = stripTrailingSlash(deps.baseUrl)
    this.secret = deps.secret
  }

  // Idempotent per (org, source:'gtm') on the AMS side, mirroring the COS
  // mint flow (contract item 2).
  async mintKey(noliUserId: string): Promise<string> {
    const data = await requestJson(
      this.fetchImpl,
      `${this.baseUrl}/api/internal/provision-key`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.secret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ noliUserId, source: 'gtm' }),
      },
      'AMS provision-key',
    )
    return parseProvisionedKey(data, 'AMS provision-key')
  }

  // GET /api/ext/assets: attachable published artifacts (contract item 3).
  async listAssets(key: string): Promise<AmsAssetSummary[]> {
    const data = await requestJson(
      this.fetchImpl,
      `${this.baseUrl}/api/ext/assets`,
      { method: 'GET', headers: { authorization: `Bearer ${key}` } },
      'AMS assets list',
    )
    const out: AmsAssetSummary[] = []
    for (const entry of unwrapList(data)) {
      const record = (entry ?? {}) as Record<string, unknown>
      const id = asString(record.id)
      if (!id) continue
      out.push({
        id,
        kind: asString(record.kind) ?? 'unknown',
        title: asString(record.title) ?? '',
        publishedUrl: asString(record.publishedUrl),
        status: asString(record.status),
        updatedAt: asString(record.updatedAt),
      })
    }
    return out
  }

  // POST /api/ext/assets/requests: request creation of a new asset.
  async requestAsset(key: string, input: AmsAssetRequestInput): Promise<AmsAssetRequestResult> {
    const data = await requestJson(
      this.fetchImpl,
      `${this.baseUrl}/api/ext/assets/requests`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          kind: input.kind,
          brief: input.brief,
          ...(input.platform ? { platform: input.platform } : {}),
          play_context: input.play_context,
        }),
      },
      'AMS asset request',
    )
    const record = unwrapObject(data)
    const requestId = asString(record.request_id)
    if (!requestId) {
      throw new GtmHandoffError('bad_response', 'AMS asset request response carried no request_id')
    }
    return { request_id: requestId, job_id: asString(record.job_id) }
  }

  // GET /api/ext/assets/requests/[id]: status poll.
  async getRequestStatus(key: string, requestId: string): Promise<AmsAssetRequestStatus> {
    const data = await requestJson(
      this.fetchImpl,
      `${this.baseUrl}/api/ext/assets/requests/${encodeURIComponent(requestId)}`,
      { method: 'GET', headers: { authorization: `Bearer ${key}` } },
      'AMS asset status',
    )
    const record = unwrapObject(data)
    return {
      request_id: asString(record.request_id) ?? requestId,
      status: asString(record.status) ?? 'PENDING',
      asset:
        record.asset && typeof record.asset === 'object'
          ? (record.asset as Record<string, unknown>)
          : null,
    }
  }
}

export function createAmsAssetClient(deps: { fetch?: FetchLike } = {}): AmsAssetClient {
  const secret = internalServiceSecret()
  if (!secret || !isAmsHandoffConfigured()) {
    throw new GtmHandoffError(
      'handoff_unconfigured',
      'AMS asset handoff is not configured (NOLI_INTERNAL_SERVICE_SECRET / AMS_INTERNAL_URL)',
    )
  }
  return new AmsAssetClient({
    fetch: deps.fetch ?? defaultFetch(),
    baseUrl: amsBaseUrl(),
    secret,
  })
}

// ---------------------------------------------------------------------------
// Attaching an asset reference to a campaign draft
// ---------------------------------------------------------------------------

export type AttachAssetInput = {
  campaignId: string
  assetRef: {
    id: string
    kind: string
    title: string
    publishedUrl: string
    frozen_url?: string | null
  }
}

export type AttachAssetResult = {
  campaignId: string
  assetRefs: AssetRef[]
  invalidated: boolean
}

// Stores the reference in channel_mix.asset_refs. Attaching to an approved
// campaign invalidates the current version first (any draft-mutating
// operation does, lib/campaign/approve.ts); the next approval freezes the
// refs, including frozen_url resolved at attach time, into the immutable
// snapshot.
export async function attachAssetRef(
  em: CampaignEm,
  ctx: GtmCtx,
  input: AttachAssetInput,
): Promise<AttachAssetResult> {
  let campaign = await loadCampaign(em, ctx, input.campaignId)
  let invalidated = false
  if (campaign.currentVersionId) {
    const result = await invalidateCurrentVersion(em, ctx, campaign.id, 'asset_attached')
    campaign = result.campaign
    invalidated = result.invalidated
  }

  const ref: AssetRef = {
    id: input.assetRef.id,
    kind: input.assetRef.kind,
    title: input.assetRef.title,
    publishedUrl: input.assetRef.publishedUrl,
    // The URL freezes at attach time; the approval snapshot preserves it
    // even if AMS later unpublishes the asset (contract item 4).
    frozen_url: input.assetRef.frozen_url ?? input.assetRef.publishedUrl,
  }

  await em.transactional(async (tem) => {
    const mixRaw = (campaign.channelMix ?? {}) as Record<string, unknown>
    const existing = parseAssetRefs(campaign).filter((row) => row.id !== ref.id)
    campaign.channelMix = {
      ...mixRaw,
      asset_refs: [...existing, ref].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    }
    tem.persist(campaign)
    tem.persist(
      tem.create(GtmAuditEvent, {
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        actor: 'user_id',
        actorUserId: ctx.userId,
        action: 'gtm.handoff.asset_attached',
        objectType: 'gtm_campaign',
        objectId: campaign.id,
        requestId: ctx.requestId ?? null,
        metadata: {
          asset_id: ref.id,
          kind: ref.kind,
          frozen_url: ref.frozen_url,
          invalidated_current_version: invalidated,
        },
      }),
    )
    await tem.flush()
  })

  return { campaignId: campaign.id, assetRefs: parseAssetRefs(campaign), invalidated }
}
