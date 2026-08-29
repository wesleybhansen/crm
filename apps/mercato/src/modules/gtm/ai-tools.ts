/**
 * Safe GTM Engineer MCP surface (SPEC-069 section 7.3).
 *
 * These tools expose scoped workspace/play discovery and the human review
 * boundary. They deliberately do not plan or execute paid research, enrich,
 * export, create campaigns, send, post, or otherwise bypass quote/approval
 * controls. The module loader registers this file under moduleId `gtm`.
 */
import { z } from 'zod'
import type { AwilixContainer } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import { GtmCandidate, GtmCandidateMatch, GtmEvidence, GtmPlay, GtmWorkspace } from './data/entities'
import { reviewCandidate, reviewCandidateMatch } from './lib/research/review'
import type { ResearchEm } from './lib/research/execute'
import { latestMatchForCandidate, latestMatchesForCandidates } from './lib/research/match-projection'

type ToolContext = {
  tenantId: string | null
  organizationId: string | null
  userId: string | null
  container: AwilixContainer
}

// The AI assistant package keeps this loader-facing shape internal at its
// package root, so app modules define the same narrow contract locally. This
// mirrors the other Mercato app modules and keeps handlers fully typed.
interface AiToolDefinition {
  name: string
  description: string
  inputSchema: z.ZodType
  requiredFeatures?: string[]
  handler: (input: never, ctx: ToolContext) => Promise<unknown>
}

const ENTITY_KINDS = ['opportunity', 'person', 'company'] as const
const FIT_STATES = ['accepted', 'review', 'rejected', 'unscored'] as const
const INTENT_KINDS = ['buyer_intent', 'seller_intent', 'local_audience', 'mixed_intent'] as const
const OPPORTUNITY_KINDS = [
  'community',
  'forum',
  'group',
  'thread',
  'post',
  'event',
  'creator_audience',
  'other',
] as const
const READ_CAP = 200

function requireScope(ctx: ToolContext): {
  organizationId: string
  tenantId: string
  userId: string
} {
  if (!ctx.organizationId || !ctx.tenantId || !ctx.userId) {
    throw new Error('Organization, tenant, and user context are required')
  }
  return {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    userId: ctx.userId,
  }
}

function emFor(ctx: ToolContext): EntityManager {
  return (ctx.container.resolve('em') as EntityManager).fork()
}

function iso(value: Date | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : null
}

function safeIdentity(candidate: GtmCandidate): Record<string, unknown> {
  const identity = candidate.identity ?? {}
  if (candidate.entityKind !== 'opportunity') return identity
  // Opportunity identities contain public venue context only. Keep an
  // explicit allowlist so a future provider field cannot leak through MCP.
  const keys = [
    'name',
    'opportunity_kind',
    'platform',
    'intent_kind',
    'audience_description',
    'activity_level',
    'member_count',
    'engagement_count',
    'access_type',
    'event_start_at',
    'location',
    'city',
    'region',
    'country_code',
    'urls',
    'participation_rules',
    'participation_rules_status',
    'recommended_action',
    'message_angle',
    'people_to_follow',
  ]
  return Object.fromEntries(keys.filter((key) => identity[key] !== undefined).map((key) => [key, identity[key]]))
}

function shapeCandidate(candidate: GtmCandidate, match?: GtmCandidateMatch | null) {
  return {
    id: candidate.id,
    matchId: match?.id ?? null,
    workspaceId: candidate.workspaceId,
    playId: match?.playId ?? null,
    researchRunId: match?.researchRunId ?? candidate.researchRunId,
    entityKind: candidate.entityKind,
    identity: safeIdentity(candidate),
    fitStatus: match?.fitStatus ?? candidate.fitStatus,
    fitScore: Number(match?.fitScore ?? candidate.fitScore ?? 0),
    rejectReason: match?.rejectReason ?? candidate.rejectReason ?? null,
    qualityStatus: match?.qualityStatus ?? candidate.qualityStatus ?? null,
    qualification: match?.qualification ?? candidate.qualification ?? null,
    createdAt: iso(match?.createdAt ?? candidate.createdAt),
  }
}

export const gtmListWorkspacesTool: AiToolDefinition = {
  name: 'gtm_list_workspaces',
  description: `List the represented user's GTM Engineer workspaces and Audience Plays. Use this before looking for opportunities or leads. Returns market, sourcing, and outreach policy status but never credentials or provider secrets.`,
  inputSchema: z.object({
    workspaceId: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(50).default(20).optional(),
  }),
  requiredFeatures: ['gtm.view'],
  handler: async (input: any, ctx) => {
    const scope = requireScope(ctx)
    const em = emFor(ctx)
    const where: Record<string, unknown> = {
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      deletedAt: null,
    }
    if (input.workspaceId) where.id = input.workspaceId
    const workspaces = await em.find(GtmWorkspace, where, {
      orderBy: { updatedAt: 'desc' },
      limit: input.limit ?? 20,
    })
    const workspaceIds = workspaces.map((workspace) => workspace.id)
    const plays = workspaceIds.length
      ? await em.find(
          GtmPlay,
          {
            organizationId: scope.organizationId,
            tenantId: scope.tenantId,
            workspaceId: { $in: workspaceIds },
            deletedAt: null,
          },
          { orderBy: { createdAt: 'desc' }, limit: READ_CAP },
        )
      : []
    const playsByWorkspace = new Map<string, GtmPlay[]>()
    for (const play of plays) {
      const rows = playsByWorkspace.get(play.workspaceId) ?? []
      rows.push(play)
      playsByWorkspace.set(play.workspaceId, rows)
    }
    return {
      total: workspaces.length,
      workspaces: workspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        status: workspace.status,
        updatedAt: iso(workspace.updatedAt),
        plays: (playsByWorkspace.get(workspace.id) ?? []).map((play) => ({
          id: play.id,
          marketType: play.marketType ?? null,
          audience: play.audience ?? null,
          signal: play.signal ?? null,
          entityUnit: play.entityUnit ?? null,
          geography: play.geography ?? null,
          estimatedSize: play.estimatedSize ?? null,
          leadMode: play.leadMode ?? null,
          researchEligibility: play.researchEligibility ?? null,
          outreachMode: play.outreachMode ?? null,
          executionEligibility: play.executionEligibility,
        })),
      })),
    }
  },
}

export const gtmListOpportunitiesTool: AiToolDefinition = {
  name: 'gtm_list_opportunities',
  description: `List evidence-backed GTM opportunities and leads. Consumer results prioritize communities, forums, groups, posts, threads, events, and creator audiences; public people are an optional second layer. No send or post action occurs.`,
  inputSchema: z.object({
    workspaceId: z.string().uuid().optional(),
    playId: z.string().uuid().optional(),
    entityKind: z.enum(ENTITY_KINDS).optional(),
    fitStatus: z.enum(FIT_STATES).optional(),
    intentKind: z.enum(INTENT_KINDS).optional(),
    opportunityKind: z.enum(OPPORTUNITY_KINDS).optional(),
    limit: z.number().int().min(1).max(50).default(20).optional(),
  }),
  requiredFeatures: ['gtm.view'],
  handler: async (input: any, ctx) => {
    const scope = requireScope(ctx)
    const em = emFor(ctx)
    let matches: GtmCandidateMatch[] = []
    let candidateIds: string[] | null = null
    if (input.playId) {
      matches = await em.find(
        GtmCandidateMatch,
        {
          organizationId: scope.organizationId,
          tenantId: scope.tenantId,
          playId: input.playId,
          ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
          deletedAt: null,
        },
        { orderBy: { createdAt: 'desc', id: 'desc' }, limit: READ_CAP },
      )
      candidateIds = [...new Set(matches.map((match) => match.candidateId))]
    }
    const where: Record<string, unknown> = {
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      deletedAt: null,
    }
    if (input.workspaceId) where.workspaceId = input.workspaceId
    if (input.entityKind) where.entityKind = input.entityKind
    if (candidateIds) where.id = { $in: candidateIds }
    let candidates =
      candidateIds?.length === 0
        ? []
        : await em.find(GtmCandidate, where, {
            orderBy: { createdAt: 'desc' },
            limit: READ_CAP,
          })
    const latestMatch = input.playId
      ? new Map<string, GtmCandidateMatch>()
      : await latestMatchesForCandidates(em, {
          organizationId: scope.organizationId,
          tenantId: scope.tenantId,
          candidateIds: candidates.map((candidate) => candidate.id),
          ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        })
    if (input.playId) {
      for (const match of matches) if (!latestMatch.has(match.candidateId)) latestMatch.set(match.candidateId, match)
    }
    candidates = candidates
      .filter((candidate) => {
        const match = latestMatch.get(candidate.id)
        if (input.playId && !match) return false
        if (input.fitStatus && (match?.fitStatus ?? candidate.fitStatus) !== input.fitStatus) return false
        const identity = candidate.identity ?? {}
        if (input.intentKind && identity.intent_kind !== input.intentKind) return false
        if (input.opportunityKind && identity.opportunity_kind !== input.opportunityKind) return false
        return true
      })
      .sort((a, b) => {
        const aScore = Number(latestMatch.get(a.id)?.fitScore ?? a.fitScore ?? 0)
        const bScore = Number(latestMatch.get(b.id)?.fitScore ?? b.fitScore ?? 0)
        return bScore - aScore
      })
      .slice(0, input.limit ?? 20)
    return {
      total: candidates.length,
      filters: {
        workspaceId: input.workspaceId ?? null,
        playId: input.playId ?? null,
        entityKind: input.entityKind ?? null,
        fitStatus: input.fitStatus ?? null,
        intentKind: input.intentKind ?? null,
        opportunityKind: input.opportunityKind ?? null,
      },
      results: candidates.map((candidate) => shapeCandidate(candidate, latestMatch.get(candidate.id))),
    }
  },
}

export const gtmGetOpportunityTool: AiToolDefinition = {
  name: 'gtm_get_opportunity',
  description: `Get one GTM opportunity or lead with retained evidence and public destinations. This is read-only and never contacts a provider, person, group, or event.`,
  inputSchema: z.object({
    candidateId: z.string().uuid(),
    matchId: z.string().uuid().optional(),
  }),
  requiredFeatures: ['gtm.view'],
  handler: async (input: any, ctx) => {
    const scope = requireScope(ctx)
    const em = emFor(ctx)
    const candidate = await em.findOne(GtmCandidate, {
      id: input.candidateId,
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      deletedAt: null,
    })
    if (!candidate) throw new Error('GTM result not found')
    const match = input.matchId
      ? await em.findOne(GtmCandidateMatch, {
          id: input.matchId,
          candidateId: candidate.id,
          organizationId: scope.organizationId,
          tenantId: scope.tenantId,
          deletedAt: null,
        })
      : await latestMatchForCandidate(em, {
          organizationId: scope.organizationId,
          tenantId: scope.tenantId,
          candidateId: candidate.id,
        })
    if (input.matchId && !match) throw new Error('GTM result not found')
    const evidence = await em.find(
      GtmEvidence,
      {
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        candidateId: candidate.id,
        ...(match ? { researchRunId: match.researchRunId } : {}),
        deletedAt: null,
      },
      { orderBy: { observedAt: 'desc' }, limit: 100 },
    )
    return {
      result: shapeCandidate(candidate, match),
      evidence: evidence.map((row) => ({
        id: row.id,
        claim: row.claim,
        sourceUrl: row.sourceUrl ?? null,
        observedAt: iso(row.observedAt),
        confidence: row.confidence != null ? Number(row.confidence) : null,
        qualityStatus: row.qualityStatus ?? null,
        evidenceType: row.evidenceType ?? null,
      })),
    }
  },
}

export const gtmReviewOpportunityTool: AiToolDefinition = {
  name: 'gtm_review_opportunity',
  description: `Accept or reject one GTM opportunity or lead for the represented user. This records a scoped human review and audit event only; it does not send, post, enrich, or call a provider.`,
  inputSchema: z.object({
    candidateId: z.string().uuid(),
    matchId: z.string().uuid().optional(),
    verdict: z.enum(['accepted', 'rejected']),
    reason: z.string().trim().max(500).optional(),
  }),
  requiredFeatures: ['gtm.edit'],
  handler: async (input: any, ctx) => {
    const scope = requireScope(ctx)
    const em = emFor(ctx)
    const candidate = await em.findOne(GtmCandidate, {
      id: input.candidateId,
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      deletedAt: null,
    })
    if (!candidate) throw new Error('GTM result not found')
    const match = input.matchId
      ? await em.findOne(GtmCandidateMatch, {
          id: input.matchId,
          candidateId: candidate.id,
          organizationId: scope.organizationId,
          tenantId: scope.tenantId,
          deletedAt: null,
        })
      : await latestMatchForCandidate(em, {
          organizationId: scope.organizationId,
          tenantId: scope.tenantId,
          candidateId: candidate.id,
        })
    if (input.matchId && !match) throw new Error('GTM result not found')
    if (match) {
      const reviewed = await reviewCandidateMatch({
        em: em as unknown as ResearchEm,
        candidate,
        match,
        verdict: input.verdict,
        reason: input.reason ?? null,
        userId: scope.userId,
      })
      return {
        result: shapeCandidate(reviewed.candidate, reviewed.match),
        auditId: reviewed.audit.id,
      }
    }
    const reviewed = await reviewCandidate({
      em: em as unknown as ResearchEm,
      candidate,
      verdict: input.verdict,
      reason: input.reason ?? null,
      userId: scope.userId,
    })
    return {
      result: shapeCandidate(reviewed.candidate),
      auditId: reviewed.audit.id,
    }
  },
}

export const aiTools: AiToolDefinition[] = [
  gtmListWorkspacesTool,
  gtmListOpportunitiesTool,
  gtmGetOpportunityTool,
  gtmReviewOpportunityTool,
]

export default aiTools
