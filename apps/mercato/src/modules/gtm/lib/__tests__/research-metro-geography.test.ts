import { metroZipProof, ruleBasedFitScorer, statesNamed, type FitPlayInput } from '../research/qualify'

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

describe('the play geography and country-wide plays', () => {
  const phoenixListing = {
    entity_kind: 'company' as const,
    identity: {
      name: 'Example Contractor', industry: 'General contractor', location: '227 S Smith Rd #103, Tempe, AZ 85288',
      urls: ['https://www.google.com/maps/place/?q=place_id:TEST'], provider_location: 'Phoenix,Arizona,United States',
    },
  }
  const base = { entityUnit: 'locations', audience: 'General contractors', referenceTime: new Date('2026-09-11T00:00:00Z') }

  test('a "Phoenix metro" play accepts a Tempe listing even when the provider query names only Phoenix', () => {
    const fit = ruleBasedFitScorer.score(phoenixListing, { ...base, geography: 'Phoenix metro, Arizona', providerQuery: { locations: ['Phoenix, Arizona'], company_keywords: ['general contractor'] } }, evidence)
    expect(fit.criteria?.find((row) => row.id === 'geography.location')?.status).toBe('pass')
  })

  test('a plain "Phoenix, Arizona" play stays a city play', () => {
    const fit = ruleBasedFitScorer.score(phoenixListing, { ...base, geography: 'Phoenix, Arizona', providerQuery: { locations: ['Phoenix, Arizona'], company_keywords: ['general contractor'] } }, evidence)
    expect(fit.criteria?.find((row) => row.id === 'geography.location')?.status).not.toBe('pass')
  })

  test('a United States play is proven by any US state and ZIP', () => {
    const { countryZipProof } = jest.requireActual('../research/qualify') as typeof import('../research/qualify')
    expect(countryZipProof(['United States'], ['801 Sunshine Rd, Kansas City, KS 66115'])).toBe('US street address with a state and ZIP')
    expect(countryZipProof(['United States'], ['10 Queen St W, Toronto, ON M5H 2M9'])).toBeNull()
    expect(countryZipProof(['Kansas City, KS'], ['801 Sunshine Rd, Kansas City, KS 66115'])).toBeNull()
  })
})

describe('a Maps category covering a keyword phrase', () => {
  const { categoryCoversKeyword } = jest.requireActual('../research/qualify') as typeof import('../research/qualify')
  test('the broader category with the same head noun counts', () => {
    expect(categoryCoversKeyword('Marketing agency', 'digital marketing agency')).toBe(true)
    expect(categoryCoversKeyword('Real estate agency', 'real estate agent')).toBe(true)
    expect(categoryCoversKeyword('Dentist', 'family dentistry')).toBe(true)
  })
  test('unrelated or narrower-sounding categories do not', () => {
    expect(categoryCoversKeyword('Internet marketing service', 'creative agency')).toBe(false)
    expect(categoryCoversKeyword('Internet marketing service', 'digital marketing agency')).toBe(false)
    expect(categoryCoversKeyword('Oral and maxillofacial surgeon', 'dental clinic')).toBe(false)
    expect(categoryCoversKeyword('Agency', 'digital marketing agency')).toBe(false)
    expect(categoryCoversKeyword('Vending machine supplier', 'small batch food producer')).toBe(false)
  })
})

describe('metro tables are state-aware (2026-09-25 review, LOW)', () => {
  const proof = metroZipProof
  it('a same-named place in another state is not the metro', () => {
    expect(proof(['Orange County, FL'], ['123 Main St, Irvine, CA 92618'])).toBeNull()
    expect(proof(['Portland, ME area'], ['1 Oak St, Portland, OR 97201'])).toBeNull()
    expect(proof(['Greater Richmond, CA'], ['1 Elm St, Richmond, VA 23220'])).toBeNull()
    expect(proof(['Fairfield County, Ohio'], ['1 Elm St, Stamford, CT 06901'])).toBeNull()
  })
  it('the metro still matches with its own state or none', () => {
    expect(proof(['Orange County, CA'], ['123 Main St, Irvine, CA 92618'])).toMatch(/Orange County/)
    expect(proof(['Orange County'], ['123 Main St, Irvine, CA 92618'])).toMatch(/Orange County/)
    expect(proof(['Portland metro, OR'], ['1 Oak St, Vancouver, WA 98660'])).toMatch(/Portland/)
    expect(proof(['LA County'], ['1 Main St, Torrance, CA 90501'])).toMatch(/Los Angeles/)
  })
  it('reads state codes after a comma and full names, West Virginia is not Virginia', () => {
    expect([...statesNamed('Portland, ME')]).toEqual(['ME'])
    expect([...statesNamed('Charleston, West Virginia')]).toEqual(['WV'])
    expect(statesNamed('LA County').size).toBe(0)
  })
})
