import {
  GtmAuditEvent,
  GtmCandidate,
  GtmCandidateMatch,
  GtmProviderOperation,
  GtmResearchRun,
} from '../../data/entities'
import { getOpportunityQualityDiagnostics } from '../diagnostics/opportunity-quality'
import { FakeEm } from './support/fake-em'

const ORG = '00000000-0000-4000-8000-000000000001'
const TENANT = '00000000-0000-4000-8000-000000000002'
const WORKSPACE = '00000000-0000-4000-8000-000000000003'
const PLAY = '00000000-0000-4000-8000-000000000004'

describe('opportunity quality diagnostics', () => {
  it('aggregates useful yield, spend, dead/stale/parser/duplicate rates, reviews, and drift safely', async () => {
    const em = new FakeEm()
    const run = em.create(GtmResearchRun, {
      organizationId: ORG,
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      playId: PLAY,
      status: 'completed',
      providerPlan: {
        schemaVersion: '9',
        adapterPlan: [{
          adapter_id: 'apify-reddit-post-search',
          priceVersion: 'reddit-v1',
          descriptorHash: 'descriptor-v1',
        }],
        execution: {
          batches: [{
            operation_id: '00000000-0000-4000-8000-000000000010',
            charged_credits: 8,
            raw_candidates_found: 5,
            duplicates_skipped: 1,
          }],
        },
      },
    })
    const operation = em.create(GtmProviderOperation, {
      organizationId: ORG,
      tenantId: TENANT,
      noliCoreOperationId: '00000000-0000-4000-8000-000000000010',
      researchRunId: run.id,
      kind: 'source',
      provider: 'apify',
      localStatusMirror: 'charged',
      receipt: {
        raw_item_count: 6,
        item_count: 5,
        returned_count: 4,
        parser_dropped_rows: 1,
        keyword_filtered_rows: 2,
        actor_build: 'reddit-actor-v1',
        raw_provider_secret: 'never-return-this',
      },
    })
    const accepted = em.create(GtmCandidate, {
      organizationId: ORG,
      tenantId: TENANT,
      researchRunId: run.id,
      workspaceId: WORKSPACE,
      entityKind: 'opportunity',
      identity: { url: 'https://example.com/private-candidate' },
      dedupeKey: 'accepted',
      fitStatus: 'accepted',
    })
    const dead = em.create(GtmCandidate, {
      organizationId: ORG,
      tenantId: TENANT,
      researchRunId: run.id,
      workspaceId: WORKSPACE,
      entityKind: 'opportunity',
      identity: { url: 'https://example.com/dead' },
      dedupeKey: 'dead',
      fitStatus: 'rejected',
    })
    const acceptedMatch = em.create(GtmCandidateMatch, {
      organizationId: ORG,
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      playId: PLAY,
      researchRunId: run.id,
      candidateId: accepted.id,
      providerOperationId: operation.id,
      fitStatus: 'accepted',
    })
    const deadMatch = em.create(GtmCandidateMatch, {
      organizationId: ORG,
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      playId: PLAY,
      researchRunId: run.id,
      candidateId: dead.id,
      providerOperationId: operation.id,
      fitStatus: 'rejected',
      rejectReason: 'public_destination_expired',
    })
    const acceptedAudit = em.create(GtmAuditEvent, {
      organizationId: ORG,
      tenantId: TENANT,
      actor: 'user_id',
      action: 'gtm.candidate_match.review_override',
      objectType: 'gtm_candidate_match',
      objectId: acceptedMatch.id,
      metadata: { verdict: 'accepted', reason: null },
    })
    const rejectedAudit = em.create(GtmAuditEvent, {
      organizationId: ORG,
      tenantId: TENANT,
      actor: 'user_id',
      action: 'gtm.candidate_match.review_override',
      objectType: 'gtm_candidate_match',
      objectId: deadMatch.id,
      metadata: { verdict: 'rejected', reason: 'This URL is actually private and sensitive' },
    })
    const foreign = em.create(GtmCandidate, {
      organizationId: ORG,
      tenantId: '00000000-0000-4000-8000-000000000099',
      researchRunId: run.id,
      workspaceId: WORKSPACE,
      entityKind: 'opportunity',
      identity: { url: 'https://foreign.example' },
      dedupeKey: 'foreign',
      fitStatus: 'accepted',
    })
    for (const entity of [
      run,
      operation,
      accepted,
      dead,
      acceptedMatch,
      deadMatch,
      acceptedAudit,
      rejectedAudit,
      foreign,
    ]) em.persist(entity)
    await em.flush()

    const result = await getOpportunityQualityDiagnostics(em, {
      organizationId: ORG,
      tenantId: TENANT,
    })

    expect(result.totals).toMatchObject({
      opportunities: 2,
      accepted: 1,
      rejected: 1,
      humanUsefulAccepted: 1,
      humanRejected: 1,
      chargedCredits: 8,
      costCreditsPerUsefulOpportunity: 8,
      deadDestinations: 1,
      staleDestinations: 1,
      parserInputRows: 6,
      parserDroppedRows: 1,
      parserDropRate: 1 / 6,
      keywordFilteredRows: 2,
      keywordFilterRate: 2 / 5,
      rawCandidatesFound: 5,
      duplicatesSkipped: 1,
      duplicateRate: 0.2,
    })
    expect(result.sources).toEqual([
      expect.objectContaining({ source: 'apify', humanUsefulAccepted: 1 }),
    ])
    expect(result.humanReviewReasons).toEqual([
      { verdict: 'accepted', reason: 'accepted', count: 1 },
      { verdict: 'rejected', reason: 'custom_reason', count: 1 },
    ])
    expect(result.drift).toEqual({
      detected: false,
      providers: [{
        adapterId: 'apify-reddit-post-search',
        priceVersions: ['reddit-v1'],
        descriptorHashes: ['descriptor-v1'],
        actorBuilds: ['reddit-actor-v1'],
        planSchemaVersions: ['9'],
        pricingDrift: false,
        schemaDrift: false,
      }],
    })
    expect(JSON.stringify(result)).not.toContain('never-return-this')
    expect(JSON.stringify(result)).not.toContain('private-candidate')
    expect(JSON.stringify(result)).not.toContain('sensitive')
  })

  it('flags pricing and schema changes across the bounded run window', async () => {
    const em = new FakeEm()
    for (const [index, version] of ['v1', 'v2'].entries()) {
      em.persist(em.create(GtmResearchRun, {
        organizationId: ORG,
        tenantId: TENANT,
        workspaceId: WORKSPACE,
        playId: PLAY,
        status: 'completed',
        providerPlan: {
          schemaVersion: index === 0 ? '8' : '9',
          adapterPlan: [{
            adapter_id: 'apify-x-post-search',
            priceVersion: version,
            descriptorHash: `hash-${version}`,
          }],
          execution: { batches: [] },
        },
      }))
    }
    await em.flush()
    // Runs without opportunity matches are intentionally outside this
    // tenant diagnostic window, so no false drift alert is emitted.
    const result = await getOpportunityQualityDiagnostics(em, {
      organizationId: ORG,
      tenantId: TENANT,
    })
    expect(result.drift.detected).toBe(false)
    expect(result.drift.providers).toEqual([])
  })
})
