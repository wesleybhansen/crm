import { GtmCandidate, GtmCandidateMatch, GtmContactPoint, GtmEvidence, GtmPlay } from '../../data/entities'
import { buildShortlist, rankScore, reputationScore, shortlistDedupeKey } from '../research/shortlist'
import { FakeEm } from './support/fake-em'
import { ORG, TENANT, seedPlay, seedRun } from './support/campaign-fixtures'

type Row = {
  name: string
  kind?: 'company' | 'person' | 'opportunity'
  status: string
  score?: number
  identity?: Record<string, unknown>
  judge?: Record<string, unknown>
  verification?: Record<string, unknown>
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
      qualification: { reason: 'meets_fit_rules', ...(row.judge ? { judge: row.judge } : {}), ...(row.verification ? { verification: row.verification } : {}) },
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
      // Not yet checked on its website: ordered, but no earned label.
      confidence: 'low',
      verified: false,
      why: 'commercial mechanical subcontractor',
      location: '1 Main St, Denver, CO',
      contact: { person_name: null, website: 'https://cmc.example/', phone: '+1 303-555-0100', has_email: true },
    })
    expect(top.evidence).toEqual([{ claim: 'Commercial Mechanical Co is listed on Google Maps.', source_url: 'https://www.google.com/maps/place/?q=place_id:X' }])
    expect(JSON.stringify(result)).not.toContain('@fixture.example')
    // A reason, never a raw criterion id.
    expect(result.shortlist[2].why).toBe('Meets every fit rule')
  })

  test('site-checked rows rank first on their earned grade; the site phone and quotes replace the listing\'s', async () => {
    const em = new FakeEm()
    const verification = (grade: number, extra: Record<string, unknown> = {}) => ({
      version: 'site-check-v1', complete: true, excluded: false, grade, summary: `graded ${grade}`,
      checks: [{ text: 'Independently owned', hard: true, status: 'pass', quote: 'Owned by Dr. Ruiz since 2024' }],
      site: { pages: ['https://site.example/about'] },
      contact: { phone: '+16025550142', phone_source: 'site', person_name: 'Dr. Ana Ruiz', person_title: 'Owner' },
      ...extra,
    })
    const { runs } = await seed(em, [
      { name: 'Unchecked but high rule score', status: 'accepted', score: 100, judge: { verdict: 'keep', fit: 'strong' } },
      { name: 'Checked 72', status: 'review', score: 60, verification: verification(72) },
      { name: 'Checked 91', status: 'review', score: 40, identity: { phone: '+1 928-492-3378' }, verification: verification(91) },
      { name: 'Checked 72 with less confirmed', status: 'review', score: 60, verification: verification(72, { checks: [], contact: {} }) },
      { name: 'Incomplete check', status: 'review', score: 65, verification: { ...verification(99), complete: false } },
    ])
    const result = await buildShortlist(em, { organizationId: ORG, tenantId: TENANT }, { runIds: [runs[0].id] })
    expect(result.shortlist.map((row) => [row.name, row.verified, row.confidence, row.score])).toEqual([
      ['Checked 91', true, 'high', 91],
      ['Checked 72', true, 'medium', 72],
      ['Checked 72 with less confirmed', true, 'medium', 72],
      ['Unchecked but high rule score', false, 'low', expect.any(Number)],
      ['Incomplete check', false, 'low', expect.any(Number)],
    ])
    expect(result.unverified).toBe(2)
    const top = result.shortlist[0]
    expect(top.contact).toEqual(expect.objectContaining({ phone: '+16025550142', person_name: 'Dr. Ana Ruiz', title: 'Owner' }))
    expect(top.phone_source).toBe('site')
    expect(top.evidence[0]).toEqual({ claim: 'Independently owned. Their website: "Owned by Dr. Ruiz since 2024"', source_url: 'https://site.example/about' })
    expect(top.why).toBe('graded 91')
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

describe('ties between equally checked prospects break on real signals (Denver dental pool, 9 at 95)', () => {
  const checks = [
    { text: 'Independently owned', hard: true, status: 'pass', quote: 'Owned by the doctor since 2011' },
    { text: '1 to 3 dentists', hard: true, status: 'pass', quote: 'Our two dentists' },
    { text: 'General dentistry', hard: true, status: 'pass', quote: 'Family and general dentistry' },
    { text: 'Uses Dentrix or Eaglesoft', hard: false, status: 'unknown', quote: null },
  ]
  // The nine rows exactly as the live run (session 96327835) stored them:
  // phone source, page count, accepted/review; no rating was captured then.
  const live: Array<[string, string, number, 'accepted' | 'review']> = [
    ['Brilliant Family Dentistry', 'site_and_listing', 1, 'review'],
    ['Cherry Creek North Family Dentistry', 'site_and_listing', 3, 'review'],
    ['DeWitt Dental Associates', 'site_and_listing', 3, 'review'],
    ['Downing Street Dental', 'site_and_listing', 2, 'review'],
    ['EC Family & Cosmetic Dentistry', 'site_and_listing', 3, 'review'],
    ['Lodo Dental', 'site_and_listing', 3, 'review'],
    ['Mollner Dentistry', 'site_and_listing', 3, 'review'],
    ['Washington Park Family Dental', 'site_and_listing', 3, 'review'],
    ['Seto Family Dentistry', 'site', 3, 'accepted'],
  ]
  const verification = (phoneSource: string, pages: number) => ({
    version: 'site-check-v1', complete: true, excluded: false, grade: 95, summary: 'Independent general practice',
    checks, ownership: { status: 'independent', evidence: 'Owned by the doctor since 2011' },
    site: { pages: Array.from({ length: pages }, (_, i) => `https://x.example/${i}`) },
    contact: { phone: '+13035550100', phone_source: phoneSource, person_name: 'Dr. Owner', person_title: 'Owner' },
  })

  test('as stored today: signals order most of them, and only a genuine tie is flagged', async () => {
    const em = new FakeEm()
    const { runs } = await seed(em, live.map(([name, phone, pages, status]) => ({ name, status, score: 90, verification: verification(phone, pages) })))
    const result = await buildShortlist(em, { organizationId: ORG, tenantId: TENANT }, { runIds: [runs[0].id] })
    const order = result.shortlist.map((r) => r.name)
    // Six that match on every signal stay A to Z, and say so.
    expect(order.slice(0, 6)).toEqual(['Cherry Creek North Family Dentistry', 'DeWitt Dental Associates', 'EC Family & Cosmetic Dentistry', 'Lodo Dental', 'Mollner Dentistry', 'Washington Park Family Dental'])
    expect(result.shortlist.slice(0, 6).every((r) => r.tied)).toBe(true)
    // Fewer pages read, then a phone only from the site rather than confirmed on both.
    expect(order.slice(6)).toEqual(['Downing Street Dental', 'Brilliant Family Dentistry', 'Seto Family Dentistry'])
    expect(result.shortlist.slice(6).every((r) => !r.tied)).toBe(true)
    expect(result.shortlist[5].rank_note).toMatch(/about or team pages read/)
    expect(result.shortlist[7].rank_note).toMatch(/phone number confirmed on their website/)
    expect(result.shortlist[0].rank_reasons).toEqual(expect.arrayContaining(['Independent ownership stated on their website', 'Phone number confirmed on their website']))
  })

  test('with the Google rating captured (every Maps row from now on) and coordinates, nothing is left to the alphabet', async () => {
    const em = new FakeEm()
    const ratings: Record<string, [number, number, number, number]> = {
      'Cherry Creek North Family Dentistry': [4.9, 412, 39.719, -104.955],
      'DeWitt Dental Associates': [4.8, 96, 39.717, -104.953],
      'EC Family & Cosmetic Dentistry': [5.0, 9, 39.74, -104.99],
      'Lodo Dental': [4.9, 220, 39.753, -105.0],
      'Mollner Dentistry': [4.7, 180, 39.75, -104.93],
      'Washington Park Family Dental': [4.9, 220, 39.64, -104.97],
    }
    const { runs } = await seed(em, live.slice(0, 8).filter(([n]) => ratings[n]).map(([name, phone, pages, status]) => ({
      name, status, score: 90, verification: verification(phone, pages),
      identity: { rating: ratings[name][0], review_count: ratings[name][1], latitude: ratings[name][2], longitude: ratings[name][3] },
    })))
    const result = await buildShortlist(em, { organizationId: ORG, tenantId: TENANT }, { runIds: [runs[0].id] })
    expect(result.shortlist.map((r) => r.name)).toEqual([
      'Cherry Creek North Family Dentistry', // 4.9 from 412
      'Lodo Dental', // 4.9 from 220, closer to the middle than Washington Park
      'Washington Park Family Dental',
      'Mollner Dentistry', // 4.7 from 180
      'DeWitt Dental Associates', // 4.8 from 96
      'EC Family & Cosmetic Dentistry', // 5.0 from only 9 reviews
    ])
    expect(result.shortlist.some((r) => r.tied)).toBe(false)
    expect(result.shortlist[0].rank_note).toMatch(/4\.9 stars from 412 Google reviews/)
    expect(result.shortlist[1].rank_note).toMatch(/close to the middle of your area/)
    expect(result.shortlist[0].rank_reasons).toContain('4.9 stars from 412 Google reviews')
  })

  test('reputation weighs the rating by the reviews behind it', () => {
    expect(reputationScore(5.0, 9)).toBeLessThan(reputationScore(4.7, 180))
    expect(reputationScore(null, 100)).toBe(0)
    expect(reputationScore(4.9, 0)).toBe(0)
  })
})
