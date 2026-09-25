import { isPublicAddress, normalizeUsPhone, readSite, safeSiteUrl, sitePhones, subpageLinks, htmlToText, type SiteRead } from '../research/site-fetch'
import { MIN_SIGNATURE_HITS, ownershipHints, templateOwnershipHints, textOwnershipHints } from '../research/ownership'
import { decide, ensureOwnershipCriterion, memberExcludesGroups, parseCriteria, quoteOnPage, verifyProspect, type Criterion } from '../research/verify'
import { unverifiedToCheck } from '../research/shortlist'

/* The Launch Pad shortlist check (2026-09-25 final production run): four
 * consolidator-owned vet clinics were delivered as "Independent, strong fit"
 * to a member who excluded them, on nothing but the Google Maps category. */

function site(text: string, extra: Partial<SiteRead> = {}): SiteRead {
  return { ok: true, error: null, pages: [{ url: 'https://clinic.example/', text }], rawHtml: text.toLowerCase(), fullText: text, phones: [], ...extra }
}

const CRITERIA: Criterion[] = [
  { id: 'c1', text: 'Independently owned, not part of a corporate group or chain', hard: true, ownership: true },
  { id: 'c2', text: '1 to 2 doctors', hard: true, ownership: false },
  { id: 'c3', text: 'Bought the practice within the last 3 years', hard: false, ownership: false },
]
const NOW = new Date('2026-09-25T12:00:00Z')

describe('site fetch guards (untrusted URLs from provider data)', () => {
  test('only public unicast addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect(isPublicAddress(ip)).toBe(false)
    }
    for (const ip of ['8.8.8.8', '104.16.1.1', '2606:4700::1111']) expect(isPublicAddress(ip)).toBe(true)
  })

  test('http(s) on default ports, no credentials, no raw IPs; tracking params dropped', () => {
    expect(safeSiteUrl('ftp://x.example')).toBeNull()
    expect(safeSiteUrl('https://user:pw@x.example')).toBeNull()
    expect(safeSiteUrl('http://x.example:5432/')).toBeNull()
    expect(safeSiteUrl('http://127.0.0.1/')).toBeNull()
    expect(safeSiteUrl('localhost')).toBeNull()
    expect(safeSiteUrl('www.camelwest.com/?utm_source=gmb&y_source=1_M&page=2')?.toString()).toBe('https://www.camelwest.com/?page=2')
  })

  test('a host that resolves to a private address is never fetched, on the first hop or after a redirect', async () => {
    const fetched: string[] = []
    const fetchImpl = async (url: string) => {
      fetched.push(url)
      return new Response('', { status: 302, headers: { location: 'http://internal.example/' } })
    }
    const resolve = async (host: string) => [{ address: host === 'internal.example' ? '10.0.0.5' : '93.184.216.34', family: 4 }]
    const out = await readSite('https://clinic.example', { fetchImpl: fetchImpl as never, resolve })
    expect(out.ok).toBe(false)
    expect(out.error).toBe('host_not_public')
    expect(fetched).toEqual(['https://clinic.example/'])
  })

  test('reads home plus same-site about/team pages only', () => {
    const html = '<a href="/about-us">About</a><a href="https://other.example/team">Team</a><a href="/services">Services</a><a href="/our-team">x</a><a href="/contact">Contact</a>'
    expect(subpageLinks(html, new URL('https://clinic.example/')).map((u) => u.pathname)).toEqual(['/about-us', '/our-team'])
  })

  test('text, entities and phones', () => {
    expect(htmlToText('<p>A &amp; B</p><script>x()</script><style>.a{}</style>&#169; 2026')).toBe('A & B © 2026')
    expect(normalizeUsPhone('+1 (602) 843-5452')).toBe('6028435452')
    expect(normalizeUsPhone('123-456-7890')).toBeNull()
    expect(sitePhones('<a href="tel:+16029558888">call</a>', 'Call (602) 843-5452 today')).toEqual(['6029558888', '6028435452'])
  })
})

describe('group ownership signals', () => {
  test('footer "Part of X Group" in either case; professional associations are not ownership', () => {
    const hints = textOwnershipHints('Vetsource. © 2026 Part of Lakefield Veterinary Group Manage Consent', 'Ahwatukee Animal Care Hospital')
    expect(hints.map((h) => h.org)).toContain('Lakefield Veterinary Group')
    expect(textOwnershipHints('proud to be an accredited member of the American Animal Hospital Association', 'Ahwatukee Animal Care Hospital')).toEqual([])
    expect(textOwnershipHints('© Copyright 2026 - 43rd Avenue Animal Hospital. Veterinary Marketing', '43rd Avenue Animal Hospital')).toEqual([])
    // The business's own name as the "group" is not a parent.
    expect(textOwnershipHints('Part of the Smith Veterinary Group family', 'Smith Veterinary Group')).toEqual([])
  })

  test('a network web platform counts only when it repeats', () => {
    const nva = Array.from({ length: MIN_SIGNATURE_HITS }, () => '<p class="nva-para">').join('')
    expect(templateOwnershipHints(nva)[0]?.org).toMatch(/NVA/)
    expect(templateOwnershipHints('<p>We refer emergencies to <a href="https://bluepearlvet.com">BluePearl</a></p>')).toEqual([])
    expect(templateOwnershipHints('<p class="nva-para">once</p>')).toEqual([])
  })

  test('the member asked for independents: a missing ownership criterion is added', () => {
    expect(memberExcludesGroups('Independent 1 to 2 doctor practices', [])).toBe(true)
    expect(memberExcludesGroups('Dental offices', ['corporate'])).toBe(true)
    expect(memberExcludesGroups('Dental offices in Ohio', [])).toBe(false)
    const out = ensureOwnershipCriterion([{ id: 'c1', text: '1 to 2 doctors', hard: true, ownership: false }], 'Independent clinics', [])
    expect(out.some((c) => c.ownership && c.hard)).toBe(true)
    expect(ensureOwnershipCriterion([], 'Dental offices in Ohio', [])).toEqual([])
  })

  test('criteria parse: bounded, one ownership criterion, ids assigned', () => {
    const parsed = parseCriteria(JSON.stringify({ criteria: [
      { text: 'Independent', hard: true, ownership: true }, { text: 'Also independent', hard: true, ownership: true },
      { text: '', hard: true }, { text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }, { text: 'e' },
    ] }))
    expect(parsed).toHaveLength(6)
    expect(parsed.filter((c) => c.ownership)).toHaveLength(1)
    expect(parsed[0].id).toBe('c1')
    expect(parseCriteria('not json')).toEqual([])
  })
})

describe('decision: nothing is claimed that the site does not say', () => {
  const text = 'Welcome to Desert Paws. Dr. Ana Ruiz, owner and veterinarian, bought Desert Paws in 2024. Our two doctors care for dogs and cats. Call (602) 555-0142.'

  test('a pass needs a real quote; an invented quote becomes unknown', () => {
    expect(quoteOnPage('Our two doctors care for dogs and cats', site(text))).toBeTruthy()
    expect(quoteOnPage('We are a family owned independent clinic', site(text))).toBeNull()
    expect(quoteOnPage('dogs', site(text))).toBeNull()
    const v = decide({
      criteria: CRITERIA,
      raw: { checks: [{ id: 'c1', status: 'pass', quote: 'We are proudly independent and family owned' }, { id: 'c2', status: 'pass', quote: 'Our two doctors care for dogs and cats' }], ownership: { status: 'independent', quote: 'invented' } },
      site: site(text, { phones: ['6025550142'] }), hints: [], listingPhone: '+1 602-555-0142', now: NOW,
    })
    expect(v.checks[0].status).toBe('unknown')
    expect(v.checks[1].status).toBe('pass')
    expect(v.ownership.status).toBe('unknown')
    expect(v.excluded).toBe(false)
    expect(v.grade).toBeLessThan(80)
  })

  test('a group signal on the site excludes the prospect when the member asked for independents, with the evidence', () => {
    const v = decide({
      criteria: CRITERIA,
      raw: { checks: [{ id: 'c1', status: 'pass', quote: 'Our two doctors care for dogs and cats' }] },
      site: site(text), hints: [{ kind: 'template', org: 'National Veterinary Associates (NVA)', quote: "site built on NVA's web platform" }],
      listingPhone: null, now: NOW,
    })
    expect(v.excluded).toBe(true)
    expect(v.ownership).toEqual(expect.objectContaining({ status: 'group' }))
    expect(v.exclusion_reason).toMatch(/NVA/)
    expect(v.grade).toBe(0)
  })

  test('a hard criterion failed with a real quote excludes; a soft one only lowers the grade', () => {
    const many = 'Meet our doctors: Dr. A, Dr. B, Dr. C and Dr. D practice here every day.'
    const hard = decide({ criteria: CRITERIA, raw: { checks: [{ id: 'c2', status: 'fail', quote: 'Meet our doctors: Dr. A, Dr. B, Dr. C and Dr. D' }] }, site: site(many), hints: [], listingPhone: null, now: NOW })
    expect(hard.excluded).toBe(true)
    const soft = decide({ criteria: CRITERIA, raw: { checks: [{ id: 'c3', status: 'fail', quote: 'Meet our doctors: Dr. A, Dr. B, Dr. C and Dr. D' }] }, site: site(many), hints: [], listingPhone: null, now: NOW })
    expect(soft.excluded).toBe(false)
  })

  test('"strong" is earned: all requirements confirmed grades high; each unconfirmed one costs and caps below 80', () => {
    const all = decide({
      criteria: CRITERIA,
      raw: {
        checks: [{ id: 'c1', status: 'pass', quote: 'Dr. Ana Ruiz, owner and veterinarian, bought Desert Paws in 2024' }, { id: 'c2', status: 'pass', quote: 'Our two doctors care for dogs and cats' }, { id: 'c3', status: 'pass', quote: 'bought Desert Paws in 2024' }],
        audience: { status: 'match', quote: 'Our two doctors care for dogs and cats' },
        owner_or_lead: { name: 'Dr. Ana Ruiz', title: 'Owner', quote: 'Dr. Ana Ruiz, owner and veterinarian' },
      },
      site: site(text, { phones: ['6025550142'] }), hints: [], listingPhone: '+16025550142', now: NOW,
    })
    expect(all.grade).toBeGreaterThanOrEqual(80)
    expect(all.contact).toEqual(expect.objectContaining({ phone: '+16025550142', phone_source: 'site_and_listing', person_name: 'Dr. Ana Ruiz' }))
    const oneUnknown = decide({ criteria: CRITERIA, raw: { checks: [{ id: 'c2', status: 'pass', quote: 'Our two doctors care for dogs and cats' }], audience: { status: 'match', quote: 'Our two doctors care for dogs and cats' } }, site: site(text), hints: [], listingPhone: null, now: NOW })
    const twoUnknown = decide({ criteria: CRITERIA, raw: { audience: { status: 'match', quote: 'Our two doctors care for dogs and cats' } }, site: site(text), hints: [], listingPhone: null, now: NOW })
    expect(oneUnknown.grade).toBeLessThan(80)
    expect(twoUnknown.grade).toBeLessThan(oneUnknown.grade)
  })

  test('phone: the site decides; a listing number the site does not show is replaced', () => {
    const replaced = decide({ criteria: CRITERIA, raw: {}, site: site(text, { phones: ['6025550142'] }), hints: [], listingPhone: '+1 928-492-3378', now: NOW })
    expect(replaced.contact).toEqual(expect.objectContaining({ phone: '+16025550142', phone_source: 'site', listing_phone_on_site: false }))
    const listingOnly = decide({ criteria: CRITERIA, raw: {}, site: site(text, { phones: [] }), hints: [], listingPhone: '+1 928-492-3378', now: NOW })
    expect(listingOnly.contact.phone_source).toBe('listing_only')
  })

  test('a lost model answer is not a check: complete=false', async () => {
    const model = { modelId: 'm', generate: async () => { throw new Error('down') } }
    const out = await verifyProspect({ criteria: CRITERIA, audience: null, business: { name: 'X', category: null, location: null, website: 'x.example', phone: null }, model: model as never, readSite: async () => site(text) })
    expect(out.verification.complete).toBe(false)
    const noSite = await verifyProspect({ criteria: CRITERIA, audience: null, business: { name: 'X', category: null, location: null, website: null, phone: null }, model: model as never, readSite: async () => ({ ...site(''), ok: false, error: 'no_website', pages: [] }) })
    expect(noSite.verification.complete).toBe(true)
    expect(noSite.verification.grade).toBeLessThan(60)
  })

  test('ownership hints read the full text, not the trimmed view', () => {
    const s = site('Short home page', { fullText: 'Short home page … long footer © 2026 Part of Lakefield Veterinary Group' })
    expect(ownershipHints(s, 'Ahwatukee Animal Care').map((h) => h.org)).toContain('Lakefield Veterinary Group')
  })
})

describe('verification order', () => {
  test('the best unverified rows are checked first, within the scope', () => {
    const rows = [
      { matchId: 'a', verified: false, rawScore: 50 },
      { matchId: 'b', verified: true, rawScore: 99 },
      { matchId: 'c', verified: false, rawScore: 90 },
    ]
    expect(unverifiedToCheck(rows)).toEqual(['c', 'a'])
  })
})
