import { metroZipProof, ruleBasedFitScorer, type FitPlayInput } from '../research/qualify'

/* 2026-09-24 audit: every Twin Cities suburb dentist sat in review on location
 * because the play named the metro and the listing named its suburb. */

const metroPlay: FitPlayInput = {
  entityUnit: 'locations',
  geography: 'Minneapolis-Saint Paul metro, Minnesota',
  audience: 'Independent dental clinics in the Twin Cities metro',
  providerQuery: {
    locations: ['Minneapolis-Saint Paul, MN'],
    industries: ['Medical & Health Care'],
    company_keywords: ['dentist', 'dental clinic', 'family dental'],
    exclude_company_keywords: ['corporate dental', 'dental group'],
  },
  referenceTime: new Date('2026-09-11T16:56:00Z'),
}

function listing(city: string, address: string) {
  return {
    entity_kind: 'company' as const,
    identity: {
      name: 'Example Creek Dental',
      city,
      region: 'Minnesota',
      industry: 'Dentist',
      location: address,
      urls: ['https://www.google.com/maps/place/?q=place_id:TEST'],
      domain: 'examplecreekdental.com',
      provider_location: 'Hennepin County,Minnesota,United States',
    },
  }
}

const evidence = [{
  claim: '"Example Creek Dental" is listed on Google Maps as "Dentist" at the address shown.',
  source_url: 'https://www.google.com/maps/place/?q=place_id:TEST',
  observed_at: '2026-09-11T16:56:00Z',
  confidence: 0.9,
}]

describe('metro geography from the listing ZIP', () => {
  test('a suburb inside the metro passes location and the listing is accepted', () => {
    const fit = ruleBasedFitScorer.score(listing('Golden Valley', '5851 Duluth St, Golden Valley, MN 55422'), metroPlay, evidence)
    const location = fit.criteria?.find((row) => row.id === 'geography.location')
    expect(location?.status).toBe('pass')
    expect(location?.observed).toContain('ZIP 55422 is in the Minneapolis-Saint Paul metro')
    expect(fit.verdict).toBe('accepted')
  })

  test('a ZIP outside the metro is not proof', () => {
    expect(metroZipProof(['Minneapolis-Saint Paul, MN'], ['1 Main St, Hudson, WI 54016'])).toBeNull()
    const fit = ruleBasedFitScorer.score(listing('Rochester', '1 Main St, Rochester, MN 55901'), metroPlay, evidence)
    expect(fit.criteria?.find((row) => row.id === 'geography.location')?.status).not.toBe('pass')
  })

  test('a play that names a single city stays strict', () => {
    expect(metroZipProof(['Minneapolis, MN'], ['5851 Duluth St, Golden Valley, MN 55422'])).toBeNull()
    expect(metroZipProof(['Irvine, CA'], ['1 Main St, Irvine, CA 92618'])).toBeNull()
  })

  test('county and region names are metros too; street numbers are never read as ZIPs', () => {
    expect(metroZipProof(['Orange County, CA'], ['1 Main St, Irvine, CA 92618'])).toBe('ZIP 92618 is in Orange County')
    expect(metroZipProof(['Northern Virginia'], ['1 Main St, Reston, VA 20190'])).toBe('ZIP 20190 is in Northern Virginia')
    expect(metroZipProof(['Orange County, CA'], ['92618 Main St, Somewhere'])).toBeNull()
  })
})

describe('Google Maps listings and team size', () => {
  const sizedPlay: FitPlayInput = { ...metroPlay, providerQuery: { ...metroPlay.providerQuery, employee_ranges: ['1-10'] } }

  test('a listing that passes everything else is accepted with size to confirm later', () => {
    const fit = ruleBasedFitScorer.score(listing('Golden Valley', '5851 Duluth St, Golden Valley, MN 55422'), sizedPlay, evidence)
    expect(fit.verdict).toBe('accepted')
    expect(fit.unknowns).toContain('account.employee_range')
  })

  test('a row from another source is never accepted on unknown size without the play switch', () => {
    const row = listing('Golden Valley', '5851 Duluth St, Golden Valley, MN 55422')
    row.identity.urls = ['https://examplecreekdental.com']
    const fit = ruleBasedFitScorer.score(row, sizedPlay, evidence)
    expect(fit.verdict).not.toBe('accepted')
  })
})

describe('county plays from the listing ZIP (Census ZCTA-to-county file)', () => {
  const { countyZipProof, countyKey } = jest.requireActual('../research/county-zip') as typeof import('../research/county-zip')

  test('a suburb ZIP proves its own county, not a neighbouring one', () => {
    expect(countyZipProof(['Hennepin County, MN', 'Ramsey County, MN'], ['5851 Duluth St, Golden Valley, MN 55422'])).toBe('ZIP 55422 is in Hennepin County, MN')
    expect(countyZipProof(['Ramsey County, MN'], ['5851 Duluth St, Golden Valley, MN 55422'])).toBeNull()
  })

  test('the state disambiguates same-named counties; spelled-out states work', () => {
    expect(countyZipProof(['Orange County, California'], ['1 Main St, Irvine, CA 92618'])).toBe('ZIP 92618 is in Orange County, CA')
    expect(countyZipProof(['Orange County, FL'], ['1 Main St, Irvine, CA 92618'])).toBeNull()
  })

  test('only county-shaped expectations are read', () => {
    expect(countyKey('Minneapolis, MN')).toBeNull()
    expect(countyKey('Hennepin County, MN')).toBe('hennepin county|mn')
  })

  test('a county play accepts a suburb listing end to end', () => {
    const countyPlay: FitPlayInput = { ...metroPlay, geography: 'Hennepin County, Minnesota', providerQuery: { ...metroPlay.providerQuery, locations: ['Hennepin County, MN', 'Ramsey County, MN'] } }
    const fit = ruleBasedFitScorer.score(listing('Golden Valley', '5851 Duluth St, Golden Valley, MN 55422'), countyPlay, evidence)
    expect(fit.criteria?.find((row) => row.id === 'geography.location')?.status).toBe('pass')
    expect(fit.verdict).toBe('accepted')
  })
})
