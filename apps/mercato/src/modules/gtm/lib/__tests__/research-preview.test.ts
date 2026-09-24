import { FakeEm } from './support/fake-em'
import { FixtureLedger } from '../credits/ledger'
import { creditsForUnits } from '../credits/markup'
import { fixtureSourceDescriptor } from '../adapters/fixture'
import type { AdapterResult, Candidate, SourceAdapter, SourceSearchPlan } from '../adapters/types'
import {
  choosePreviewLane,
  previewLane,
  PREVIEW_FETCH_CAP,
  PREVIEW_ROW_CAP,
  quotePreviewLane,
  shapePreviewRow,
  GtmPreviewError,
  type PreviewLaneDeps,
} from '../research/preview'
import type { SourcePlanBatch, SourcePlanSuccess } from '../research/plan'
import { GtmProviderOperation, GtmResearchRun, GtmCandidate } from '../../data/entities'

/*
 * Dry-lane previews. No provider is ever called here: every adapter is a fake
 * that returns fixed rows, and the ledger is the in-memory FixtureLedger. The
 * contract under test is that a preview spends like a run, reports like a run,
 * and writes NOTHING a run would write.
 */

const ORG = '11111111-1111-4111-8111-111111111111'
const TENANT = '22222222-2222-4222-8222-222222222222'
const WORKSPACE = '33333333-3333-4333-8333-333333333333'
const PLAY_ID = '44444444-4444-4444-8444-444444444444'
const NOLI_ORG = '66666666-6666-4666-8666-666666666666'
const NOLI_USER = '77777777-7777-4777-8777-777777777777'
const MARKUP = 2

function row(name: string, url: string | null): Candidate {
  return {
    entity_kind: 'company',
    identity: { name, company: name, title: 'Owner', urls: url ? [url] : [], platform: 'Google Maps' },
    evidence: [
      {
        claim: `${name} lists a second location opened this year`,
        source_url: url,
        observed_at: '2026-09-16T08:00:00.000Z',
        confidence: 0.8,
      },
    ],
  }
}

function fakeAdapter(
  adapterId: string,
  result: AdapterResult<Candidate[]>,
  options: { providerUnits?: number; payOnFound?: boolean } = {},
): SourceAdapter & { search: jest.Mock } {
  const providerUnits = options.providerUnits ?? 1
  return {
    descriptor: {
      ...fixtureSourceDescriptor,
      adapter_id: adapterId,
      cost_model: { ...fixtureSourceDescriptor.cost_model, pay_on_found: options.payOnFound ?? false },
    },
    quote: (plan) => ({
      max_candidates: plan.max_candidates,
      provider_units: providerUnits,
      billable_unit: 'search',
      expected_candidates: { low: 0, high: plan.max_candidates, basis: 'contract' },
      quoted_credits_per_unit: 100,
      estimated_credits_before_markup: 100 * providerUnits,
    }),
    search: jest.fn(async (_plan: SourceSearchPlan) => result),
  }
}

function batch(adapterId: string, overrides: Partial<SourcePlanBatch> = {}): SourcePlanBatch {
  return {
    adapter_id: adapterId,
    capability: { signal_kind: 'hiring_activity', entity_unit: 'companies', entity_kind: 'company', geography: 'US' },
    estimatedUnits: 10,
    providerUnits: 10,
    billableUnit: 'search',
    maxCandidates: 20,
    expectedCandidates: { low: 0, high: 20, basis: 'contract' },
    quotedCreditsPerUnit: 100,
    estimatedCredits: creditsForUnits(10, 100, MARKUP),
    priceVersion: 'v1',
    termsVersion: 't1',
    descriptorHash: 'hash',
    providerQuery: { keyword: 'dentist' },
    adaptiveOrder: 0,
    stopWhenTargetAccepted: true,
    ...overrides,
  }
}

function plan(batches: SourcePlanBatch[]): SourcePlanSuccess {
  return { adapterPlan: batches, query: 'independent dentists austin' } as unknown as SourcePlanSuccess
}

function deps(
  em: FakeEm,
  ledger: FixtureLedger,
  adapters: Record<string, SourceAdapter>,
  batches: SourcePlanBatch[],
  slot = 1,
): PreviewLaneDeps {
  return {
    em,
    ledger,
    adapters,
    plan: plan(batches),
    organizationId: ORG,
    tenantId: TENANT,
    noliOrgId: NOLI_ORG,
    noliUserId: NOLI_USER,
    workspaceId: WORKSPACE,
    playId: PLAY_ID,
    claim: { day: '2026-09-16', slot },
    markupMultiplier: MARKUP,
    now: () => new Date('2026-09-16T09:00:00.000Z'),
  }
}

describe('choosePreviewLane', () => {
  it('takes the first lane in the plan adaptive order', () => {
    const chosen = choosePreviewLane(plan([
      batch('second', { adaptiveOrder: 2 }),
      batch('first', { adaptiveOrder: 0 }),
      batch('third', { adaptiveOrder: 5 }),
    ]))
    expect(chosen?.adapter_id).toBe('first')
  })

  it('skips a lane quoted at zero candidates and reports no lane at all', () => {
    expect(choosePreviewLane(plan([batch('empty', { maxCandidates: 0 })]))).toBeNull()
    expect(choosePreviewLane(plan([]))).toBeNull()
  })
})

describe('quotePreviewLane', () => {
  it('prices the sample from the adapter own quote, capped at three rows', () => {
    const adapter = fakeAdapter('maps', { status: 'ok', data: [], receipt: {}, cost_units: 1 })
    const quote = quotePreviewLane(adapter, batch('maps'), 'dentists', MARKUP)
    expect(quote.rows).toBe(PREVIEW_ROW_CAP)
    expect(quote.adapterId).toBe('maps')
    expect(quote.estimatedCredits).toBe(creditsForUnits(1, 100, MARKUP))
    expect(quote.estimatedUsd).toBeGreaterThan(0)
  })

  it('never quotes the sample above the full lane it samples', () => {
    const adapter = fakeAdapter('maps', { status: 'ok', data: [], receipt: {}, cost_units: 1 }, { providerUnits: 500 })
    const quote = quotePreviewLane(adapter, batch('maps', { estimatedCredits: 50 }), 'dentists', MARKUP)
    expect(quote.estimatedCredits).toBe(50)
  })

  it('samples fewer than three rows when the lane itself is smaller', () => {
    const adapter = fakeAdapter('maps', { status: 'ok', data: [], receipt: {}, cost_units: 1 })
    expect(quotePreviewLane(adapter, batch('maps', { maxCandidates: 2 }), 'x', MARKUP).rows).toBe(2)
  })
})

describe('shapePreviewRow', () => {
  const at = new Date('2026-09-16T09:00:00.000Z')

  it('records the source and the observation time on every row', () => {
    const shaped = shapePreviewRow(row('Smile Co', 'https://example.com/smile'), 'maps', at)
    expect(shaped).toMatchObject({
      entity_kind: 'company',
      title: 'Smile Co',
      subtitle: 'Owner at Smile Co',
      source: 'Google Maps',
      source_url: 'https://example.com/smile',
      observed_at: '2026-09-16T08:00:00.000Z',
    })
    expect(shaped.why).toContain('second location')
  })

  it('never invents a source url and falls back to the adapter id for the source', () => {
    const bare: Candidate = { entity_kind: 'company', identity: { name: 'No Links' }, evidence: [] }
    const shaped = shapePreviewRow(bare, 'maps', at)
    expect(shaped.source_url).toBeNull()
    expect(shaped.source).toBe('maps')
    expect(shaped.why).toBeNull()
    expect(shaped.observed_at).toBe(at.toISOString())
  })

  it('rejects a non-http url rather than rendering a javascript: link', () => {
    const hostile: Candidate = {
      entity_kind: 'company',
      identity: { name: 'Hostile', urls: ['javascript:alert(1)'] },
      evidence: [],
    }
    expect(shapePreviewRow(hostile, 'maps', at).source_url).toBeNull()
  })

  it('reads an opportunity by its audience description and platform', () => {
    const opportunity: Candidate = {
      entity_kind: 'opportunity',
      identity: {
        name: 'r/Austin',
        audience_description: 'Homeowners planning a move in Austin',
        platform: 'Reddit',
        location: 'Austin, TX',
      },
      evidence: [{ claim: 'Recurring move questions', source_url: 'https://reddit.com/r/Austin', observed_at: '2026-09-15T00:00:00.000Z', confidence: 0.6 }],
    }
    expect(shapePreviewRow(opportunity, 'reddit', at)).toMatchObject({
      title: 'Homeowners planning a move in Austin',
      subtitle: 'Reddit · Austin, TX',
      source: 'Reddit',
    })
  })
})

describe('previewLane', () => {
  it('returns at most three rows and writes no run, candidate or match', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 1_000_000 })
    const adapter = fakeAdapter('maps', {
      status: 'ok',
      data: [row('A', 'https://a.test'), row('B', 'https://b.test'), row('C', 'https://c.test'), row('D', 'https://d.test')],
      receipt: { provider_request_id: 'req-1' },
      cost_units: 1,
    })

    const result = await previewLane(deps(em, ledger, { maps: adapter }, [batch('maps')]))

    expect(result.status).toBe('ok')
    expect(result.rows).toHaveLength(PREVIEW_ROW_CAP)
    expect(result.rows.map((r) => r.title)).toEqual(['A', 'B', 'C'])
    expect(adapter.search).toHaveBeenCalledTimes(1)
    expect(adapter.search.mock.calls[0][0].max_candidates).toBe(PREVIEW_FETCH_CAP)
    // Nothing a run would persist.
    expect(em.table(GtmResearchRun)).toHaveLength(0)
    expect(em.table(GtmCandidate)).toHaveLength(0)
  })

  it('shows the best rows the fit rules accept, never raw provider order', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 1_000_000 })
    const adapter = fakeAdapter('maps', {
      status: 'ok',
      data: ['Junk', 'Good', 'Best', 'Okay'].map((name) => row(name, `https://${name.toLowerCase()}.test`)),
      receipt: {},
      cost_units: 1,
    })
    const scores: Record<string, number> = { Junk: 10, Good: 70, Best: 95, Okay: 55 }
    const scorer = {
      score: (candidate: Pick<Candidate, 'entity_kind' | 'identity'>) => {
        const fitScore = scores[String(candidate.identity.name)]
        return {
          fitScore,
          verdict: fitScore < 40 ? 'rejected' as const : 'accepted' as const,
          reason: 'test',
          version: 'fit-v7' as const,
          breakdown: { identity: 0, account: 0, persona: 0, geography: 0, evidence: 0 },
          unknowns: [],
          contradictions: [],
        }
      },
    }
    const result = await previewLane({ ...deps(em, ledger, { maps: adapter }, [batch('maps')]), fitPlay: { audience: 'x' }, scorer: scorer as never })
    expect(result.rows.map((r) => r.title)).toEqual(['Best', 'Good', 'Okay'])
  })

  it('says so plainly when the sample found rows but none fit', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 1_000_000 })
    const adapter = fakeAdapter('maps', { status: 'ok', data: [row('A', 'https://a.test'), row('B', 'https://b.test')], receipt: {}, cost_units: 1 })
    const rejectAll = { score: () => ({ fitScore: 5, verdict: 'rejected' as const, reason: 'test', version: 'fit-v7' as const, breakdown: { identity: 0, account: 0, persona: 0, geography: 0, evidence: 0 }, unknowns: [], contradictions: [] }) }
    const result = await previewLane({ ...deps(em, ledger, { maps: adapter }, [batch('maps')]), fitPlay: { audience: 'x' }, scorer: rejectAll as never })
    expect(result.status).toBe('no_result')
    expect(result.rows).toHaveLength(0)
    expect(result.note).toContain('found 2 results, but none fit this play')
  })

  it('reserves, starts and settles through the ledger like a run does', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 1_000_000 })
    const adapter = fakeAdapter('maps', { status: 'ok', data: [row('A', 'https://a.test')], receipt: {}, cost_units: 1 })

    const result = await previewLane(deps(em, ledger, { maps: adapter }, [batch('maps')]))

    expect(result.chargedCredits).toBe(creditsForUnits(1, 100, MARKUP))
    const operation = ledger.getOperation(result.providerOperationId!)
    expect(operation?.status).toBe('charged')
    expect(operation?.chargedCredits).toBe(result.chargedCredits)
    expect(operation?.fingerprint).toMatchObject({ gtm_preview: true, play_id: PLAY_ID, preview_slot: 1 })
  })

  it('leaves a shadow provider operation with no research run attached', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 1_000_000 })
    const adapter = fakeAdapter('maps', { status: 'ok', data: [row('A', null)], receipt: {}, cost_units: 1 })

    const result = await previewLane(deps(em, ledger, { maps: adapter }, [batch('maps')]))

    const shadows = em.table(GtmProviderOperation)
    expect(shadows).toHaveLength(1)
    expect(shadows[0].researchRunId ?? null).toBeNull()
    expect(shadows[0].noliCoreOperationId).toBe(result.providerOperationId)
    expect(shadows[0].localStatusMirror).toBe('charged')
    const receipt = shadows[0].receipt as Record<string, Record<string, unknown>>
    expect(receipt.gtm_preview).toMatchObject({ play_id: PLAY_ID, adapter_status: 'ok', output_count: 1 })
    // The provider payload itself is not retained: a preview is never
    // materialized into candidates, so keeping the rows would serve nothing.
    expect(JSON.stringify(receipt)).not.toContain('https://a.test')
  })

  it('a repeat of the same claimed slot never calls the provider twice', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 1_000_000 })
    const adapter = fakeAdapter('maps', { status: 'ok', data: [row('A', null)], receipt: {}, cost_units: 1 })
    const first = deps(em, ledger, { maps: adapter }, [batch('maps')], 1)

    await previewLane(first)
    const again = await previewLane(deps(em, ledger, { maps: adapter }, [batch('maps')], 1))

    expect(adapter.search).toHaveBeenCalledTimes(1)
    expect(again.status).toBe('ambiguous')
    expect(again.reconciliationRequired).toBe(true)
    expect(again.rows).toHaveLength(0)
  })

  it('says so honestly when the source returned nothing', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 1_000_000 })
    const adapter = fakeAdapter('maps', { status: 'no_result', data: [], receipt: {}, cost_units: 0 }, { payOnFound: true })

    const result = await previewLane(deps(em, ledger, { maps: adapter }, [batch('maps')]))

    expect(result.status).toBe('no_result')
    expect(result.rows).toHaveLength(0)
    expect(result.chargedCredits).toBe(0)
    expect(result.note).toContain('A full run searches more sources')
    expect(ledger.getOperation(result.providerOperationId!)?.status).toBe('refunded')
  })

  it('parks an ambiguous provider outcome and never retries it', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 1_000_000 })
    const adapter = fakeAdapter('maps', { status: 'ambiguous', data: null, receipt: {}, cost_units: null })

    const result = await previewLane(deps(em, ledger, { maps: adapter }, [batch('maps')]))

    expect(result.status).toBe('ambiguous')
    expect(result.reconciliationRequired).toBe(true)
    expect(result.note).toContain('parked for reconciliation')
    expect(ledger.getOperation(result.providerOperationId!)?.status).toBe('reconciliation_required')
    expect(adapter.search).toHaveBeenCalledTimes(1)
  })

  it('treats a completed call with no final cost as an unknown charge, never zero', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 1_000_000 })
    const adapter = fakeAdapter('maps', { status: 'ok', data: [row('A', null)], receipt: {}, cost_units: null })

    const result = await previewLane(deps(em, ledger, { maps: adapter }, [batch('maps')]))

    expect(result.status).toBe('ambiguous')
    expect(result.chargedCredits).toBe(0)
    expect(ledger.getOperation(result.providerOperationId!)?.status).toBe('reconciliation_required')
  })

  it('refuses before any spend when no lane can be sampled or the adapter is gone', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 1_000_000 })
    await expect(previewLane(deps(em, ledger, {}, []))).rejects.toBeInstanceOf(GtmPreviewError)
    await expect(previewLane(deps(em, ledger, {}, [batch('maps')]))).rejects.toMatchObject({
      code: 'adapter_unavailable',
    })
    expect(em.table(GtmProviderOperation)).toHaveLength(0)
  })

  it('refuses when the workspace cannot afford the sample, without calling the provider', async () => {
    const em = new FakeEm()
    const ledger = new FixtureLedger({ poolBalance: 1 })
    const adapter = fakeAdapter('maps', { status: 'ok', data: [row('A', null)], receipt: {}, cost_units: 1 })

    await expect(previewLane(deps(em, ledger, { maps: adapter }, [batch('maps')]))).rejects.toMatchObject({
      code: 'insufficient_credits',
    })
    expect(adapter.search).not.toHaveBeenCalled()
  })
})
