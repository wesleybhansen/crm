import type { AdapterResultStatus } from '../types'

/*
 * Thin, injectable Apify REST client (SPEC-066 Tranche 3, first REAL source
 * provider). No Apify SDK dependency: one fetch call, injected so every test
 * runs against a fake and no test can ever open a socket.
 *
 * Ships DARK. Nothing here runs unless the caller (source.ts) passes the
 * env gate, and nothing in this file executes at import time.
 *
 * Honesty rules encoded here:
 * - The token is NEVER logged, never echoed into a receipt, and never left in
 *   a stored URL: `requestUrl` on the outcome is always the redacted form.
 * - A timeout / abort / HTTP 408 is AMBIGUOUS, never a silent retry
 *   (SPEC-066 section 6 rule 4). A generic transport failure is ALSO treated
 *   as ambiguous: once the POST is dispatched we cannot know whether the
 *   actor run started and billed, so we park it for reconciliation instead of
 *   guessing. That is deliberately conservative about the customer's money.
 * - Every outcome carries actor_id / run_id / item_count material so the
 *   ledger can settle on the units actually returned (pay-per-result).
 *
 * LIVE-VERIFIED 2026-07-24 against the real Apify API
 * (`Software Strategy/gtm-apify-verified-contract-2026-07-24.md`). These are
 * facts now, not assumptions:
 * - endpoint: POST /v2/acts/{actorId}/run-sync-get-dataset-items
 * - actor ids of the form `username/actor-name` are addressed in the API path
 *   as `username~actor-name` (confirmed)
 * - SUCCESS IS HTTP 201, not 200. The classifier below therefore treats any
 *   2xx carrying a JSON array as success and never special-cases 200.
 * - a 2xx body is a bare JSON ARRAY of dataset items (no envelope)
 * - `timeout` (seconds), `maxItems` and `maxTotalChargeUsd` are accepted as
 *   query parameters
 * - `maxTotalChargeUsd` is MANDATORY: a run without it is rejected with HTTP
 *   400 `max-total-charge-usd-below-minimum` ("Maximum cost per run is less
 *   than the allowed minimum of $0.01"). It doubles as a free hard per-run
 *   spend cap, so we always send it, derived from the caller's reserved
 *   budget and floored at the provider minimum.
 * - NO run id is returned by this endpoint. No `x-apify-run-id` header (or any
 *   variant) exists on the response; the only Apify headers observed are
 *   `x-apify-pagination-*` and `x-ratelimit-limit`. `runId` is therefore
 *   always null here, on purpose, and reconciliation leans on
 *   actor_id + item_count + our org-scoped idempotency key instead.
 * - `x-apify-pagination-total` is UNRELIABLE (it read 0 while 5 items came
 *   back), so item counts always come from the returned array length.
 */

export const APIFY_API_BASE = 'https://api.apify.com/v2'
export const APIFY_DEFAULT_TIMEOUT_MS = 60_000
export const APIFY_FINALIZED_BILLING_DELAY_MS = 10_000
// Response bodies are truncated before they reach a receipt: receipts are
// stored jsonb and read by humans, not a place for a full provider payload.
export const APIFY_BODY_SNIPPET_LIMIT = 500

/*
 * Apify's own documented floor for `maxTotalChargeUsd`. Anything below this
 * (including omitting the param) is a hard HTTP 400, so this is both a
 * validation floor and the smallest cap we can legally send.
 */
export const APIFY_MIN_CHARGE_USD = 0.01
// Safe small default when the caller passes no budget: one cent per run.
export const APIFY_DEFAULT_MAX_CHARGE_USD = APIFY_MIN_CHARGE_USD

// ---------------------------------------------------------------------------
// Injectable fetch surface (structural slice only, so tests pass a plain fn)
// ---------------------------------------------------------------------------

export type ApifyFetchHeaders = { get(name: string): string | null | undefined }

export type ApifyFetchResponse = {
  status: number
  headers?: ApifyFetchHeaders | null
  text(): Promise<string>
}

export type ApifyFetchInit = {
  method: string
  headers: Record<string, string>
  body?: string
  signal?: unknown
}

export type ApifyFetchLike = (url: string, init: ApifyFetchInit) => Promise<ApifyFetchResponse>

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type ApifyOutcomeKind =
  | 'ok'
  | 'no_result'
  | 'auth_error'
  | 'rate_limited'
  | 'server_error'
  | 'client_error'
  | 'invalid_schema'
  | 'timeout'
  | 'transport_unknown'

/*
 * THE status mapping table. Kept as data (not scattered `if`s) so it can be
 * asserted directly in tests and read at a glance in review.
 */
export const APIFY_STATUS_MAP: Record<ApifyOutcomeKind, AdapterResultStatus> = {
  ok: 'ok',
  no_result: 'no_result',
  auth_error: 'error',
  rate_limited: 'error',
  server_error: 'error',
  client_error: 'error',
  // 'invalid_schema' is only reachable BELOW the 2xx gate, which means the
  // actor ran and Apify billed us for it. Mapping it to 'error' would settle
  // the ledger operation as 'refunded': we would pay the provider and charge
  // the customer nothing, silently, every time a marketplace actor changes
  // its output shape (which they do without notice). Park it instead.
  invalid_schema: 'ambiguous',
  // never a silent retry: parked for reconciliation
  timeout: 'ambiguous',
  transport_unknown: 'ambiguous',
}

export type ApifyRunOutcome = {
  kind: ApifyOutcomeKind
  status: AdapterResultStatus
  items: unknown[]
  actorId: string
  runId: string | null
  itemCount: number
  httpStatus: number | null
  retryAfterSeconds: number | null
  bodySnippet: string | null
  // redacted: the token is stripped before this value exists
  requestUrl: string
  attemptedAt: string
  error: string | null
  billingFinalized?: boolean
  chargedEventCounts?: Record<string, number> | null
  providerCostUsd?: number | null
  pricingModel?: string | null
}

export type ApifyRunOptions = {
  token: string
  // Optional immutable build number/tag. When supplied, it is sent as the
  // documented `build` query parameter so a reviewed marketplace contract
  // cannot silently drift with the Actor's `latest` tag.
  build?: string
  timeoutMs?: number
  maxItems?: number
  // Hard per-run provider spend cap in USD. REQUIRED by the API (see the
  // header note); defaults to APIFY_DEFAULT_MAX_CHARGE_USD and is always
  // floored at APIFY_MIN_CHARGE_USD so a run can never be rejected for an
  // under-minimum cap, and can never exceed what the caller reserved.
  maxChargeUsd?: number
  memoryMbytes?: number
  datasetFields?: string[]
  maxDatasetBodyBytes?: number
  // 'header' (default) keeps the token out of the URL entirely; 'query' is
  // the documented `?token=` form. Either way the token is redacted from
  // anything we store or return.
  tokenTransport?: 'header' | 'query'
  now?: () => Date
  fetchImpl?: ApifyFetchLike
}

export type ApifyFinalizedEventBillingContract = {
  pricingModel: 'PAY_PER_EVENT'
  eventPricesUsd: Record<string, number>
}

export type ApifyFinalizedUsageBillingContract = {
  pricingModel: 'FREE'
}

export type ApifyFinalizedBillingContract =
  | ApifyFinalizedEventBillingContract
  | ApifyFinalizedUsageBillingContract

export type ApifyFinalizedRunOptions = ApifyRunOptions & {
  billingContract: ApifyFinalizedBillingContract
  finalizationDelayMs?: number
  sleep?: (delayMs: number) => Promise<void>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// `username/actor-name` -> `username~actor-name` for the API path (VERIFIED).
export function encodeActorId(actorId: string): string {
  return actorId.trim().replace(/\//g, '~')
}

export function redactToken(text: string, token: string): string {
  let out = text
  if (token) out = out.split(token).join('[redacted]')
  return out.replace(/token=[^&\s]+/gi, 'token=[redacted]')
}

export function truncateBody(text: string, limit = APIFY_BODY_SNIPPET_LIMIT): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}...[truncated ${text.length - limit} chars]`
}

function readHeader(headers: ApifyFetchHeaders | null | undefined, name: string): string | null {
  if (!headers || typeof headers.get !== 'function') return null
  const value = headers.get(name)
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readRetryAfter(headers: ApifyFetchHeaders | null | undefined): number | null {
  const raw = readHeader(headers, 'retry-after')
  if (!raw) return null
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}

function isAbortLike(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name
  if (name === 'AbortError' || name === 'TimeoutError') return true
  const message = err instanceof Error ? err.message : String(err ?? '')
  return /abort|timed?\s?out|timeout|etimedout/i.test(message)
}

/*
 * Clamp a caller-supplied USD cap onto Apify's accepted range. Anything
 * missing, non-finite, or under the $0.01 minimum becomes the minimum: sending
 * a too-small cap is a hard 400, so silently failing the run would be worse
 * than spending at most one cent.
 */
export function normalizeMaxChargeUsd(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed <= APIFY_MIN_CHARGE_USD) return APIFY_MIN_CHARGE_USD
  // round UP to cents-of-a-cent so float noise can never land us under the
  // minimum, and so the value we send is the value we can show on a receipt
  const scaled = parsed * 10_000
  const nearestInteger = Math.round(scaled)
  // Decimal values such as 0.101 can become 1010.0000000000001 in binary.
  // Treat only machine-noise-distance values as exact; a genuinely larger
  // requested cap still rounds upward as the safety contract requires.
  const integerUnits = Math.abs(scaled - nearestInteger) < 1e-9
    ? nearestInteger
    : Math.ceil(scaled)
  return integerUnits / 10_000
}

export function buildRunSyncUrl(
  actorId: string,
  options: {
    token: string
    build?: string
    tokenTransport: 'header' | 'query'
    timeoutMs: number
    maxItems?: number
    maxChargeUsd?: number
    memoryMbytes?: number
  },
): { url: string; redactedUrl: string } {
  const params: string[] = []
  const build = options.build?.trim()
  if (build) params.push(`build=${encodeURIComponent(build)}`)
  // Apify's own run timeout, in seconds, kept just under our client deadline
  // so the provider gives up before we do where possible.
  params.push(`timeout=${Math.max(1, Math.floor(options.timeoutMs / 1000))}`)
  if (typeof options.maxItems === 'number' && options.maxItems > 0) {
    params.push(`maxItems=${Math.floor(options.maxItems)}`)
  }
  if (typeof options.memoryMbytes === 'number' && options.memoryMbytes >= 128) {
    params.push(`memory=${Math.floor(options.memoryMbytes)}`)
  }
  // ALWAYS sent. Omitting it is HTTP 400 max-total-charge-usd-below-minimum
  // (verified live), and it is a free hard spend cap on top of our ledger
  // reservation.
  params.push(`maxTotalChargeUsd=${normalizeMaxChargeUsd(options.maxChargeUsd)}`)
  const base = `${APIFY_API_BASE}/acts/${encodeActorId(actorId)}/run-sync-get-dataset-items`
  const redactedUrl = `${base}?${[...params, 'token=[redacted]'].join('&')}`
  const url =
    options.tokenTransport === 'query'
      ? `${base}?${[...params, `token=${encodeURIComponent(options.token)}`].join('&')}`
      : `${base}?${params.join('&')}`
  return { url, redactedUrl }
}

export function buildActorRunUrl(
  actorId: string,
  options: {
    token: string
    build?: string
    tokenTransport: 'header' | 'query'
    timeoutMs: number
    maxItems?: number
    maxChargeUsd?: number
    memoryMbytes?: number
    finalizationDelayMs: number
  },
): { url: string; redactedUrl: string } {
  const params: string[] = []
  const build = options.build?.trim()
  if (build) params.push(`build=${encodeURIComponent(build)}`)
  const providerTimeoutSeconds = Math.max(1, Math.floor(options.timeoutMs / 1000))
  const waitBudgetMs = Math.max(1_000, options.timeoutMs - options.finalizationDelayMs - 2_000)
  params.push(`timeout=${providerTimeoutSeconds}`)
  params.push(`waitForFinish=${Math.min(60, Math.max(1, Math.floor(waitBudgetMs / 1000)))}`)
  if (typeof options.maxItems === 'number' && options.maxItems > 0) {
    params.push(`maxItems=${Math.floor(options.maxItems)}`)
  }
  if (typeof options.memoryMbytes === 'number' && options.memoryMbytes >= 128) {
    params.push(`memory=${Math.floor(options.memoryMbytes)}`)
  }
  params.push(`maxTotalChargeUsd=${normalizeMaxChargeUsd(options.maxChargeUsd)}`)
  const base = `${APIFY_API_BASE}/acts/${encodeActorId(actorId)}/runs`
  const redactedUrl = `${base}?${[...params, 'token=[redacted]'].join('&')}`
  const url =
    options.tokenTransport === 'query'
      ? `${base}?${[...params, `token=${encodeURIComponent(options.token)}`].join('&')}`
      : `${base}?${params.join('&')}`
  return { url, redactedUrl }
}

type ApifyRunRecord = {
  id: string
  status: string
  defaultDatasetId: string
  chargedEventCounts: Record<string, number>
  pricingInfo: {
    pricingModel: string
    pricingPerEvent?: {
      actorChargeEvents?: Record<string, { eventPriceUsd?: number }>
    }
  }
  usageTotalUsd: number | null
}

type ApifyRunIdentity = Pick<ApifyRunRecord, 'id' | 'status' | 'defaultDatasetId'>

function parseRunIdentity(value: unknown): ApifyRunIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (
    typeof row.id !== 'string' ||
    !row.id ||
    typeof row.status !== 'string' ||
    typeof row.defaultDatasetId !== 'string' ||
    !row.defaultDatasetId
  ) {
    return null
  }
  return { id: row.id, status: row.status, defaultDatasetId: row.defaultDatasetId }
}

function parseRunRecord(value: unknown): ApifyRunRecord | null {
  const identity = parseRunIdentity(value)
  if (!identity) return null
  const row = value as Record<string, unknown>
  const rawCounts = row.chargedEventCounts
  const chargedEventCounts: Record<string, number> = {}
  if (rawCounts && typeof rawCounts === 'object' && !Array.isArray(rawCounts)) {
    for (const [event, count] of Object.entries(rawCounts)) {
      if (!Number.isSafeInteger(count) || Number(count) < 0) return null
      chargedEventCounts[event] = Number(count)
    }
  }
  const pricingInfo = row.pricingInfo
  if (!pricingInfo || typeof pricingInfo !== 'object' || Array.isArray(pricingInfo)) return null
  const pricing = pricingInfo as Record<string, unknown>
  const pricingPerEvent = pricing.pricingPerEvent
  const rawEvents =
    pricingPerEvent && typeof pricingPerEvent === 'object' && !Array.isArray(pricingPerEvent)
      ? (pricingPerEvent as Record<string, unknown>).actorChargeEvents
      : null
  const actorChargeEvents: Record<string, { eventPriceUsd?: number }> = {}
  if (rawEvents && typeof rawEvents === 'object' && !Array.isArray(rawEvents)) {
    for (const [event, detail] of Object.entries(rawEvents)) {
      if (!detail || typeof detail !== 'object' || Array.isArray(detail)) continue
      const price = Number((detail as Record<string, unknown>).eventPriceUsd)
      actorChargeEvents[event] = Number.isFinite(price) ? { eventPriceUsd: price } : {}
    }
  }
  const usageTotalUsd = row.usageTotalUsd == null ? Number.NaN : Number(row.usageTotalUsd)
  return {
    ...identity,
    chargedEventCounts,
    pricingInfo: {
      pricingModel: typeof pricing.pricingModel === 'string' ? pricing.pricingModel : '',
      pricingPerEvent: { actorChargeEvents },
    },
    usageTotalUsd: Number.isFinite(usageTotalUsd) && usageTotalUsd >= 0 ? usageTotalUsd : null,
  }
}

function finalizedProviderCost(
  run: ApifyRunRecord,
  contract: ApifyFinalizedBillingContract,
  maxChargeUsd: number,
): { costUsd: number; counts: Record<string, number> } | null {
  if (run.pricingInfo.pricingModel !== contract.pricingModel) return null
  if (contract.pricingModel === 'FREE') {
    if (Object.values(run.chargedEventCounts).some((count) => count > 0)) return null
    if (run.usageTotalUsd == null || run.usageTotalUsd > maxChargeUsd + 1e-9) return null
    return {
      costUsd: Math.round(run.usageTotalUsd * 1e8) / 1e8,
      counts: run.chargedEventCounts,
    }
  }
  const providerPrices = run.pricingInfo.pricingPerEvent?.actorChargeEvents ?? {}
  for (const [event, expectedPrice] of Object.entries(contract.eventPricesUsd)) {
    if (!Number.isFinite(expectedPrice) || expectedPrice < 0) return null
    if (providerPrices[event]?.eventPriceUsd !== expectedPrice) return null
  }
  for (const [event, count] of Object.entries(run.chargedEventCounts)) {
    if (count > 0 && contract.eventPricesUsd[event] == null) return null
  }
  const costUsd = Object.entries(run.chargedEventCounts).reduce(
    (sum, [event, count]) => sum + count * (contract.eventPricesUsd[event] ?? 0),
    0,
  )
  const roundedCostUsd = Math.round(costUsd * 1e6) / 1e6
  if (roundedCostUsd > maxChargeUsd + 1e-9) return null
  if (run.usageTotalUsd == null || Math.abs(run.usageTotalUsd - roundedCostUsd) > 1e-6) return null
  return { costUsd: roundedCostUsd, counts: run.chargedEventCounts }
}

async function defaultSleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
}

async function fetchTextWithTimeout(
  fetchImpl: ApifyFetchLike,
  url: string,
  init: ApifyFetchInit,
  timeoutMs: number,
): Promise<{ response: ApifyFetchResponse; body: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal })
    return { response, body: await response.text() }
  } finally {
    clearTimeout(timer)
  }
}

export async function runActorWithFinalizedBilling(
  actorId: string,
  input: Record<string, unknown>,
  options: ApifyFinalizedRunOptions,
): Promise<ApifyRunOutcome> {
  const timeoutMs = options.timeoutMs ?? APIFY_DEFAULT_TIMEOUT_MS
  const tokenTransport = options.tokenTransport ?? 'header'
  const now = options.now ?? (() => new Date())
  const attemptedAt = now().toISOString()
  const configuredDelayMs = options.finalizationDelayMs ?? APIFY_FINALIZED_BILLING_DELAY_MS
  const finalizationDelayMs = Number.isFinite(configuredDelayMs)
    ? Math.max(0, Math.floor(configuredDelayMs))
    : APIFY_FINALIZED_BILLING_DELAY_MS
  const fetchImpl =
    options.fetchImpl ?? ((globalThis as { fetch?: unknown }).fetch as ApifyFetchLike | undefined)
  const maxChargeUsd = normalizeMaxChargeUsd(options.maxChargeUsd)
  const { url, redactedUrl } = buildActorRunUrl(actorId, {
    token: options.token,
    build: options.build,
    tokenTransport,
    timeoutMs,
    maxItems: options.maxItems,
    maxChargeUsd,
    memoryMbytes: options.memoryMbytes,
    finalizationDelayMs,
  })
  const base = {
    actorId,
    runId: null as string | null,
    itemCount: 0,
    httpStatus: null as number | null,
    retryAfterSeconds: null as number | null,
    bodySnippet: null as string | null,
    requestUrl: redactedUrl,
    attemptedAt,
    billingFinalized: false,
    chargedEventCounts: null as Record<string, number> | null,
    providerCostUsd: null as number | null,
    pricingModel: null as string | null,
  }
  if (typeof fetchImpl !== 'function') {
    return {
      ...base,
      kind: 'client_error',
      status: 'error',
      items: [],
      error: 'apify_client_unavailable: no fetch implementation available',
    }
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (tokenTransport === 'header') headers.authorization = `Bearer ${options.token}`

  let startResponse: ApifyFetchResponse
  let startBody: string
  try {
    const result = await fetchTextWithTimeout(
      fetchImpl,
      url,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
      },
      timeoutMs,
    )
    startResponse = result.response
    startBody = result.body
  } catch (error) {
    const message = redactToken(error instanceof Error ? error.message : String(error), options.token)
    return {
      ...base,
      kind: isAbortLike(error) ? 'timeout' : 'transport_unknown',
      status: 'ambiguous',
      items: [],
      error: `transport_unknown: actor start outcome is unknown (${message})`,
    }
  }
  const httpStatus = Number.isFinite(startResponse.status) ? startResponse.status : null
  const retryAfterSeconds = readRetryAfter(startResponse.headers)
  const withStart = {
    ...base,
    httpStatus,
    retryAfterSeconds,
    bodySnippet: truncateBody(redactToken(startBody, options.token)),
  }
  if (httpStatus === 401 || httpStatus === 403 || httpStatus === 429) {
    return {
      ...withStart,
      kind: httpStatus === 429 ? 'rate_limited' : 'auth_error',
      status: 'error',
      items: [],
      error: `provider_error: Apify rejected actor start (HTTP ${httpStatus})`,
    }
  }
  if (httpStatus == null || httpStatus < 200 || httpStatus >= 300) {
    const dispatched = httpStatus === 408 || (httpStatus != null && httpStatus >= 500)
    return {
      ...withStart,
      kind: dispatched ? 'transport_unknown' : 'client_error',
      status: dispatched ? 'ambiguous' : 'error',
      items: [],
      error: `provider_error: Apify actor start returned HTTP ${httpStatus ?? 'unknown'}`,
    }
  }

  let startPayload: unknown
  try {
    startPayload = JSON.parse(startBody)
  } catch {
    return {
      ...withStart,
      kind: 'invalid_schema',
      status: 'ambiguous',
      items: [],
      error: 'invalid_schema: Apify actor start body was not valid JSON',
    }
  }
  const startEnvelope = startPayload as { data?: unknown }
  const startRun = parseRunIdentity(startEnvelope?.data)
  if (!startRun) {
    return {
      ...withStart,
      kind: 'invalid_schema',
      status: 'ambiguous',
      items: [],
      error: 'invalid_schema: Apify actor start body had no durable run identity',
    }
  }
  const withRun = { ...withStart, runId: startRun.id }
  if (startRun.status !== 'SUCCEEDED') {
    return {
      ...withRun,
      kind: startRun.status === 'TIMED-OUT' ? 'timeout' : 'transport_unknown',
      status: 'ambiguous',
      items: [],
      error: `provider_pending: Apify run ended wait with ${startRun.status}`,
    }
  }

  await (options.sleep ?? defaultSleep)(finalizationDelayMs)
  let detailResponse: ApifyFetchResponse
  let detailBody: string
  try {
    const result = await fetchTextWithTimeout(
      fetchImpl,
      `${APIFY_API_BASE}/actor-runs/${encodeURIComponent(startRun.id)}`,
      { method: 'GET', headers },
      timeoutMs,
    )
    detailResponse = result.response
    detailBody = result.body
  } catch (error) {
    const message = redactToken(error instanceof Error ? error.message : String(error), options.token)
    return {
      ...withRun,
      kind: 'transport_unknown',
      status: 'ambiguous',
      items: [],
      error: `transport_unknown: finalized run receipt unavailable (${message})`,
    }
  }
  if (detailResponse.status < 200 || detailResponse.status >= 300) {
    return {
      ...withRun,
      kind: 'transport_unknown',
      status: 'ambiguous',
      items: [],
      error: `provider_error: finalized run receipt returned HTTP ${detailResponse.status}`,
    }
  }
  let detailPayload: unknown
  try {
    detailPayload = JSON.parse(detailBody)
  } catch {
    return {
      ...withRun,
      kind: 'invalid_schema',
      status: 'ambiguous',
      items: [],
      error: 'invalid_schema: finalized run receipt was not valid JSON',
    }
  }
  const detailEnvelope = detailPayload as { data?: unknown }
  const finalRun = parseRunRecord(detailEnvelope?.data)
  const billing = finalRun
    ? finalizedProviderCost(finalRun, options.billingContract, maxChargeUsd)
    : null
  if (!finalRun || finalRun.id !== startRun.id || finalRun.status !== 'SUCCEEDED' || !billing) {
    return {
      ...withRun,
      kind: 'invalid_schema',
      status: 'ambiguous',
      items: [],
      error: 'invalid_schema: finalized billing evidence did not match the frozen contract',
    }
  }
  const withBilling = {
    ...withRun,
    billingFinalized: true,
    chargedEventCounts: billing.counts,
    providerCostUsd: billing.costUsd,
    pricingModel: finalRun.pricingInfo.pricingModel,
  }

  let datasetResponse: ApifyFetchResponse
  let datasetBody: string
  try {
    const limit = Math.max(1, Math.floor(options.maxItems ?? 1))
    const datasetParams = new URLSearchParams({ clean: 'true', limit: String(limit) })
    const datasetFields = (options.datasetFields ?? [])
      .map((field) => field.trim())
      .filter((field) => /^[a-zA-Z0-9_.]+$/.test(field))
    if (datasetFields.length > 0) datasetParams.set('fields', datasetFields.join(','))
    const result = await fetchTextWithTimeout(
      fetchImpl,
      `${APIFY_API_BASE}/datasets/${encodeURIComponent(finalRun.defaultDatasetId)}/items?${datasetParams.toString()}`,
      { method: 'GET', headers },
      timeoutMs,
    )
    datasetResponse = result.response
    datasetBody = result.body
  } catch (error) {
    const message = redactToken(error instanceof Error ? error.message : String(error), options.token)
    return {
      ...withBilling,
      kind: 'transport_unknown',
      status: 'ambiguous',
      items: [],
      error: `transport_unknown: run dataset unavailable (${message})`,
    }
  }
  if (datasetResponse.status < 200 || datasetResponse.status >= 300) {
    return {
      ...withBilling,
      kind: 'transport_unknown',
      status: 'ambiguous',
      items: [],
      error: `provider_error: run dataset returned HTTP ${datasetResponse.status}`,
    }
  }
  const maxDatasetBodyBytes = Number(options.maxDatasetBodyBytes)
  if (
    Number.isFinite(maxDatasetBodyBytes)
    && maxDatasetBodyBytes > 0
    && Buffer.byteLength(datasetBody, 'utf8') > Math.floor(maxDatasetBodyBytes)
  ) {
    return {
      ...withBilling,
      kind: 'invalid_schema',
      status: 'ambiguous',
      items: [],
      error: 'invalid_schema: run dataset exceeded the frozen byte ceiling',
    }
  }
  let items: unknown
  try {
    items = JSON.parse(datasetBody)
  } catch {
    items = null
  }
  const maxItems = Math.max(1, Math.floor(options.maxItems ?? 1))
  if (!Array.isArray(items) || items.length > maxItems) {
    return {
      ...withBilling,
      kind: 'invalid_schema',
      status: 'ambiguous',
      items: [],
      error: 'invalid_schema: run dataset exceeded the frozen result contract',
    }
  }
  return {
    ...withBilling,
    kind: items.length === 0 ? 'no_result' : 'ok',
    status: items.length === 0 ? 'no_result' : 'ok',
    items,
    itemCount: items.length,
    bodySnippet: truncateBody(redactToken(datasetBody, options.token)),
    error: null,
  }
}

// ---------------------------------------------------------------------------
// The one call
// ---------------------------------------------------------------------------

export async function runActorSync(
  actorId: string,
  input: Record<string, unknown>,
  options: ApifyRunOptions,
): Promise<ApifyRunOutcome> {
  const timeoutMs = options.timeoutMs ?? APIFY_DEFAULT_TIMEOUT_MS
  const tokenTransport = options.tokenTransport ?? 'header'
  const now = options.now ?? (() => new Date())
  const attemptedAt = now().toISOString()
  const fetchImpl =
    options.fetchImpl ?? ((globalThis as { fetch?: unknown }).fetch as ApifyFetchLike | undefined)

  const { url, redactedUrl } = buildRunSyncUrl(actorId, {
    token: options.token,
    build: options.build,
    tokenTransport,
    timeoutMs,
    maxItems: options.maxItems,
    maxChargeUsd: options.maxChargeUsd,
    memoryMbytes: options.memoryMbytes,
  })

  const base = {
    actorId,
    /*
     * ALWAYS null on this endpoint, verified live: run-sync-get-dataset-items
     * returns the dataset only and surfaces no run id in any header or in the
     * body. We do not pretend otherwise. Ledger reconciliation therefore keys
     * on actor_id + item_count + our org-scoped idempotency key. If a provider
     * run id ever becomes a hard requirement, the fix is the two-step
     * run-then-fetch-dataset flow, not a header probe.
     */
    runId: null as string | null,
    itemCount: 0,
    httpStatus: null as number | null,
    retryAfterSeconds: null as number | null,
    bodySnippet: null as string | null,
    requestUrl: redactedUrl,
    attemptedAt,
  }

  if (typeof fetchImpl !== 'function') {
    return {
      ...base,
      kind: 'client_error',
      status: APIFY_STATUS_MAP.client_error,
      items: [],
      error: 'apify_client_unavailable: no fetch implementation available',
    }
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (tokenTransport === 'header') headers.authorization = `Bearer ${options.token}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let response: ApifyFetchResponse
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
      signal: controller.signal,
    })
  } catch (err) {
    const message = redactToken(err instanceof Error ? err.message : String(err), options.token)
    const kind: ApifyOutcomeKind = isAbortLike(err) ? 'timeout' : 'transport_unknown'
    return {
      ...base,
      kind,
      status: APIFY_STATUS_MAP[kind],
      items: [],
      error:
        kind === 'timeout'
          ? `timeout: no Apify response within ${timeoutMs}ms (${message})`
          : `transport_unknown: ${message}`,
    }
  } finally {
    clearTimeout(timer)
  }

  const httpStatus = typeof response.status === 'number' ? response.status : null
  // No run id exists on this endpoint (see `base.runId` above); nothing to read.
  const runId: string | null = null
  const retryAfterSeconds = readRetryAfter(response.headers)

  let bodyText = ''
  try {
    bodyText = await response.text()
  } catch (err) {
    const message = redactToken(err instanceof Error ? err.message : String(err), options.token)
    return {
      ...base,
      kind: 'transport_unknown',
      status: APIFY_STATUS_MAP.transport_unknown,
      items: [],
      httpStatus,
      runId,
      retryAfterSeconds,
      error: `transport_unknown: response body unreadable (${message})`,
    }
  }
  const bodySnippet = truncateBody(redactToken(bodyText, options.token))

  const withBody = { ...base, httpStatus, runId, retryAfterSeconds, bodySnippet }

  // 408 is a server-side deadline: same unknown outcome as our own abort.
  if (httpStatus === 408) {
    return {
      ...withBody,
      kind: 'timeout',
      status: APIFY_STATUS_MAP.timeout,
      items: [],
      error: 'timeout: Apify returned HTTP 408',
    }
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return {
      ...withBody,
      kind: 'auth_error',
      status: APIFY_STATUS_MAP.auth_error,
      items: [],
      error: `auth_error: Apify rejected the credentials (HTTP ${httpStatus})`,
    }
  }
  if (httpStatus === 429) {
    return {
      ...withBody,
      kind: 'rate_limited',
      status: APIFY_STATUS_MAP.rate_limited,
      items: [],
      error: `rate_limit: Apify throttled the request${
        retryAfterSeconds != null ? ` (retry after ${retryAfterSeconds}s)` : ''
      }`,
    }
  }
  if (httpStatus != null && httpStatus >= 500) {
    return {
      ...withBody,
      kind: 'server_error',
      status: APIFY_STATUS_MAP.server_error,
      items: [],
      error: `provider_5xx: Apify returned HTTP ${httpStatus}`,
    }
  }
  // Everything left that is not 2xx is a definitive client-side rejection.
  // Live-verified examples: 400 max-total-charge-usd-below-minimum (cap missing
  // or under $0.01) and 400 invalid-input (e.g. a capitalized
  // profileScraperMode). Both are our bug, not a retryable provider blip.
  if (httpStatus == null || httpStatus < 200 || httpStatus >= 300) {
    return {
      ...withBody,
      kind: 'client_error',
      status: APIFY_STATUS_MAP.client_error,
      items: [],
      error: `provider_error: Apify returned HTTP ${httpStatus ?? 'unknown'}`,
    }
  }

  /*
   * From here down we are on a 2xx. The live API answers this endpoint with
   * HTTP 201, not 200, so success is defined as "any 2xx whose body parses as
   * a JSON array" and 200 is never special-cased.
   */

  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return {
      ...withBody,
      kind: 'invalid_schema',
      status: APIFY_STATUS_MAP.invalid_schema,
      items: [],
      error: 'invalid_schema: Apify returned a body that is not valid JSON',
    }
  }
  if (!Array.isArray(parsed)) {
    return {
      ...withBody,
      kind: 'invalid_schema',
      status: APIFY_STATUS_MAP.invalid_schema,
      items: [],
      error: 'invalid_schema: Apify dataset payload was not a JSON array',
    }
  }

  if (parsed.length === 0) {
    return {
      ...withBody,
      kind: 'no_result',
      status: APIFY_STATUS_MAP.no_result,
      items: [],
      itemCount: 0,
      error: null,
    }
  }

  return {
    ...withBody,
    kind: 'ok',
    status: APIFY_STATUS_MAP.ok,
    items: parsed,
    // Counted from the array, never from x-apify-pagination-total: that header
    // was observed reading 0 while five items were returned (verified live).
    itemCount: parsed.length,
    error: null,
  }
}

export type RunActorSyncFn = typeof runActorSync
