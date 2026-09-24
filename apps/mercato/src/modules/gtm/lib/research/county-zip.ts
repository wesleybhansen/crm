import zipByCounty from './data/zip-by-county.json'

/*
 * County membership from a listing's ZIP code (2026-09-24). Plays are often
 * drawn by county ("Hennepin County, MN", "Orange County, CA") while listings
 * name their town. data/zip-by-county.json is derived from the U.S. Census
 * Bureau's 2020 ZCTA-to-county relationship file
 * (www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/): each ZIP is
 * listed under every county holding at least 25% of its land area, so a ZIP
 * straddling a county line counts for both. Keys are "<County name>|<ST>".
 */

const STATE_CODES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT',
  delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA',
  'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
}

let index: Map<string, Set<string>> | null = null
function countyIndex(): Map<string, Set<string>> {
  if (!index) {
    index = new Map()
    for (const [key, zips] of Object.entries(zipByCounty as Record<string, string>)) {
      index.set(key.toLowerCase(), new Set(zips.split(' ')))
    }
  }
  return index
}

function stateCode(raw: string): string | null {
  const value = raw.trim().replace(/\./g, '').toLowerCase()
  if (/^[a-z]{2}$/.test(value)) return value.toUpperCase()
  return STATE_CODES[value] ?? null
}

/** "Hennepin County, MN" / "Orange County, California" -> its lookup key, else null. */
export function countyKey(expected: string): string | null {
  const parts = expected.split(',').map((part) => part.trim()).filter(Boolean)
  if (parts.length < 2) return null
  const county = parts[0].replace(/\s+/g, ' ')
  if (!/\b(county|parish|borough)$/i.test(county)) return null
  const state = stateCode(parts[1])
  return state ? `${county}|${state}`.toLowerCase() : null
}

export function listingZip(observed: string[]): string | null {
  for (const value of observed) {
    const zip = /\b[A-Z]{2}\s+(\d{5})(?:-\d{4})?\b/.exec(value)?.[1]
    if (zip) return zip
  }
  return null
}

/** Proof that a listing's own ZIP lies in one of the expected counties, or null. */
export function countyZipProof(expected: string[], observed: string[]): string | null {
  const keys = expected.map(countyKey).filter((key): key is string => Boolean(key))
  if (!keys.length) return null
  const zip = listingZip(observed)
  if (!zip) return null
  for (const key of keys) {
    if (countyIndex().get(key)?.has(zip)) {
      const [county, state] = key.split('|')
      return `ZIP ${zip} is in ${county.replace(/\b\w/g, (c) => c.toUpperCase())}, ${state.toUpperCase()}`
    }
  }
  return null
}
