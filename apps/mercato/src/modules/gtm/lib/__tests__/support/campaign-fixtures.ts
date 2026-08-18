import { FakeEm } from './fake-em'
import type { GtmCtx } from '../../campaign/build'
import {
  GtmCandidate,
  GtmContactPoint,
  GtmEvidence,
  GtmPlay,
  GtmResearchRun,
  GtmWorkspace,
} from '../../../data/entities'

/*
 * Shared seed helpers for the Tranche 5 campaign tests. All identities are
 * synthetic (SPEC-066 section 11.3: no real prospect data in fixtures).
 */

export const ORG = 'aaaaaaaa-1111-4111-8111-111111111111'
export const OTHER_ORG = 'aaaaaaaa-9999-4999-8999-999999999999'
export const TENANT = 'bbbbbbbb-2222-4222-8222-222222222222'
export const USER = 'cccccccc-3333-4333-8333-333333333333'
export const WORKSPACE = 'dddddddd-4444-4444-8444-444444444444'

export const ctx: GtmCtx = {
  organizationId: ORG,
  tenantId: TENANT,
  userId: USER,
  requestId: 'test-request',
}

// Synthetic org postal address (CAN-SPAM sender address in the footer).
export const POSTAL_ADDRESS = '500 Synthetic Way, Suite 12, Fresno, CA 93650'

let seq = 0

// Idempotent: reuses an existing workspace row with the same id so multiple
// seedPlay calls share one workspace. postalAddress: null seeds a workspace
// WITHOUT the CAN-SPAM address (for the approval-gate tests).
export async function seedWorkspace(
  em: FakeEm,
  overrides: Partial<{ id: string; postalAddress: string | null }> = {},
): Promise<GtmWorkspace> {
  const id = overrides.id ?? WORKSPACE
  const existing = await em.findOne(GtmWorkspace, { id })
  if (existing) return existing
  const workspace = em.create(GtmWorkspace, {
    id,
    organizationId: ORG,
    tenantId: TENANT,
    name: 'Fixture workspace',
    status: 'active',
    settings:
      overrides.postalAddress === null
        ? {}
        : { postal_address: overrides.postalAddress ?? POSTAL_ADDRESS },
  })
  em.persist(workspace)
  await em.flush()
  return workspace
}

export async function seedPlay(
  em: FakeEm,
  overrides: Partial<{
    workspaceId: string
    marketType: string
    geography: string
    whyNow: string | null
    signal: string | null
  }> = {},
): Promise<GtmPlay> {
  await seedWorkspace(em, { id: overrides.workspaceId ?? WORKSPACE })
  const play = em.create(GtmPlay, {
    organizationId: ORG,
    tenantId: TENANT,
    workspaceId: overrides.workspaceId ?? WORKSPACE,
    source: 'imported',
    marketType: overrides.marketType ?? 'b2b',
    audience: 'Synthetic B2B services firms',
    signal: overrides.signal ?? 'hiring_growth',
    geography: overrides.geography ?? 'California, US',
    whyNow:
      overrides.whyNow === undefined
        ? 'Teams hiring this quarter are actively rebuilding their outbound stack.'
        : overrides.whyNow,
    executionEligibility: 'executable',
  })
  em.persist(play)
  await em.flush()
  return play
}

export async function seedRun(em: FakeEm, play: GtmPlay): Promise<GtmResearchRun> {
  const run = em.create(GtmResearchRun, {
    organizationId: ORG,
    tenantId: TENANT,
    workspaceId: play.workspaceId,
    playId: play.id,
    status: 'completed',
  })
  em.persist(run)
  await em.flush()
  return run
}

export type SeedCandidateOptions = {
  name?: string
  company?: string | null
  email?: string | null
  verificationState?: string
  evidenceClaim?: string | null
  fitStatus?: string
  promotedContactId?: string | null
}

export async function seedCandidate(
  em: FakeEm,
  run: GtmResearchRun,
  options: SeedCandidateOptions = {},
): Promise<GtmCandidate> {
  seq += 1
  const name = options.name ?? `Synthetic Person ${seq}`
  const candidate = em.create(GtmCandidate, {
    organizationId: run.organizationId,
    tenantId: run.tenantId,
    researchRunId: run.id,
    workspaceId: run.workspaceId,
    entityKind: 'person',
    identity: {
      name,
      company: options.company === undefined ? `Synthetic Co ${seq}` : options.company,
    },
    dedupeKey: `campaign-fixture-${seq}`,
    fitStatus: options.fitStatus ?? 'accepted',
    promotedContactId: options.promotedContactId ?? null,
  })
  em.persist(candidate)
  if (options.evidenceClaim !== null) {
    em.persist(
      em.create(GtmEvidence, {
        organizationId: run.organizationId,
        tenantId: run.tenantId,
        candidateId: candidate.id,
        claim: options.evidenceClaim ?? `the team posted three synthetic roles this month`,
        confidence: '0.9',
      }),
    )
  }
  if (options.email !== null) {
    em.persist(
      em.create(GtmContactPoint, {
        organizationId: run.organizationId,
        tenantId: run.tenantId,
        candidateId: candidate.id,
        channel: 'email',
        value: options.email ?? `synthetic-${seq}@fixture.example`,
        verificationState: options.verificationState ?? 'verified',
        verifiedAt: new Date('2026-07-20T00:00:00.000Z'),
      }),
    )
  }
  await em.flush()
  return candidate
}
