import { GtmCandidateMatch } from '../../data/entities'

export type MatchProjectionEm = {
  find<T extends object>(
    entity: new () => T,
    where: Record<string, unknown>,
    options?: { orderBy?: Record<string, 'asc' | 'desc'>; limit?: number },
  ): Promise<T[]>
}

type MatchScope = {
  organizationId: string
  tenantId: string
  candidateIds: string[]
  workspaceId?: string
  playId?: string
  researchRunId?: string
}

/**
 * Candidate identity is workspace-wide, but qualification belongs to a
 * frozen play/run match. Resolve the newest match for each identity so a
 * later requalification cannot be hidden by the legacy root candidate fields.
 */
export async function latestMatchesForCandidates(
  em: MatchProjectionEm,
  scope: MatchScope,
): Promise<Map<string, GtmCandidateMatch>> {
  if (scope.candidateIds.length === 0) return new Map()
  const where: Record<string, unknown> = {
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
    candidateId: { $in: [...new Set(scope.candidateIds)] },
    deletedAt: null,
  }
  if (scope.workspaceId) where.workspaceId = scope.workspaceId
  if (scope.playId) where.playId = scope.playId
  if (scope.researchRunId) where.researchRunId = scope.researchRunId
  const matches = await em.find(GtmCandidateMatch, where, {
    orderBy: { createdAt: 'desc', id: 'desc' },
  })
  const latest = new Map<string, GtmCandidateMatch>()
  for (const match of matches) {
    if (!latest.has(match.candidateId)) latest.set(match.candidateId, match)
  }
  return latest
}

export async function latestMatchForCandidate(
  em: MatchProjectionEm,
  scope: Omit<MatchScope, 'candidateIds'> & { candidateId: string },
): Promise<GtmCandidateMatch | null> {
  const matches = await latestMatchesForCandidates(em, {
    ...scope,
    candidateIds: [scope.candidateId],
  })
  return matches.get(scope.candidateId) ?? null
}
