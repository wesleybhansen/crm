import {
  inheritUnambiguousCompanyDomains,
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
})
