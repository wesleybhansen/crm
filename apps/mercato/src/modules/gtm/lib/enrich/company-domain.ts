import crypto from 'crypto'
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

/*
 * Hosts that can never be a company's own website: social profiles, hosted
 * site builders, link-in-bio pages, directories, and free-mail providers. A
 * Maps listing that links facebook.com/AcmeDental yields domain facebook.com,
 * and a paid finder would happily return a Meta employee for it. Matching is
 * public-suffix aware: the host itself or any subdomain of it is denied
 * (pages.business.site, acme.wixsite.com, sites.google.com).
 */
const GENERIC_HOSTS = [
  'facebook.com',
  'fb.com',
  'fb.me',
  'instagram.com',
  'linkedin.com',
  'lnkd.in',
  'x.com',
  'twitter.com',
  't.co',
  'threads.net',
  'tiktok.com',
  'youtube.com',
  'youtu.be',
  'pinterest.com',
  'nextdoor.com',
  'reddit.com',
  'snapchat.com',
  'whatsapp.com',
  'business.site',
  'wixsite.com',
  'wix.com',
  'squarespace.com',
  'weebly.com',
  'wordpress.com',
  'godaddysites.com',
  'webnode.com',
  'webflow.io',
  'carrd.co',
  'strikingly.com',
  'myshopify.com',
  'linktr.ee',
  'linktree.com',
  'bio.link',
  'beacons.ai',
  'yelp.com',
  'google.com',
  'goo.gl',
  'yellowpages.com',
  'bbb.org',
  'zillow.com',
  'realtor.com',
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'ymail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'protonmail.com',
  'proton.me',
  'mail.com',
]

export function isGenericCompanyHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '')
  if (!host) return false
  return GENERIC_HOSTS.some((generic) => host === generic || host.endsWith(`.${generic}`))
}

function hostnameFromValue(value: unknown, options?: { allowGeneric?: boolean }): string | null {
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
      || (!options?.allowGeneric && isGenericCompanyHost(hostname))
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

/*
 * Short stable fingerprint of the candidate's normalized company domain, used
 * as the request identity inside enrichment idempotency keys: correcting a
 * candidate's domain produces a new key, so the corrected input can be looked
 * up again instead of being pinned to an old no_result forever.
 */
export function companyDomainFingerprint(value: unknown): string | null {
  const website = normalizeCompanyWebsite(value)
  if (!website) return null
  return crypto.createHash('sha256').update(website.companyDomain).digest('hex').slice(0, 16)
}

export function sameCompanyWebsiteHost(value: unknown, companyDomain: string): boolean {
  const hostname = hostnameFromValue(value)
  return hostname?.replace(/^www\./, '') === companyDomain
}

/*
 * The identity an enrichment adapter may look up. A generic-host `domain`
 * (facebook.com, gmail.com, a wixsite.com page) is removed so no adapter ever
 * sends it to a paid finder; the company name still travels, so a name-based
 * lookup remains possible. Returns the same object when nothing is stripped.
 */
export function lookupIdentityForEnrichment<T extends Record<string, unknown>>(identity: T): T {
  const hostname = hostnameFromValue(identity.domain, { allowGeneric: true })
  if (!hostname || !isGenericCompanyHost(hostname)) return identity
  const { domain: _dropped, ...rest } = identity
  return rest as unknown as T
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
