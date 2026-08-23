import { isIP } from 'node:net'

export type CompanyWebsite = {
  companyDomain: string
  requestedHost: string
  startUrl: string
}

const RESERVED_SUFFIXES = [
  '.example',
  '.invalid',
  '.local',
  '.localhost',
  '.onion',
  '.test',
]

function hostnameFromValue(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const input = value.trim()
  if (!input || input.length > 2_048) return null
  try {
    const parsed = new URL(/^[a-z][a-z\d+.-]*:/i.test(input) ? input : `https://${input}`)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (parsed.username || parsed.password || parsed.port) return null
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '')
    if (
      !hostname
      || hostname.length > 253
      || isIP(hostname) !== 0
      || !hostname.includes('.')
      || RESERVED_SUFFIXES.some((suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix))
    ) return null
    return hostname
  } catch {
    return null
  }
}

export function normalizeCompanyWebsite(value: unknown): CompanyWebsite | null {
  const requestedHost = hostnameFromValue(value)
  if (!requestedHost) return null
  const companyDomain = requestedHost.replace(/^www\./, '')
  if (!companyDomain || !companyDomain.includes('.')) return null
  return {
    companyDomain,
    requestedHost,
    startUrl: `https://${requestedHost}/`,
  }
}

export function sameCompanyWebsiteHost(value: unknown, companyDomain: string): boolean {
  const hostname = hostnameFromValue(value)
  return hostname?.replace(/^www\./, '') === companyDomain
}

type CandidateWithIdentity = {
  id: string
  identity: Record<string, unknown>
}

type CompanyRelation = {
  childCandidateId: string
  parentCandidateId: string
}

export function inheritUnambiguousCompanyDomains<T extends CandidateWithIdentity>(
  candidates: T[],
  relations: CompanyRelation[],
  parentCandidates: CandidateWithIdentity[],
): T[] {
  const parentDomainById = new Map(
    parentCandidates.flatMap((candidate) => {
      const website = normalizeCompanyWebsite(candidate.identity.domain)
      return website ? [[candidate.id, website.companyDomain] as const] : []
    }),
  )
  const domainsByChild = new Map<string, Set<string>>()
  for (const relation of relations) {
    const domain = parentDomainById.get(relation.parentCandidateId)
    if (!domain) continue
    const domains = domainsByChild.get(relation.childCandidateId) ?? new Set<string>()
    domains.add(domain)
    domainsByChild.set(relation.childCandidateId, domains)
  }
  return candidates.map((candidate) => {
    if (normalizeCompanyWebsite(candidate.identity.domain)) return candidate
    const domains = domainsByChild.get(candidate.id)
    if (!domains || domains.size !== 1) return candidate
    return {
      ...candidate,
      identity: { ...candidate.identity, domain: [...domains][0] },
    }
  })
}
