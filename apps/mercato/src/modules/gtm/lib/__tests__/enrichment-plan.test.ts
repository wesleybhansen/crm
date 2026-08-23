import { fixtureEnrichAdapter, fixtureVerifyAdapter } from '../adapters/fixture'
import { buildEnrichmentPlan } from '../enrich/plan'

describe('immutable enrichment quote', () => {
  const candidates = [{ id: 'c-1' }, { id: 'c-2' }, { id: 'c-3' }]

  it('quotes only unresolved candidates and separates lookup from verification units', () => {
    const plan = buildEnrichmentPlan(
      candidates,
      [
        { candidateId: 'c-2', channel: 'email', verificationState: 'found' },
        { candidateId: 'c-3', channel: 'email', verificationState: 'verified' },
      ],
      [fixtureEnrichAdapter],
      [fixtureVerifyAdapter],
      2,
    )
    expect(plan.candidates_considered).toBe(3)
    expect(plan.candidates_needing_enrichment).toBe(1)
    expect(plan.emails_needing_verification).toBe(2)
    expect(plan.providers).toEqual([
      expect.objectContaining({ adapter_id: 'fixture-enrich', max_units: 1, max_credits: 4 }),
      expect.objectContaining({ adapter_id: 'fixture-verify', max_units: 2, max_credits: 4 }),
    ])
    expect(plan.maximum_credits).toBe(8)
    expect(plan.plan_hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('excludes accepted company identities from person contact discovery and verification', () => {
    const plan = buildEnrichmentPlan(
      [
        { id: 'person-1', entityKind: 'person' },
        { id: 'company-1', entityKind: 'company' },
      ],
      [
        {
          id: 'company-point',
          candidateId: 'company-1',
          channel: 'email',
          value: 'office@example.com',
          verificationState: 'found',
        },
      ],
      [fixtureEnrichAdapter],
      [fixtureVerifyAdapter],
      2,
    )

    expect(plan).toMatchObject({
      candidates_considered: 1,
      candidates_needing_enrichment: 1,
      emails_needing_verification: 1,
    })
    expect(plan.providers).toEqual([
      expect.objectContaining({ adapter_id: 'fixture-enrich', max_units: 1 }),
      expect.objectContaining({ adapter_id: 'fixture-verify', max_units: 1 }),
    ])
  })

  it('counts every unidentified found row, not one per candidate', () => {
    // c-2 carries two found addresses; the waterfall verifies both, so the
    // quote has to reserve for both or the run stops inside its own ceiling.
    const plan = buildEnrichmentPlan(
      candidates,
      [
        { candidateId: 'c-2', channel: 'email', verificationState: 'found' },
        { candidateId: 'c-2', channel: 'email', verificationState: 'found' },
        { candidateId: 'c-3', channel: 'email', verificationState: 'verified' },
      ],
      [fixtureEnrichAdapter],
      [fixtureVerifyAdapter],
      2,
    )
    expect(plan.candidates_needing_enrichment).toBe(1)
    expect(plan.emails_needing_verification).toBe(3)
    expect(plan.providers).toEqual([
      expect.objectContaining({ adapter_id: 'fixture-enrich', max_units: 1 }),
      expect.objectContaining({ adapter_id: 'fixture-verify', max_units: 3 }),
    ])
  })

  it('quotes one verification for duplicate normalized addresses', () => {
    const plan = buildEnrichmentPlan(
      [{ id: 'c-1' }, { id: 'c-2' }],
      [
        { id: 'point-1', candidateId: 'c-1', channel: 'email', value: 'Same@Example.com', verificationState: 'found' },
        { id: 'point-2', candidateId: 'c-2', channel: 'email', value: ' same@example.com ', verificationState: 'found' },
      ],
      [],
      [fixtureVerifyAdapter],
      2,
    )
    expect(plan.emails_needing_verification).toBe(1)
    expect(plan.providers).toEqual([
      expect.objectContaining({ adapter_id: 'fixture-verify', max_units: 1 }),
    ])
  })

  it('reuses an existing terminal result without quoting another provider call', () => {
    const plan = buildEnrichmentPlan(
      [{ id: 'c-1' }, { id: 'c-2' }],
      [
        { id: 'point-1', candidateId: 'c-1', channel: 'email', value: 'same@example.com', verificationState: 'verified' },
        { id: 'point-2', candidateId: 'c-2', channel: 'email', value: 'SAME@example.com', verificationState: 'found' },
      ],
      [],
      [fixtureVerifyAdapter],
      2,
    )
    expect(plan.emails_needing_verification).toBe(0)
    expect(plan.maximum_credits).toBe(0)
  })

  it('does not reuse conflicting historical terminal results', () => {
    const plan = buildEnrichmentPlan(
      [{ id: 'c-1' }, { id: 'c-2' }, { id: 'c-3' }],
      [
        { id: 'point-1', candidateId: 'c-1', channel: 'email', value: 'same@example.com', verificationState: 'verified' },
        { id: 'point-2', candidateId: 'c-2', channel: 'email', value: 'same@example.com', verificationState: 'not_found' },
        { id: 'point-3', candidateId: 'c-3', channel: 'email', value: 'same@example.com', verificationState: 'found' },
      ],
      [],
      [fixtureVerifyAdapter],
      2,
    )
    expect(plan.emails_needing_verification).toBe(1)
    expect(plan.maximum_credits).toBeGreaterThan(0)
  })

  it('drops a provider whose frozen terms version is missing', () => {
    const unapproved = {
      ...fixtureVerifyAdapter,
      descriptor: {
        ...fixtureVerifyAdapter.descriptor,
        constraints: {
          ...fixtureVerifyAdapter.descriptor.constraints,
          license: { ...fixtureVerifyAdapter.descriptor.constraints.license, terms_version: '' },
        },
      },
    }
    const plan = buildEnrichmentPlan(candidates, [], [fixtureEnrichAdapter], [unapproved])
    expect(plan.providers.map((provider) => provider.adapter_id)).toEqual(['fixture-enrich'])
  })

  it('changes when a contact state changes so stale approval cannot run', () => {
    const before = buildEnrichmentPlan(candidates, [], [fixtureEnrichAdapter], [fixtureVerifyAdapter])
    const after = buildEnrichmentPlan(
      candidates,
      [{ candidateId: 'c-1', channel: 'email', verificationState: 'verified' }],
      [fixtureEnrichAdapter],
      [fixtureVerifyAdapter],
    )
    expect(after.plan_hash).not.toBe(before.plan_hash)
  })

  it('binds the selected contact-point id and normalized address into the quote', () => {
    const first = buildEnrichmentPlan(
      candidates,
      [{ id: 'point-1', candidateId: 'c-1', channel: 'email', value: 'A@Example.com', verificationState: 'found' }],
      [fixtureEnrichAdapter],
      [fixtureVerifyAdapter],
    )
    const changedIdentity = buildEnrichmentPlan(
      candidates,
      [{ id: 'point-2', candidateId: 'c-1', channel: 'email', value: 'b@example.com', verificationState: 'found' }],
      [fixtureEnrichAdapter],
      [fixtureVerifyAdapter],
    )
    expect(first.schema_version).toBe('4')
    expect(changedIdentity.plan_hash).not.toBe(first.plan_hash)
  })

  it('quotes a candidate-gated enrichment adapter only for people with its required input', () => {
    const domainAdapter = {
      ...fixtureEnrichAdapter,
      descriptor: {
        ...fixtureEnrichAdapter.descriptor,
        adapter_id: 'domain-enrich',
      },
      supportsCandidate: (candidate: { identity?: Record<string, unknown> | null }) =>
        typeof candidate.identity?.domain === 'string',
    }
    const withDomain = buildEnrichmentPlan(
      [
        { id: 'c-1', entityKind: 'person', identity: { domain: 'acme-industrial.com' } },
        { id: 'c-2', entityKind: 'person', identity: { name: 'No domain' } },
      ],
      [],
      [domainAdapter],
      [],
      2,
    )
    const changedDomain = buildEnrichmentPlan(
      [
        { id: 'c-1', entityKind: 'person', identity: { domain: 'other-industrial.com' } },
        { id: 'c-2', entityKind: 'person', identity: { name: 'No domain' } },
      ],
      [],
      [domainAdapter],
      [],
      2,
    )

    expect(withDomain.providers).toEqual([
      expect.objectContaining({ adapter_id: 'domain-enrich', max_units: 1 }),
    ])
    expect(changedDomain.plan_hash).not.toBe(withDomain.plan_hash)
  })

  it('quotes verification for the maximum contacts one winning adapter can return', () => {
    const onePointAdapter = {
      ...fixtureEnrichAdapter,
      descriptor: { ...fixtureEnrichAdapter.descriptor, adapter_id: 'one-point' },
    }
    const fivePointAdapter = {
      ...fixtureEnrichAdapter,
      descriptor: { ...fixtureEnrichAdapter.descriptor, adapter_id: 'five-point' },
      maxContactPointsPerCandidate: 5,
    }
    const plan = buildEnrichmentPlan(
      [{ id: 'c-1', entityKind: 'person' }],
      [],
      [onePointAdapter, fivePointAdapter],
      [fixtureVerifyAdapter],
      2,
    )

    expect(plan.emails_needing_verification).toBe(5)
    expect(plan.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ adapter_id: 'fixture-verify', max_units: 5 }),
    ]))
  })
})
