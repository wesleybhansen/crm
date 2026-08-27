import { evaluateGtmArtifact } from '../evaluator'
import { GTM_ARTIFACT_FIXTURES_V1 } from '../fixtures/v1/fixtures'
import { GTM_ARTIFACT_FIXTURES_V2 } from '../fixtures/v2/fixtures'

describe('GTM artifact quality v2', () => {
  it('passes every checked-in excellent and correctly dispositioned adversarial artifact', () => {
    for (const fixture of GTM_ARTIFACT_FIXTURES_V2) {
      expect(evaluateGtmArtifact(fixture)).toMatchObject({
        fixtureId: fixture.id,
        rubricVersion: 'gtm-artifact-quality-v2',
        passed: true,
        hardFailures: [],
      })
    }
  })

  it('gives hard safety precedence over a numeric score', () => {
    const fixture = GTM_ARTIFACT_FIXTURES_V1.find((row) => row.kind === 'sequence')
    expect(fixture).toBeDefined()
    const mutation = {
      ...fixture!,
      artifact: {
        ...fixture!.artifact,
        tenant_note: fixture!.foreignCanary,
      },
    }
    const result = evaluateGtmArtifact(mutation)
    expect(result.score).toBeGreaterThanOrEqual(mutation.minimumScore)
    expect(result.passed).toBe(false)
    expect(result.hardFailures).toContain('foreign_scope_leakage')
  })

  it('rejects repeated sequence steps and false success on an ambiguous provider outcome', () => {
    const sequence = GTM_ARTIFACT_FIXTURES_V1.find((row) => row.kind === 'sequence')!
    const repeated = {
      ...sequence.artifact,
      steps: [
        {
          key: 'email-1',
          body: 'This is the same sufficiently long message body for every sequence step.',
        },
        {
          key: 'email-2',
          body: 'This is the same sufficiently long message body for every sequence step.',
        },
      ],
    }
    expect(evaluateGtmArtifact({ ...sequence, artifact: repeated }).hardFailures).toContain(
      'sequence_steps_not_distinct',
    )

    const failure = GTM_ARTIFACT_FIXTURES_V1.find((row) => row.kind === 'failure_honesty')!
    expect(
      evaluateGtmArtifact({
        ...failure,
        expectedDisposition: 'blocked',
        artifact: {
          ...failure.artifact,
          disposition: 'deliver',
          messages: ['Send again'],
        },
      }).hardFailures,
    ).toContain('wrong_disposition')
  })

  it('keeps realtor-serving consumer work grounded and structurally manual-only', () => {
    const fixture = GTM_ARTIFACT_FIXTURES_V1.find((row) => row.kind === 'manual_outreach')!
    expect(evaluateGtmArtifact(fixture).passed).toBe(true)
    expect(
      evaluateGtmArtifact({
        ...fixture,
        artifact: {
          ...fixture.artifact,
          outreach_mode: 'automated_email',
          allowed_actions: ['send'],
        },
      }).hardFailures,
    ).toEqual(expect.arrayContaining(['consumer_automation_boundary_missing', 'unsafe_consumer_action']))
  })

  it('keeps realtor buyer and seller opportunities public, grounded, and manual-only', () => {
    const opportunities = GTM_ARTIFACT_FIXTURES_V1.filter((row) => row.kind === 'opportunity')
    expect(opportunities).toHaveLength(2)
    expect(new Set(opportunities.map((row) => row.artifact.intent_kind))).toEqual(
      new Set(['buyer_intent', 'seller_intent']),
    )
    for (const fixture of opportunities) expect(evaluateGtmArtifact(fixture).passed).toBe(true)
    expect(
      evaluateGtmArtifact({
        ...opportunities[0],
        artifact: {
          ...opportunities[0].artifact,
          outreach_mode: 'automated_social',
          allowed_actions: ['auto_join', 'auto_post'],
        },
      }).hardFailures,
    ).toEqual(expect.arrayContaining(['consumer_automation_boundary_missing', 'unsafe_consumer_action']))
  })

  it('requires semantic, geography, liveness, usefulness, and noise reasons on adversarial results', () => {
    const adversarial = GTM_ARTIFACT_FIXTURES_V2.filter((row) => row.id.startsWith('gtm-q-v2-'))
    expect(adversarial).toHaveLength(7)
    for (const fixture of adversarial) expect(evaluateGtmArtifact(fixture).passed).toBe(true)

    const leakage = adversarial.find((row) => row.id === 'gtm-q-v2-query-intent-leakage')!
    const result = evaluateGtmArtifact({
      ...leakage,
      artifact: { ...leakage.artifact, disposition: 'deliver', quality_reasons: [] },
    })
    expect(result.passed).toBe(false)
    expect(result.hardFailures).toContain('wrong_disposition')
  })
})
