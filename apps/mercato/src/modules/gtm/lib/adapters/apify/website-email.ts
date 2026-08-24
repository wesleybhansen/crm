import crypto from 'node:crypto'
import {
  capabilityCovers,
  type AdapterCapability,
  type AdapterDescriptor,
  type AdapterResult,
  type ContactPoint,
  type EnrichAdapter,
  type EnrichRequest,
} from '../types'
import { creditsFromUsd } from '../../credits/markup'
import {
  normalizeCompanyWebsite,
  sameCompanyWebsiteHost,
  type CompanyWebsite,
} from '../../enrich/company-domain'
import {
  APIFY_CUSTOMER_USE_APPROVED_ENV,
  APIFY_ENABLED_ENV,
  APIFY_PRICE_VERSION_ENV,
  APIFY_REQUIRED_PRICE_VERSION,
  APIFY_REQUIRED_TERMS_VERSION,
  APIFY_TERMS_VERSION_ENV,
  APIFY_TIMEOUT_MS_ENV,
  APIFY_TOKEN_ENVS,
  apifyEnabled,
  apifyToken,
} from './source'
import {
  APIFY_DEFAULT_TIMEOUT_MS,
  runActorWithFinalizedBilling,
  type ApifyFetchLike,
  type ApifyRunOutcome,
} from './client'

export const APIFY_WEBSITE_EMAIL_ADAPTER_ID = 'apify-public-website-email'
export const APIFY_WEBSITE_EMAIL_ACTOR_ID = 'apify/website-content-crawler'
export const APIFY_WEBSITE_EMAIL_ACTOR_BUILD = '0.3.94'
export const APIFY_WEBSITE_EMAIL_ACTOR_ENV = 'GTM_APIFY_ACTOR_WEBSITE_CONTENT'
export const APIFY_WEBSITE_EMAIL_ENABLED_ENV = 'GTM_APIFY_WEBSITE_EMAIL_ENABLED'
export const APIFY_WEBSITE_EMAIL_PRICE_VERSION_ENV = 'GTM_APIFY_WEBSITE_EMAIL_PRICE_VERSION'
export const APIFY_WEBSITE_EMAIL_RETENTION_DAYS_ENV = 'GTM_APIFY_WEBSITE_EMAIL_RETENTION_DAYS'
export const APIFY_WEBSITE_EMAIL_REQUIRED_PRICE_VERSION =
  'apify-website-content-crawler-0.3.94-free-usage-cap-0.01-retention-7d-2026-08-23'
export const APIFY_WEBSITE_EMAIL_REQUIRED_RETENTION_DAYS = 7
export const APIFY_WEBSITE_EMAIL_PROVIDER_CAP_USD = 0.01
export const APIFY_WEBSITE_EMAIL_MAX_PAGES = 5
export const APIFY_WEBSITE_EMAIL_MAX_ADDRESSES = 5
export const APIFY_WEBSITE_EMAIL_MEMORY_MBYTES = 1_024
export const APIFY_WEBSITE_EMAIL_DATASET_BYTES = 1_000_000

type WebsiteEmailEnv = Record<string, string | undefined>

type WebsiteEmailRunActor = (
  actorId: string,
  input: Record<string, unknown>,
  options: {
    token: string
    build: string
    timeoutMs: number
    maxItems: number
    maxChargeUsd: number
    memoryMbytes: number
    datasetFields: string[]
    maxDatasetBodyBytes: number
    now: () => Date
  },
) => Promise<ApifyRunOutcome>

export type ApifyWebsiteEmailDeps = {
  env?: WebsiteEmailEnv
  now?: () => Date
  runActor?: WebsiteEmailRunActor
  fetchImpl?: ApifyFetchLike
  finalizationDelayMs?: number
  sleep?: (delayMs: number) => Promise<void>
}

function processEnv(): WebsiteEmailEnv {
  return process.env as unknown as WebsiteEmailEnv
}

function configuredActor(env: WebsiteEmailEnv): string {
  return (env[APIFY_WEBSITE_EMAIL_ACTOR_ENV] ?? '').trim() || APIFY_WEBSITE_EMAIL_ACTOR_ID
}

function timeoutMs(env: WebsiteEmailEnv): number {
  const value = Number(env[APIFY_TIMEOUT_MS_ENV])
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : APIFY_DEFAULT_TIMEOUT_MS
}

export function apifyWebsiteEmailApproved(
  env: WebsiteEmailEnv = processEnv(),
): boolean {
  return (
    env[APIFY_CUSTOMER_USE_APPROVED_ENV] === 'true'
    && (env[APIFY_TERMS_VERSION_ENV] ?? '').trim() === APIFY_REQUIRED_TERMS_VERSION
    && (env[APIFY_PRICE_VERSION_ENV] ?? '').trim() === APIFY_REQUIRED_PRICE_VERSION
    && (env[APIFY_WEBSITE_EMAIL_PRICE_VERSION_ENV] ?? '').trim()
      === APIFY_WEBSITE_EMAIL_REQUIRED_PRICE_VERSION
    && (env[APIFY_WEBSITE_EMAIL_RETENTION_DAYS_ENV] ?? '').trim()
      === String(APIFY_WEBSITE_EMAIL_REQUIRED_RETENTION_DAYS)
    && configuredActor(env) === APIFY_WEBSITE_EMAIL_ACTOR_ID
  )
}

export function apifyWebsiteEmailEnabled(
  env: WebsiteEmailEnv = processEnv(),
): boolean {
  return (
    env[APIFY_WEBSITE_EMAIL_ENABLED_ENV] === 'true'
    && apifyEnabled(env)
    && apifyToken(env) !== null
    && apifyWebsiteEmailApproved(env)
  )
}

function capability(): AdapterCapability {
  return {
    signal_kind: 'contact_discovery',
    entity_units: ['people'],
    geographies: ['US'],
    channels: ['email'],
  }
}

export function apifyWebsiteEmailDescriptor(
  env: WebsiteEmailEnv = processEnv(),
): AdapterDescriptor {
  const approved = apifyWebsiteEmailApproved(env)
  return {
    contract_version: '2',
    adapter_id: APIFY_WEBSITE_EMAIL_ADAPTER_ID,
    layer: 'enrich',
    capabilities: [capability()],
    constraints: {
      license: {
        status: approved ? 'approved' : 'provisional',
        terms_version: (env[APIFY_TERMS_VERSION_ENV] ?? '').trim() || 'unapproved',
        export: approved,
        customer_display: approved,
        outreach_allowed: approved,
        retention_days: APIFY_WEBSITE_EMAIL_REQUIRED_RETENTION_DAYS,
      },
      rate_limits: { requests_per_minute: 20, concurrent: 1 },
      max_batch: 1,
    },
    cost_model: {
      unit: 'bounded_website_crawl',
      quoted_credits_per_unit: creditsFromUsd(APIFY_WEBSITE_EMAIL_PROVIDER_CAP_USD),
      price_version:
        (env[APIFY_WEBSITE_EMAIL_PRICE_VERSION_ENV] ?? '').trim() || 'unapproved',
      pay_on_found: false,
    },
    evidence_policy: {
      source_url: 'required',
      observed_at: 'required',
      max_age_days: 30,
      min_confidence: 0.8,
    },
    ambiguity_contract: {
      timeout_is_ambiguous: true,
      receipt_fields: [
        'actor_id',
        'run_id',
        'actor_build',
        'billing_finalized',
        'pricing_model',
        'provider_cost_usd',
        'pages_scoped',
        'emails_found',
      ],
    },
    dsr: { deletion_supported: false },
  }
}

export function buildApifyWebsiteEmailInput(website: CompanyWebsite): Record<string, unknown> {
  const apex = website.companyDomain
  const hosts = [...new Set([apex, `www.${apex}`])]
  return {
    startUrls: [{ url: website.startUrl }],
    crawlerType: 'cheerio',
    includeUrlGlobs: hosts.flatMap((host) => [
      `https://${host}/**`,
      `http://${host}/**`,
    ]),
    maxCrawlDepth: 1,
    maxCrawlPages: APIFY_WEBSITE_EMAIL_MAX_PAGES,
    maxResults: APIFY_WEBSITE_EMAIL_MAX_PAGES,
    initialConcurrency: 1,
    maxConcurrency: 1,
    requestTimeoutSecs: 15,
    useSitemaps: false,
    respectRobotsTxtFile: true,
    proxyConfiguration: { useApifyProxy: false },
    htmlTransformer: 'none',
    removeElementsCssSelector:
      'script, style, noscript, svg, img[src^="data:"], [role="alert"], [role="dialog"], [aria-modal="true"]',
    saveHtml: false,
    saveHtmlAsFile: false,
    saveMarkdown: false,
    saveScreenshots: false,
    saveFiles: false,
    summarize: false,
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function compactNameTokens(value: string): string[] {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 1)
    .slice(0, 5)
}

function emailMatchKind(address: string, personName: string): 'person_name' | 'other' | 'role' {
  const local = address.split('@')[0] ?? ''
  const tokens = compactNameTokens(personName)
  const first = tokens[0] ?? ''
  const last = tokens.at(-1) ?? ''
  const compactLocal = local.replace(/[^a-z0-9]/g, '')
  const personPatterns = new Set([
    first,
    last,
    `${first}${last}`,
    `${first[0] ?? ''}${last}`,
    `${first}${last[0] ?? ''}`,
  ].filter((value) => value.length > 1))
  if (personPatterns.has(compactLocal)) return 'person_name'
  if (/^(?:admin|billing|careers|contact|hello|help|info|office|sales|support|team)$/.test(compactLocal)) {
    return 'role'
  }
  return 'other'
}

const EMAIL_PATTERN =
  /[a-z0-9.!#$%&'*+/=?^_{}|~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi

type ScopedPage = {
  sourceUrl: string
  observedAt: string
  text: string
  pageHash: string
}

function scopedPage(
  value: unknown,
  website: CompanyWebsite,
  fallbackObservedAt: string,
): { kind: 'safe'; page: ScopedPage } | { kind: 'off_scope' } | { kind: 'invalid' } {
  const row = record(value)
  const crawl = record(row?.crawl)
  const requestedUrl = stringValue(row?.url)
  if (!row || !crawl || !requestedUrl) return { kind: 'invalid' }
  const loadedUrl = stringValue(crawl.loadedUrl)
  if (
    !sameCompanyWebsiteHost(requestedUrl, website.companyDomain)
    || (loadedUrl && !sameCompanyWebsiteHost(loadedUrl, website.companyDomain))
  ) return { kind: 'off_scope' }
  if (row.text != null && typeof row.text !== 'string') return { kind: 'invalid' }
  const sourceUrl = loadedUrl ?? requestedUrl
  const loadedTime = stringValue(crawl.loadedTime)
  const parsedTime = loadedTime ? new Date(loadedTime) : null
  const observedAt = parsedTime && !Number.isNaN(parsedTime.getTime())
    ? parsedTime.toISOString()
    : fallbackObservedAt
  const pageText = typeof row.text === 'string' ? row.text : ''
  return {
    kind: 'safe',
    page: {
      sourceUrl,
      observedAt,
      text: pageText,
      pageHash: crypto.createHash('sha256').update(pageText).digest('hex'),
    },
  }
}

function contactPointsFromPages(
  pages: ScopedPage[],
  website: CompanyWebsite,
  personName: string,
): ContactPoint[] {
  const byAddress = new Map<string, { point: ContactPoint; rank: number }>()
  const rankByKind = { person_name: 0, other: 1, role: 2 } as const
  for (const page of pages) {
    for (const match of page.text.matchAll(EMAIL_PATTERN)) {
      const address = match[0].toLowerCase()
      if (address.length > 254) continue
      const [local, domain] = address.split('@')
      if (!local || local.length > 64 || !domain) continue
      if (!sameCompanyWebsiteHost(domain, website.companyDomain)) continue
      if (/^(?:do-?not-?reply|no-?reply|example|test)$/.test(local)) continue
      const matchKind = emailMatchKind(address, personName)
      const point: ContactPoint = {
        channel: 'email',
        value: address,
        provenance: {
          source: 'public_company_website',
          source_url: page.sourceUrl,
          observed_at: page.observedAt,
          page_sha256: page.pageHash,
          company_domain: website.companyDomain,
          match_kind: matchKind,
        },
      }
      const rank = rankByKind[matchKind]
      const prior = byAddress.get(address)
      if (!prior || rank < prior.rank) byAddress.set(address, { point, rank })
    }
  }
  return [...byAddress.values()]
    .sort((left, right) => left.rank - right.rank || left.point.value.localeCompare(right.point.value))
    .slice(0, APIFY_WEBSITE_EMAIL_MAX_ADDRESSES)
    .map((entry) => entry.point)
}

function receipt(
  outcome: Pick<
    ApifyRunOutcome,
    | 'actorId'
    | 'runId'
    | 'itemCount'
    | 'kind'
    | 'httpStatus'
    | 'requestUrl'
    | 'attemptedAt'
    | 'billingFinalized'
    | 'providerCostUsd'
    | 'pricingModel'
  >,
  domainHash: string | null,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    actor_id: outcome.actorId,
    run_id: outcome.runId,
    actor_build: APIFY_WEBSITE_EMAIL_ACTOR_BUILD,
    item_count: outcome.itemCount,
    provider_status: outcome.kind,
    http_status: outcome.httpStatus,
    request_url: outcome.requestUrl,
    attempted_at: outcome.attemptedAt,
    billing_finalized: outcome.billingFinalized ?? false,
    pricing_model: outcome.pricingModel ?? null,
    provider_cost_usd: outcome.providerCostUsd ?? null,
    domain_sha256: domainHash,
    ...extras,
  }
}

function refusal(actorId: string, attemptedAt: string, error: string): AdapterResult<ContactPoint[]> {
  return {
    status: 'error',
    data: null,
    receipt: {
      actor_id: actorId,
      run_id: null,
      actor_build: APIFY_WEBSITE_EMAIL_ACTOR_BUILD,
      provider_status: 'disabled',
      attempted_at: attemptedAt,
      billing_finalized: false,
      pricing_model: null,
      provider_cost_usd: null,
      pages_scoped: 0,
      emails_found: 0,
    },
    cost_units: 0,
    error,
  }
}

function domainFingerprint(value: unknown): string | null {
  const website = normalizeCompanyWebsite(value)
  return website
    ? crypto.createHash('sha256').update(`website-domain-v1:${website.companyDomain}`).digest('hex')
    : null
}

export function createApifyWebsiteEmailAdapter(
  deps: ApifyWebsiteEmailDeps = {},
): EnrichAdapter {
  const env = deps.env ?? processEnv()
  const now = deps.now ?? (() => new Date())
  const descriptor = apifyWebsiteEmailDescriptor(env)
  const runActor: WebsiteEmailRunActor = deps.runActor ?? ((actorId, input, options) =>
    runActorWithFinalizedBilling(actorId, input, {
      token: options.token,
      build: options.build,
      timeoutMs: options.timeoutMs,
      maxItems: options.maxItems,
      maxChargeUsd: options.maxChargeUsd,
      memoryMbytes: options.memoryMbytes,
      datasetFields: options.datasetFields,
      maxDatasetBodyBytes: options.maxDatasetBodyBytes,
      billingContract: { pricingModel: 'FREE' },
      now: options.now,
      fetchImpl: deps.fetchImpl,
      finalizationDelayMs: deps.finalizationDelayMs,
      sleep: deps.sleep,
    }))

  return {
    descriptor,
    maxContactPointsPerCandidate: APIFY_WEBSITE_EMAIL_MAX_ADDRESSES,
    supportsCandidate(candidate) {
      return candidate.entity_kind === 'person'
        && normalizeCompanyWebsite(candidate.identity?.domain) !== null
    },
    operationFingerprint(request) {
      return domainFingerprint(request.candidate.identity.domain)
    },
    async enrich(request) {
      const attemptedAt = now().toISOString()
      const actorId = configuredActor(env)
      const coverage = capabilityCovers(descriptor, request)
      if (!coverage.covered) {
        return refusal(actorId, attemptedAt, `unsupported_capability: ${coverage.reason ?? 'not covered'}`)
      }
      if (actorId !== APIFY_WEBSITE_EMAIL_ACTOR_ID) {
        return refusal(actorId, attemptedAt, 'provider_disabled: website crawler actor override is unapproved')
      }
      if (!apifyEnabled(env) || env[APIFY_WEBSITE_EMAIL_ENABLED_ENV] !== 'true') {
        return refusal(actorId, attemptedAt, `provider_disabled: ${APIFY_ENABLED_ENV} and ${APIFY_WEBSITE_EMAIL_ENABLED_ENV} must be 'true'`)
      }
      const token = apifyToken(env)
      if (!token) {
        return refusal(
          actorId,
          attemptedAt,
          `provider_unconfigured: no Apify token configured (${APIFY_TOKEN_ENVS.join(' or ')})`,
        )
      }
      if (!apifyWebsiteEmailApproved(env)) {
        return refusal(actorId, attemptedAt, 'provider_disabled: website crawler terms or price version is unapproved')
      }
      const website = normalizeCompanyWebsite(request.candidate.identity.domain)
      if (!website) {
        return refusal(actorId, attemptedAt, 'bad_request: a public company website domain is required')
      }
      const maxChargeUsd = Number(request.max_charge_usd)
      if (
        !Number.isFinite(maxChargeUsd)
        || maxChargeUsd + 1e-9 < APIFY_WEBSITE_EMAIL_PROVIDER_CAP_USD
      ) {
        return refusal(actorId, attemptedAt, 'bad_request: the full frozen website-crawl ceiling must be reserved')
      }
      const outcome = await runActor(actorId, buildApifyWebsiteEmailInput(website), {
        token,
        build: APIFY_WEBSITE_EMAIL_ACTOR_BUILD,
        timeoutMs: timeoutMs(env),
        maxItems: APIFY_WEBSITE_EMAIL_MAX_PAGES,
        maxChargeUsd: APIFY_WEBSITE_EMAIL_PROVIDER_CAP_USD,
        memoryMbytes: APIFY_WEBSITE_EMAIL_MEMORY_MBYTES,
        datasetFields: ['url', 'crawl', 'text'],
        maxDatasetBodyBytes: APIFY_WEBSITE_EMAIL_DATASET_BYTES,
        now,
      })
      const fingerprint = domainFingerprint(website.companyDomain)
      const providerReceipt = (extras: Record<string, unknown> = {}) => receipt(
        outcome,
        fingerprint,
        {
          max_charge_usd: APIFY_WEBSITE_EMAIL_PROVIDER_CAP_USD,
          max_pages: APIFY_WEBSITE_EMAIL_MAX_PAGES,
          crawler_type: 'cheerio',
          robots_respected: true,
          proxy_used: false,
          ai_summary_used: false,
          ...extras,
        },
      )
      if (outcome.status === 'ambiguous') {
        return {
          status: 'ambiguous',
          data: null,
          receipt: providerReceipt({ pages_scoped: 0, emails_found: 0 }),
          cost_units: null,
          error: outcome.error ?? 'ambiguous provider outcome',
        }
      }
      if (outcome.status === 'error') {
        return {
          status: 'error',
          data: null,
          receipt: providerReceipt({ pages_scoped: 0, emails_found: 0 }),
          cost_units: 0,
          error: outcome.error ?? 'provider error',
        }
      }
      const providerCostUsd = outcome.providerCostUsd
      if (!outcome.billingFinalized || providerCostUsd == null) {
        return {
          status: 'ambiguous',
          data: null,
          receipt: providerReceipt({ pages_scoped: 0, emails_found: 0 }),
          cost_units: null,
          error: 'provider_billing_unknown: website crawl receipt was not finalized',
        }
      }
      const pages: ScopedPage[] = []
      let offScopePages = 0
      let invalidPages = 0
      for (const item of outcome.items) {
        const parsed = scopedPage(item, website, outcome.attemptedAt)
        if (parsed.kind === 'safe') pages.push(parsed.page)
        else if (parsed.kind === 'off_scope') offScopePages += 1
        else invalidPages += 1
      }
      if (invalidPages > 0) {
        return {
          status: 'ambiguous',
          data: null,
          receipt: providerReceipt({
            pages_scoped: pages.length,
            pages_off_scope: offScopePages,
            pages_invalid: invalidPages,
            emails_found: 0,
          }),
          cost_units: null,
          error: 'invalid_schema: website crawl rows did not match the frozen output contract',
        }
      }
      const points = contactPointsFromPages(
        pages,
        website,
        request.candidate.identity.name,
      )
      const costUnits = providerCostUsd / APIFY_WEBSITE_EMAIL_PROVIDER_CAP_USD
      if (points.length === 0) {
        return {
          status: 'no_result',
          data: null,
          receipt: providerReceipt({
            pages_scoped: pages.length,
            pages_off_scope: offScopePages,
            pages_invalid: 0,
            emails_found: 0,
          }),
          cost_units: costUnits,
        }
      }
      return {
        status: 'ok',
        data: points,
        receipt: providerReceipt({
          pages_scoped: pages.length,
          pages_off_scope: offScopePages,
          pages_invalid: 0,
          emails_found: points.length,
        }),
        cost_units: costUnits,
      }
    },
  }
}
