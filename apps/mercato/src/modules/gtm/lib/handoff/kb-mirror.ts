import type { GtmCampaign, GtmCampaignVersion, GtmIcpVersion } from '../../data/entities'
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
 * Knowledge mirror push (SPEC-066 section 13, Tranche 7).
 *
 * KB has NO document lock primitive; lock semantics live in the CRM
 * (gtm_icp_versions / gtm_campaign_versions are the canonical immutable
 * records). KB only receives READ-ONLY mirror notes via its agent-documents
 * API, tagged 'gtm', and every mirror document opens with an explicit
 * canonical-source notice so a reader (or an agent browsing the KB) can
 * never mistake the mirror for the record of truth.
 *
 * Auth mirrors the AMS client: a `pkb_` key minted via KB
 * /api/internal/provision-key with source 'gtm' (shared-secret bearer),
 * then Bearer-key pushes to /api/agent/documents. Injectable fetch; no
 * real calls in tests.
 */

export const DEFAULT_KB_BASE_URL = 'https://kb.noliai.com'

// Every mirror document begins with this line (test target: the notice must
// state the CRM is canonical and the doc is a read-only mirror of a locked
// version).
export const KB_MIRROR_CANONICAL_NOTICE =
  '> Canonical record: Noli CRM (GTM Engineer). This document is a read-only mirror of a locked version. Edit in the CRM; changes made here have no effect and may be overwritten.'

export function kbBaseUrl(): string {
  const configured = (process.env.KB_INTERNAL_URL ?? '').trim()
  return stripTrailingSlash(configured || DEFAULT_KB_BASE_URL)
}

export function isKbHandoffConfigured(): boolean {
  return Boolean(internalServiceSecret()) && kbBaseUrl().length > 0
}

export type KbMirrorDoc = {
  title: string
  content: string
  tags: string[]
}

export class KbMirrorClient {
  private fetchImpl: FetchLike
  private baseUrl: string
  private secret: string

  constructor(deps: { fetch: FetchLike; baseUrl: string; secret: string }) {
    this.fetchImpl = deps.fetch
    this.baseUrl = stripTrailingSlash(deps.baseUrl)
    this.secret = deps.secret
  }

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
      'KB provision-key',
    )
    return parseProvisionedKey(data, 'KB provision-key')
  }

  async pushMirror(key: string, doc: KbMirrorDoc): Promise<{ id: string | null }> {
    const data = await requestJson(
      this.fetchImpl,
      `${this.baseUrl}/api/agent/documents`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ title: doc.title, content: doc.content, tags: doc.tags }),
      },
      'KB mirror push',
    )
    const root = (data ?? {}) as Record<string, unknown>
    const nested = (root.data ?? {}) as Record<string, unknown>
    const id = typeof root.id === 'string' ? root.id : nested.id
    return { id: typeof id === 'string' ? id : null }
  }
}

export function createKbMirrorClient(deps: { fetch?: FetchLike } = {}): KbMirrorClient {
  const secret = internalServiceSecret()
  if (!secret || !isKbHandoffConfigured()) {
    throw new GtmHandoffError(
      'handoff_unconfigured',
      'KB mirror handoff is not configured (NOLI_INTERNAL_SERVICE_SECRET / KB_INTERNAL_URL)',
    )
  }
  return new KbMirrorClient({
    fetch: deps.fetch ?? defaultFetch(),
    baseUrl: kbBaseUrl(),
    secret,
  })
}

// ---------------------------------------------------------------------------
// Mirror document builders (readable markdown summaries)
// ---------------------------------------------------------------------------

function readableValue(value: unknown): string {
  if (value == null) return '(not set)'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map((item) => readableValue(item)).join(', ')
  return JSON.stringify(value)
}

function contentLines(content: Record<string, unknown>): string[] {
  return Object.keys(content)
    .sort()
    .map((key) => `- **${key.replace(/_/g, ' ')}:** ${readableValue(content[key])}`)
}

export function buildIcpMirrorDoc(icpVersion: GtmIcpVersion): KbMirrorDoc {
  const lockedAt = icpVersion.lockedAt ? icpVersion.lockedAt.toISOString() : null
  const lines = [
    KB_MIRROR_CANONICAL_NOTICE,
    '',
    `# ICP definition, version ${icpVersion.version}`,
    '',
    `Locked version ${icpVersion.version}${lockedAt ? ` (locked ${lockedAt})` : ''} of the ideal customer profile maintained by the GTM Engineer in the Noli CRM.`,
    '',
    ...contentLines((icpVersion.content ?? {}) as Record<string, unknown>),
  ]
  return {
    title: `GTM ICP v${icpVersion.version} (read-only mirror)`,
    content: lines.join('\n'),
    tags: ['gtm'],
  }
}

export function buildCampaignSummaryDoc(
  campaign: GtmCampaign,
  version: GtmCampaignVersion,
): KbMirrorDoc {
  const snapshot = (version.snapshot ?? {}) as Record<string, unknown>
  const steps = Array.isArray(snapshot.steps) ? (snapshot.steps as Record<string, unknown>[]) : []
  const recipients = Array.isArray(snapshot.recipients) ? (snapshot.recipients as unknown[]) : []
  const assetRefs = Array.isArray(snapshot.asset_refs)
    ? (snapshot.asset_refs as Record<string, unknown>[])
    : []
  const approvedAt = version.approvedAt ? version.approvedAt.toISOString() : null
  const lines = [
    KB_MIRROR_CANONICAL_NOTICE,
    '',
    `# Campaign summary: ${campaign.name}`,
    '',
    `Locked approval snapshot, version ${version.version}${approvedAt ? ` (approved ${approvedAt})` : ''}. Content hash \`${version.contentHash}\`.`,
    '',
    `- **Status:** ${campaign.status}`,
    `- **Recipients (frozen):** ${recipients.length}`,
    `- **Steps:** ${steps.length}`,
    ...steps.map((step, index) => {
      const channel = readableValue(step.channel)
      const mode = readableValue(step.mode)
      const delay = readableValue(step.delay_days)
      return `  ${index + 1}. ${channel} (${mode}), day ${delay}`
    }),
  ]
  if (assetRefs.length > 0) {
    lines.push(`- **Attached assets:** ${assetRefs.length}`)
    for (const ref of assetRefs) {
      lines.push(`  - ${readableValue(ref.title)} (${readableValue(ref.kind)})`)
    }
  }
  return {
    title: `GTM campaign: ${campaign.name} v${version.version} (read-only mirror)`,
    content: lines.join('\n'),
    tags: ['gtm'],
  }
}
