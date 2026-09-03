import crypto from 'crypto'
import type { CampaignEm, GtmCtx } from './build'
import {
  GtmCampaign,
  GtmCandidate,
  GtmCandidateMatch,
  GtmContactPoint,
  GtmEnrollment,
  GtmPlay,
  GtmSuppression,
} from '../../data/entities'
import { EmailUnsubscribe } from '../../../email/data/schema'

/*
 * Campaign exclusion computation (SPEC-066 section 8, Tranche 5).
 *
 * For every candidate the campaign wants to reach, decide whether the
 * candidate is excluded and why, based on the candidate's VERIFIED email
 * contact point (a candidate without one is excluded outright: there is
 * nothing safe to send to). Three suppression sources are consulted, in
 * precedence order:
 *
 *   1. gtm_suppressions: org-scoped rows plus scope='global' rows, matching
 *      channel (exact or 'all') and the sha256 of the lowercased address,
 *      skipping expired rows. The row's own reason is surfaced.
 *   2. legacy email_unsubscribes: ONE-WAY import semantics. Rows are read by
 *      org + email and matches surface as suppression annotations with
 *      reason 'unsubscribe', source 'legacy'. This module never writes
 *      email_unsubscribes (or anything else: computeExclusions is pure
 *      read + compute).
 *   3. duplicate-across-campaigns: an address actively enrolled in another
 *      live campaign of the org is excluded with reason 'duplicate' unless
 *      the campaign explicitly overrides (settings.duplicate_override).
 *
 * Before any of those, consumer records are excluded outright (reason
 * 'consumer_manual_only', review L15): a candidate whose provenance says it
 * was consumer-sourced, or that was matched under a play with lead_mode
 * 'consumer' / outreach_mode 'manual_only', can never become an automated
 * email recipient, even if a play's market_type is later edited. This is
 * candidate-level defence in depth behind the play-level eligibility gate.
 *
 * Enforcement points per section 8: build (draft-state renders the excluded
 * list), approval (approve.ts recomputes through this same function so a
 * suppression added between render and approve drops the recipient), and
 * claim time (Tranche 6).
 */

export function hashAddress(address: string): string {
  return crypto.createHash('sha256').update(address.trim().toLowerCase()).digest('hex')
}

// Campaign statuses whose active enrollments block re-enrollment elsewhere.
const LIVE_CAMPAIGN_STATUSES = ['approved', 'launching', 'active', 'paused']

export type ExclusionReason =
  | 'no_verified_contact_point'
  | 'unsubscribe'
  | 'hard_bounce'
  | 'complaint'
  | 'manual'
  | 'duplicate'
  | 'legal'
  // Public prospect-removal request (privacy policy 3.8). Always written at
  // scope 'global', so it excludes the address in every org.
  | 'removal_request'
  // Consumer-sourced record: manual outreach only, never automated email.
  | 'consumer_manual_only'

export type ExclusionEntry = {
  candidateId: string
  excluded: boolean
  reason: ExclusionReason | null
  // 'gtm_suppression' | 'legacy' | 'duplicate' | 'consumer_policy' | null
  source: string | null
  address: string | null
  addressHash: string | null
  contactPointId: string | null
}

export type ExclusionSummary = {
  total: number
  excluded: number
  byReason: Record<string, number>
}

export type ComputeExclusionsInput = {
  workspaceId: string
  candidateIds: string[]
  channel: 'email' | 'linkedin' | 'x'
  // the campaign being built; its own enrollments never count as duplicates
  excludeCampaignId?: string | null
  // explicit duplicate-protection override (SPEC-066 section 8)
  allowDuplicates?: boolean
}

export type ComputeExclusionsResult = {
  entries: ExclusionEntry[]
  byCandidate: Map<string, ExclusionEntry>
  summary: ExclusionSummary
}

export async function computeExclusions(
  em: CampaignEm,
  ctx: GtmCtx,
  input: ComputeExclusionsInput,
): Promise<ComputeExclusionsResult> {
  const now = new Date()
  const { candidateIds } = input

  // 0. Consumer records (review L15): candidate provenance or a consumer /
  //    manual-only play behind any of the candidate's matches.
  const consumerCandidateIds = await consumerCandidateIdsFor(em, ctx, candidateIds)

  // Verified contact point per candidate for the requested channel.
  const points = candidateIds.length
    ? await em.find(GtmContactPoint, {
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        candidateId: { $in: candidateIds },
        channel: input.channel,
        verificationState: 'verified',
        deletedAt: null,
      })
    : []
  const pointByCandidate = new Map<string, GtmContactPoint>()
  for (const point of [...points].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (!pointByCandidate.has(point.candidateId)) {
      pointByCandidate.set(point.candidateId, point)
    }
  }
  const addressByCandidate = new Map(
    [...pointByCandidate].map(([candidateId, point]) => [candidateId, point.value.trim().toLowerCase()]),
  )

  // 1. gtm_suppressions: org rows plus global-scope rows.
  const orgSuppressions = await em.find(GtmSuppression, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  const globalSuppressions = await em.find(GtmSuppression, {
    scope: 'global',
    deletedAt: null,
  })
  const suppressionByHash = new Map<string, GtmSuppression>()
  for (const row of [...orgSuppressions, ...globalSuppressions]) {
    if (row.channel !== input.channel && row.channel !== 'all') continue
    if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) continue
    if (!suppressionByHash.has(row.addressHash)) suppressionByHash.set(row.addressHash, row)
  }

  // 2. Legacy email_unsubscribes, read-only, org + email match (email only).
  const legacyUnsubscribed = new Set<string>()
  if (input.channel === 'email' && addressByCandidate.size > 0) {
    const legacyRows = await em.find(EmailUnsubscribe, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
    })
    for (const row of legacyRows) {
      legacyUnsubscribed.add(row.email.trim().toLowerCase())
    }
  }

  // 3. Duplicate-across-campaigns: address hashes actively enrolled in other
  //    live campaigns of the org.
  const duplicateHashes = new Set<string>()
  if (!input.allowDuplicates) {
    const liveCampaigns = (
      await em.find(GtmCampaign, {
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        status: { $in: LIVE_CAMPAIGN_STATUSES },
        deletedAt: null,
      })
    ).filter((campaign) => campaign.id !== (input.excludeCampaignId ?? null))
    const liveCampaignIds = liveCampaigns.map((campaign) => campaign.id)
    if (liveCampaignIds.length > 0) {
      const enrollments = await em.find(GtmEnrollment, {
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        campaignId: { $in: liveCampaignIds },
        status: 'active',
        deletedAt: null,
      })
      const enrolledCandidateIds = [...new Set(enrollments.map((row) => row.candidateId))]
      if (enrolledCandidateIds.length > 0) {
        const enrolledPoints = await em.find(GtmContactPoint, {
          organizationId: ctx.organizationId,
          tenantId: ctx.tenantId,
          candidateId: { $in: enrolledCandidateIds },
          channel: input.channel,
          verificationState: 'verified',
          deletedAt: null,
        })
        for (const point of enrolledPoints) {
          duplicateHashes.add(hashAddress(point.value))
        }
      }
    }
  }

  const entries: ExclusionEntry[] = candidateIds.map((candidateId) => {
    const address = addressByCandidate.get(candidateId) ?? null
    if (consumerCandidateIds.has(candidateId)) {
      return {
        candidateId,
        excluded: true,
        reason: 'consumer_manual_only' as const,
        source: 'consumer_policy',
        address,
        addressHash: address ? hashAddress(address) : null,
        contactPointId: pointByCandidate.get(candidateId)?.id ?? null,
      }
    }
    if (!address) {
      return {
        candidateId,
        excluded: true,
        reason: 'no_verified_contact_point' as const,
        source: null,
        address: null,
        addressHash: null,
        contactPointId: null,
      }
    }
    const addressHash = hashAddress(address)
    const suppression = suppressionByHash.get(addressHash)
    if (suppression) {
      return {
        candidateId,
        excluded: true,
        reason: suppression.reason as ExclusionReason,
        source: 'gtm_suppression',
        address,
        addressHash,
        contactPointId: pointByCandidate.get(candidateId)?.id ?? null,
      }
    }
    if (legacyUnsubscribed.has(address)) {
      return {
        candidateId,
        excluded: true,
        reason: 'unsubscribe' as const,
        source: 'legacy',
        address,
        addressHash,
        contactPointId: pointByCandidate.get(candidateId)?.id ?? null,
      }
    }
    if (duplicateHashes.has(addressHash)) {
      return {
        candidateId,
        excluded: true,
        reason: 'duplicate' as const,
        source: 'duplicate',
        address,
        addressHash,
        contactPointId: pointByCandidate.get(candidateId)?.id ?? null,
      }
    }
    return {
      candidateId,
      excluded: false,
      reason: null,
      source: null,
      address,
      addressHash,
      contactPointId: pointByCandidate.get(candidateId)?.id ?? null,
    }
  })

  const byCandidate = new Map(entries.map((entry) => [entry.candidateId, entry]))
  const byReason: Record<string, number> = {}
  let excluded = 0
  for (const entry of entries) {
    if (!entry.excluded) continue
    excluded += 1
    byReason[entry.reason as string] = (byReason[entry.reason as string] ?? 0) + 1
  }

  return {
    entries,
    byCandidate,
    summary: { total: entries.length, excluded, byReason },
  }
}

function readSourceKind(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const direct = record.source_kind
  if (typeof direct === 'string') return direct
  const nested = record.provenance
  if (nested && typeof nested === 'object') {
    const kind = (nested as Record<string, unknown>).source_kind
    if (typeof kind === 'string') return kind
  }
  return null
}

function candidateIsConsumerSourced(candidate: GtmCandidate): boolean {
  return readSourceKind(candidate.identity) === 'consumer'
}

function playIsConsumer(play: GtmPlay): boolean {
  return play.leadMode === 'consumer' || play.outreachMode === 'manual_only'
}

// Candidate ids that must never receive automated email: consumer-sourced by
// provenance, or matched under a consumer / manual-only play.
async function consumerCandidateIdsFor(
  em: CampaignEm,
  ctx: GtmCtx,
  candidateIds: string[],
): Promise<Set<string>> {
  const out = new Set<string>()
  if (candidateIds.length === 0) return out
  const candidates = await em.find(GtmCandidate, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    id: { $in: candidateIds },
  })
  for (const candidate of candidates) {
    if (candidateIsConsumerSourced(candidate)) out.add(candidate.id)
  }
  const matches = await em.find(GtmCandidateMatch, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    candidateId: { $in: candidateIds },
    deletedAt: null,
  })
  const playIds = [...new Set(matches.map((match) => match.playId))]
  if (playIds.length === 0) return out
  const plays = await em.find(GtmPlay, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    id: { $in: playIds },
  })
  const consumerPlayIds = new Set(plays.filter(playIsConsumer).map((play) => play.id))
  for (const match of matches) {
    if (consumerPlayIds.has(match.playId)) out.add(match.candidateId)
  }
  return out
}
