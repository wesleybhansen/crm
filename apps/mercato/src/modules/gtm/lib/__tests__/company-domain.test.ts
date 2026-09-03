import {
  companyDomainFingerprint,
  inheritUnambiguousCompanyDomains,
  isGenericCompanyHost,
  lookupIdentityForEnrichment,
  normalizeCompanyWebsite,
  sameCompanyWebsiteHost,
} from '../enrich/company-domain'

describe('company website domain boundary', () => {
  it('normalizes a public company website while ignoring paths and www aliases', () => {
    expect(normalizeCompanyWebsite('https://WWW.Acme-Industrial.com/contact?source=maps')).toEqual({
      companyDomain: 'acme-industrial.com',
      requestedHost: 'www.acme-industrial.com',
      startUrl: 'https://www.acme-industrial.com/',
    })
    expect(sameCompanyWebsiteHost('http://acme-industrial.com/team', 'acme-industrial.com')).toBe(true)
    expect(sameCompanyWebsiteHost('https://www.acme-industrial.com/', 'acme-industrial.com')).toBe(true)
    expect(sameCompanyWebsiteHost('https://careers.acme-industrial.com/', 'acme-industrial.com')).toBe(false)
  })

  it.each([
    'localhost',
    '127.0.0.1',
    'http://[::1]/',
    'https://user:pass@acme-industrial.com/',
    'https://acme-industrial.com:8443/',
    'company.test',
    'company.local',
  ])('rejects non-public or authority-bearing domain input %s', (value) => {
    expect(normalizeCompanyWebsite(value)).toBeNull()
  })

  it('inherits one exact parent-company domain without mutating source candidates', () => {
    const people = [
      { id: 'person-1', identity: { name: 'Alex Owner' } },
      { id: 'person-2', identity: { name: 'Pat Owner' } },
      { id: 'person-3', identity: { name: 'Sam Owner', domain: 'existing-company.com' } },
    ]
    const hydrated = inheritUnambiguousCompanyDomains(
      people,
      [
        { childCandidateId: 'person-1', parentCandidateId: 'company-1' },
        { childCandidateId: 'person-2', parentCandidateId: 'company-1' },
        { childCandidateId: 'person-2', parentCandidateId: 'company-2' },
        { childCandidateId: 'person-3', parentCandidateId: 'company-1' },
      ],
      [
        { id: 'company-1', identity: { domain: 'https://www.acme-industrial.com/about' } },
        { id: 'company-2', identity: { domain: 'other-company.com' } },
      ],
    )

    expect(hydrated.map((candidate) => candidate.identity.domain ?? null)).toEqual([
      'acme-industrial.com',
      null,
      'existing-company.com',
    ])
    expect(people[0].identity).not.toHaveProperty('domain')
  })

  it.each([
    'https://www.facebook.com/AcmeDental',
    'instagram.com/acme',
    'https://www.linkedin.com/company/acme',
    'x.com/acme',
    'twitter.com/acme',
    'acme-dental.business.site',
    'https://acme.wixsite.com/home',
    'acme.squarespace.com',
    'https://linktr.ee/acme',
    'https://www.yelp.com/biz/acme',
    'https://sites.google.com/view/acme',
    'gmail.com',
    'yahoo.com',
    'outlook.com',
    'hotmail.com',
    'acme.wordpress.com',
    'acme.godaddysites.com',
    'acme.weebly.com',
    'tiktok.com/@acme',
    'https://www.youtube.com/@acme',
    'acme.myshopify.com',
  ])('refuses generic, hosted, social, and free-mail host %s as a company website', (value) => {
    expect(normalizeCompanyWebsite(value)).toBeNull()
    expect(companyDomainFingerprint(value)).toBeNull()
  })

  it('is public-suffix aware: the host itself and any subdomain are generic, look-alikes are not', () => {
    expect(isGenericCompanyHost('facebook.com')).toBe(true)
    expect(isGenericCompanyHost('m.facebook.com')).toBe(true)
    expect(isGenericCompanyHost('notfacebook.com')).toBe(false)
    expect(isGenericCompanyHost('facebook.com.acme-dental.com')).toBe(false)
    expect(normalizeCompanyWebsite('https://facebook.com.acme-dental.com/')?.companyDomain)
      .toBe('facebook.com.acme-dental.com')
  })

  it('strips a generic-host domain from the lookup identity and keeps the company name', () => {
    const identity = { name: 'Alex Owner', company: 'Acme Dental', domain: 'https://www.facebook.com/AcmeDental' }
    expect(lookupIdentityForEnrichment(identity)).toEqual({ name: 'Alex Owner', company: 'Acme Dental' })
    expect(identity.domain).toBe('https://www.facebook.com/AcmeDental')
    const real = { name: 'Alex Owner', domain: 'acme-dental.com' }
    expect(lookupIdentityForEnrichment(real)).toBe(real)
    const fixture = { name: 'Alex Owner', domain: 'synthetic.example' }
    expect(lookupIdentityForEnrichment(fixture)).toBe(fixture)
    expect(lookupIdentityForEnrichment({ name: 'No Domain' })).toEqual({ name: 'No Domain' })
  })

  it('never inherits a generic parent domain and lets a generic child domain be replaced by a real parent', () => {
    const people = [
      { id: 'person-1', identity: { name: 'Alex Owner' } },
      { id: 'person-2', identity: { name: 'Pat Owner', domain: 'facebook.com' } },
    ]
    const hydrated = inheritUnambiguousCompanyDomains(
      people,
      [
        { childCandidateId: 'person-1', parentCandidateId: 'company-social' },
        { childCandidateId: 'person-2', parentCandidateId: 'company-real' },
      ],
      [
        { id: 'company-social', identity: { domain: 'https://www.facebook.com/AcmeDental' } },
        { id: 'company-real', identity: { domain: 'https://acme-dental.com' } },
      ],
    )
    expect(hydrated.map((candidate) => candidate.identity.domain ?? null)).toEqual([null, 'acme-dental.com'])
  })

  it('fingerprints the normalized domain stably and ignores www/path/case', () => {
    expect(companyDomainFingerprint('https://WWW.Acme-Dental.com/about')).toBe(companyDomainFingerprint('acme-dental.com'))
    expect(companyDomainFingerprint('acme-dental.com')).toMatch(/^[0-9a-f]{16}$/)
    expect(companyDomainFingerprint('acme-dental.com')).not.toBe(companyDomainFingerprint('acme-dental.net'))
    expect(companyDomainFingerprint(null)).toBeNull()
  })
})
