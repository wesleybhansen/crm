import { GtmCandidate, GtmCandidateMatch, GtmContactPoint, GtmEvidence, GtmPlay } from '../../data/entities'
import { buildShortlist, rankScore, shortlistDedupeKey } from '../research/shortlist'
import { FakeEm } from './support/fake-em'
import { ORG, TENANT, seedPlay, seedRun } from './support/campaign-fixtures'

type Row = {
  name: string
  kind?: 'company' | 'person' | 'opportunity'
  status: string
  score?: number
  identity?: Record<string, unknown>
  judge?: Record<string, unknown>
  email?: boolean
  createdAt?: Date
  runIndex?: number
}

async function seed(em: FakeEm, rows: Row[], options: { outreachMode?: string; runs?: number } = {}) {
  const play = await seedPlay(em)
  const playRow = (await em.find(GtmPlay, { id: play.id }))[0]
  playRow.outreachMode = options.outreachMode ?? 'automated_email'
  const runs = []
  for (let i = 0; i < (options.runs ?? 1); i += 1) runs.push(await seedRun(em, play))
  const out: Array<{ candidate: GtmCandidate; match: GtmCandidateMatch }> = []
  for (const [index, row] of rows.entries()) {
    const run = runs[row.runIndex ?? 0]
    const candidate = em.create(GtmCandidate, {
      organizationId: ORG, tenantId: TENANT, researchRunId: run.id, workspaceId: run.workspaceId,
      entityKind: row.kind ?? 'company',
      identity: { name: row.name, ...(row.identity ?? {}) },
      dedupeKey: `sl-${index}-${row.name}`, fitStatus: row.status,
    })
    em.persist(candidate)
    const match = em.create(GtmCandidateMatch, {
      organizationId: ORG, tenantId: TENANT, workspaceId: run.workspaceId, playId: play.id, researchRunId: run.id,
      candidateId: candidate.id, fitStatus: row.status, fitScore: String(row.score ?? 70),
      qualification: { reason: 'meets_fit_rules', ...(row.judge ? { judge: row.judge } : {}) },
      ...(row.createdAt ? { createdAt: row.createdAt } : {}),
    })
    em.persist(match)
    em.persist(em.create(GtmEvidence, {
      organizationId: ORG, tenantId: TENANT, candidateId: candidate.id, researchRunId: run.id,
      claim: `${row.name} is listed on Google Maps.`, sourceUrl: 'https://www.google.com/maps/place/?q=place_id:X',
      confidence: '0.9', observedAt: new Date('2026-09-25T01:00:00Z'),
    }))
    if (row.email) {
      em.persist(em.create(GtmContactPoint, {
        organizationId: ORG, tenantId: TENANT, candidateId: candidate.id, channel: 'email',
        value: `owner${index}@fixture.example`, verificationState: 'verified',
      }))
    }
    out.push({ candidate, match })
  }
  await em.flush()
  return { play, runs, rows: out }
}

describe('shortlist rank score', () => {
  test('rule fit, the AI rating, acceptance and contactability all move the score; bands follow it', () => {
    const base = { fitScore: 80, fitStatus: 'review' as const, judged: true, judgeFit: 'strong', namedPerson: false, contactRoute: true }
    expect(rankScore(base)).toEqual({ score: 75, confidence: 'medium' })
    expect(rankScore({ ...base, fitStatus: 'accepted' })).toEqual({ score: 85, confidence: 'high' })
    expect(rankScore({ ...base, judgeFit: 'possible' }).score).toBe(45)
    expect(rankScore({ ...base, judged: false, judgeFit: null }).score).toBe(50)
    expect(rankScore({ ...base, namedPerson: true, fitStatus: 'accepted', fitScore: 100 }).score).toBe(100)
    expect(rankScore({ ...base, fitScore: Number.NaN, judgeFit: 'possible', contactRoute: false })).toEqual({ score: 0, confidence: 'low' })

  })

  test('a keep from the lead check that predates fit ratings scores as a likely fit, not as nothing', () => {
    // The 2026-09-25 live shape: accepted on exact keywords, kept by lead-check-v1 before it rated fits.
    const legacyAccepted = { fitScore: 100, fitStatus: 'accepted' as const, judged: true, judgeFit: null, namedPerson: false, contactRoute: true }
    expect(rankScore(legacyAccepted)).toEqual({ score: 80, confidence: 'high' })
    // It outranks a rescued near miss rated strong on a weaker rule score (the live 78)...
    const rescuedStrong = { fitScore: 56, fitStatus: 'review' as const, judged: true, judgeFit: 'strong', namedPerson: false, contactRoute: true }
    expect(rankScore(legacyAccepted).score).toBeGreaterThan(rankScore(rescuedStrong).score)
    // ...and never outranks the same row rated strong, nor gains over an explicit possible.
    expect(rankScore({ ...legacyAccepted, judgeFit: 'strong' }).score).toBeGreaterThan(rankScore(legacyAccepted).score)
    expect(rankScore({ ...legacyAccepted, judgeFit: 'possible' }).score).toBeLessThan(rankScore(legacyAccepted).score)
  })

  test('the same business from two lanes is one prospect', () => {
    expect(shortlistDedupeKey({ name: 'A', domain: 'WWW.Foster.com/contact' })).toBe(shortlistDedupeKey({ name: 'Foster Plumbing', domain: 'foster.com' }))
    expect(shortlistDedupeKey({ name: 'Peak Refrigeration', city: 'Denver' })).toBe(shortlistDedupeKey({ name: 'peak  refrigeration!', city: 'denver' }))
    expect(shortlistDedupeKey({ name: 'Peak Refrigeration', city: 'Denver' })).not.toBe(shortlistDedupeKey({ name: 'Peak Refrigeration', city: 'Boulder' }))
  })
})

describe('buildShortlist', () => {
  test('ranks the runs\' current accepted/review rows, drops rejected, non-US and duplicates, and never returns an email value', async () => {
    const em = new FakeEm()
    const { runs, rows } = await seed(em, [
      { name: 'Commercial Mechanical Co', status: 'review', score: 90, judge: { verdict: 'keep', fit: 'strong', note: 'commercial mechanical subcontractor' }, identity: { domain: 'cmc.example', phone: '+1 303-555-0100', website: 'https://cmc.example/', city: 'Denver', country_code: 'US', location: '1 Main St, Denver, CO' }, email: true },
      { name: 'CMC duplicate listing', status: 'review', score: 60, identity: { domain: 'cmc.example' } },
      { name: 'Accepted Plumbing', status: 'accepted', score: 100, judge: { verdict: 'keep', fit: 'likely' } },
      { name: 'Withdrawn by the check', status: 'rejected', score: 99 },
      { name: 'Toronto Mechanical', status: 'review', score: 95, identity: { country_code: 'CA' } },
      { name: 'Unchecked Review', status: 'review', score: 70 },
    ])
    const result = await buildShortlist(em, { organizationId: ORG, tenantId: TENANT }, { runIds: [runs[0].id] })
    expect(result.pool).toEqual({ viable: 3, accepted: 1, review: 2, contactable: 1 })
    expect(result.shortlist.map((row) => [row.rank, row.name])).toEqual([
      [1, 'Commercial Mechanical Co'],
      [2, 'Accepted Plumbing'],
      [3, 'Unchecked Review'],
    ])
    const [top] = result.shortlist
    expect(top).toMatchObject({
      candidate_id: rows[0].candidate.id,
      match_id: rows[0].match.id,
      run_id: runs[0].id,
      entity_kind: 'company',
      fit_status: 'review',
      confidence: 'high',
      why: 'commercial mechanical subcontractor',
      location: '1 Main St, Denver, CO',
      contact: { person_name: null, website: 'https://cmc.example/', phone: '+1 303-555-0100', has_email: true },
    })
    expect(top.evidence).toEqual([{ claim: 'Commercial Mechanical Co is listed on Google Maps.', source_url: 'https://www.google.com/maps/place/?q=place_id:X' }])
    expect(JSON.stringify(result)).not.toContain('@fixture.example')
    // A reason, never a raw criterion id.
    expect(result.shortlist[2].why).toBe('Meets every fit rule')
  })

  test('limit caps the list, not the pool; a manual-only play never reports an email', async () => {
    const em = new FakeEm()
    const { runs } = await seed(em, Array.from({ length: 5 }, (_, i) => ({ name: `Co ${i}`, status: 'review', email: true })), { outreachMode: 'manual_only' })
    const result = await buildShortlist(em, { organizationId: ORG, tenantId: TENANT }, { runIds: [runs[0].id], limit: 2 })
    expect(result.shortlist).toHaveLength(2)
    expect(result.pool.viable).toBe(5)
    expect(result.shortlist.every((row) => row.contact.has_email === false)).toBe(true)
  })

  test('a later run\'s verdict for the same candidate supersedes an earlier one', async () => {
    const em = new FakeEm()
    const { runs, rows } = await seed(em, [{ name: 'Peak Refrigeration', status: 'review', createdAt: new Date('2026-09-25T01:00:00Z') }], { runs: 2 })
    em.persist(em.create(GtmCandidateMatch, {
      organizationId: ORG, tenantId: TENANT, workspaceId: runs[1].workspaceId, playId: rows[0].match.playId, researchRunId: runs[1].id,
      candidateId: rows[0].candidate.id, fitStatus: 'rejected', fitScore: '10', rejectReason: 'ai_check_not_the_audience',
      createdAt: new Date('2026-09-25T02:00:00Z'),
    }))
    await em.flush()
    const result = await buildShortlist(em, { organizationId: ORG, tenantId: TENANT }, { runIds: runs.map((r) => r.id) })
    expect(result.pool.viable).toBe(0)
    expect(result.shortlist).toEqual([])
  })

  test('another org\'s rows and unknown runs are never read', async () => {
    const em = new FakeEm()
    const { runs } = await seed(em, [{ name: 'Mine', status: 'review' }])
    const foreign = await buildShortlist(em, { organizationId: '99999999-0000-4000-8000-000000000000', tenantId: TENANT }, { runIds: [runs[0].id] })
    expect(foreign.shortlist).toEqual([])
    const none = await buildShortlist(em, { organizationId: ORG, tenantId: TENANT }, { runIds: [] })
    expect(none.pool.viable).toBe(0)
  })
})
