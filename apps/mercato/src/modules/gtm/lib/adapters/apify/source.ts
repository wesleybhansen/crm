import {
  capabilityCovers,
  type AdapterCapability,
  type AdapterDescriptor,
  type AdapterResult,
  type Candidate,
  type SourceAdapter,
  type SourceSearchPlan,
} from '../types'
import { creditsFromUsd } from '../../credits/markup'
import {
  APIFY_CAPABILITY_KINDS,
  APIFY_MEASURED_USD,
  buildActorInput,
  extractPostUrl,
  extractSearchQuery,
  isApifyCapabilityKind,
  isSearchCapability,
  normalizeItems,
  resolveActorId,
  type ApifyCapabilityKind,
  type ApifyEnv,
  type SearchQuery,
} from './actors'
import {
  APIFY_DEFAULT_TIMEOUT_MS,
  APIFY_MIN_CHARGE_USD,
  normalizeMaxChargeUsd,
  runActorSync,
  type ApifyFetchLike,
  type ApifyRunOutcome,
} from './client'

/*
 * Apify-backed social-engagement SOURCE adapter (SPEC-066 section 11.1/11.3).
 * The first real provider adapter; a drop-in for the fixture source adapter
 * through the same SourceAdapter contract, so lib/research/execute.ts (the
 * 11.2 reserve -> shadow -> start -> call -> settle wrapper) needs no change.
 *
 * SHIPS DARK, DELIBERATELY. `search` refuses unless BOTH
 *   GTM_APIFY_ENABLED === 'true'  AND  a token is configured.
 * This is not a convenience flag. The source is legally gated: scraping
 * LinkedIn violates LinkedIn's ToS regardless of tool, LinkedIn actively
 * litigates scrapers (v. Proxycurl 2025, v. ProAPIs), and reselling scraped
 * personal data adds CCPA "sale" plus GDPR layers where downstream liability
 * is ours, not the marketplace's. See
 * `Software Strategy/gtm-data-sources-origami-map-2026-07-24.md`, sections
 * "THE critical legal finding" and "Apify commercial posture". The standing
 * rule is: no provider spend until a written customer-serving license exists
 * and Wesley approves the spend per run. The gate default of OFF is how that
 * rule is enforced in code.
 *
 * Refusal is returned as an error AdapterResult, never thrown: the wrapper
 * settles it as a definitive failure with zero charged credits.
 */

export const APIFY_SOURCE_ADAPTER_ID = 'apify-social-source'

/*
 * Receipt contract: the ledger settles pay-per-result on the units the actor
 * actually returned, so the run must be identifiable and countable.
 *
 * `run_id` is ALWAYS null for this provider and that is a verified fact, not a
 * gap in the code: the run-sync-get-dataset-items endpoint returns the dataset
 * with no run id in any header or in the body. The field stays on the receipt
 * because the ambiguity contract declares it, and reconciliation keys on
 * actor_id + item_count + our org-scoped idempotency key instead. Getting a
 * provider run id would mean moving to the two-step run-then-fetch flow.
 */
export const APIFY_RECEIPT_FIELDS = ['actor_id', 'run_id', 'item_count'] as const

/*
 * PROVISIONAL LICENSE FLAG.
 *
 * The descriptor below declares export / customer_display / outreach_allowed
 * as true because that is what the product needs from this layer. That
 * declaration is PROVISIONAL, pending the legal review recorded in the
 * data-sources map. AdapterDescriptor is a frozen shape (SPEC-066 11.1) with
 * no metadata or extension field, so the flag cannot live inside the
 * descriptor without changing the shared contract type. It is exported here
 * instead and asserted in tests, so nothing can quietly forget it.
 */
export const APIFY_PROVISIONAL_LICENSE = true

// Env gate default: OFF. Both conditions must hold.
export const APIFY_ENABLED_ENV = 'GTM_APIFY_ENABLED'
export const APIFY_TOKEN_ENVS = ['GTM_APIFY_TOKEN', 'APIFY_TOKEN'] as const
export const APIFY_TIMEOUT_MS_ENV = 'GTM_APIFY_TIMEOUT_MS'
export const APIFY_CUSTOMER_USE_APPROVED_ENV = 'GTM_APIFY_CUSTOMER_USE_APPROVED'
export const APIFY_TERMS_VERSION_ENV = 'GTM_APIFY_TERMS_VERSION'
export const APIFY_PRICE_VERSION_ENV = 'GTM_APIFY_PRICE_VERSION'
// Batch ceiling; the plan's max_candidates caps below this.
export const APIFY_MAX_BATCH = 100

/*
 * Per-run USD spend cap (`maxTotalChargeUsd`). This is REQUIRED by the API:
 * a run without it is rejected HTTP 400 max-total-charge-usd-below-minimum
 * (verified live 2026-07-24). It is also a free hard cap that Apify enforces
 * server side, so it is belt-and-braces on top of our own ledger reservation:
 * even a runaway actor cannot bill past it.
 *
 * Precedence, most specific first:
 *   1. plan.max_charge_usd  (the caller's reserved per-batch provider budget)
 *   2. GTM_APIFY_MAX_CHARGE_USD  (deployment ceiling)
 *   3. requested results x GTM_APIFY_USD_PER_RESULT (default cost basis)
 * and the result is always floored at the provider minimum of $0.01.
 */
export const APIFY_MAX_CHARGE_USD_ENV = 'GTM_APIFY_MAX_CHARGE_USD'

/*
 * PRICING, IN USD PER RESULT. USD is the unit the provider actually bills in,
 * so it is the unit we store; Noli credits are DERIVED from it with
 * creditsFromUsd ($1 = 250,000 credits, from CREDITS_PER_CENT = 2500).
 *
 * WARNING: DO NOT quote a number lifted from another vendor's rate card here. This
 * constant previously held 0.2 "credits per result" copied from Origami's
 * price list. An Origami credit is not a Noli credit: 0.2 Noli credits is
 * $0.0000008, about 3,750x under the real ~$0.003 cost, so every sourcing run
 * undercharged by that factor. Provider cost goes in as dollars, always.
 *
 * $0.003/result was LIVE-MEASURED 2026-07-24 and prices at 750 credits before
 * markup. Re-check against a real Apify invoice before customer use.
 */
export const APIFY_USD_PER_RESULT_ENV = 'GTM_APIFY_USD_PER_RESULT'
export const APIFY_DEFAULT_USD_PER_RESULT = APIFY_MEASURED_USD.sourcing_per_result

function processEnv(): ApifyEnv {
  return process.env as unknown as ApifyEnv
}

export function apifyEnabled(env: ApifyEnv = processEnv()): boolean {
  return env[APIFY_ENABLED_ENV] === 'true'
}

export function apifyCustomerUseApproved(env: ApifyEnv = processEnv()): boolean {
  return (
    env[APIFY_CUSTOMER_USE_APPROVED_ENV] === 'true' &&
    Boolean((env[APIFY_TERMS_VERSION_ENV] ?? '').trim()) &&
    Boolean((env[APIFY_PRICE_VERSION_ENV] ?? '').trim())
  )
}

export function apifyToken(env: ApifyEnv = processEnv()): string | null {
  for (const name of APIFY_TOKEN_ENVS) {
    const value = (env[name] ?? '').trim()
    if (value) return value
  }
  return null
}

// Registry-facing gate: BOTH conditions, default off.
export function apifySourceEnabled(env: ApifyEnv = processEnv()): boolean {
  return apifyEnabled(env) && apifyToken(env) !== null && apifyCustomerUseApproved(env)
}

// USD the provider charges per returned result, env-overridable per deploy.
export function usdPerResult(env: ApifyEnv): number {
  const parsed = Number(env[APIFY_USD_PER_RESULT_ENV])
  return Number.isFinite(parsed) && parsed > 0 ? parsed : APIFY_DEFAULT_USD_PER_RESULT
}

/*
 * The descriptor's quoted price, in NOLI credits per result, pre-markup.
 * Markup is applied in exactly one place (creditsForUnits in
 * lib/credits/markup.ts) and is deliberately NOT applied here.
 */
function creditsPerResult(env: ApifyEnv): number {
  return creditsFromUsd(usdPerResult(env))
}

/*
 * Resolve the hard per-run spend cap. Never returns less than the provider
 * minimum: a cap below $0.01 is a guaranteed 400, so a too-small budget is
 * raised to one cent rather than silently failing the run.
 */
export function resolveMaxChargeUsd(
  env: ApifyEnv,
  args: { maxItems: number; planBudgetUsd?: number | null },
): number {
  const planBudget = Number(args.planBudgetUsd)
  if (Number.isFinite(planBudget) && planBudget > 0) return normalizeMaxChargeUsd(planBudget)
  const configured = Number(env[APIFY_MAX_CHARGE_USD_ENV])
  if (Number.isFinite(configured) && configured > 0) return normalizeMaxChargeUsd(configured)
  // same USD cost basis the credit quote is derived from, so the hard cap and
  // the quoted price can never drift apart
  return normalizeMaxChargeUsd(Math.max(APIFY_MIN_CHARGE_USD, args.maxItems * usdPerResult(env)))
}

function timeoutMs(env: ApifyEnv): number {
  const parsed = Number(env[APIFY_TIMEOUT_MS_ENV])
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : APIFY_DEFAULT_TIMEOUT_MS
}

function capabilityRow(signalKind: ApifyCapabilityKind): AdapterCapability {
  return {
    signal_kind: signalKind,
    // V1 is US B2B people only; a company unit or another geography fails
    // closed at plan time rather than being silently attempted.
    entity_units: ['people'],
    geographies: ['US'],
    channels: ['email', 'linkedin', 'x'],
  }
}

export function apifySourceDescriptor(env: ApifyEnv = processEnv()): AdapterDescriptor {
  const approved = apifyCustomerUseApproved(env)
  return {
    contract_version: '2',
    adapter_id: APIFY_SOURCE_ADAPTER_ID,
    layer: 'source',
    capabilities: APIFY_CAPABILITY_KINDS.map(capabilityRow),
    constraints: {
      // PROVISIONAL pending legal review; see APIFY_PROVISIONAL_LICENSE above.
      license: {
        status: approved ? 'approved' : 'provisional',
        terms_version: (env[APIFY_TERMS_VERSION_ENV] ?? '').trim() || 'unapproved',
        export: approved,
        customer_display: approved,
        outreach_allowed: approved,
        retention_days: 90,
      },
      rate_limits: { requests_per_minute: 30, concurrent: 2 },
      max_batch: APIFY_MAX_BATCH,
    },
    // pay-per-result: only usable candidates are charged, a no_result is free.
    // The quote is Noli credits per result PRE-markup (750 by default, i.e.
    // $0.003); the platform markup is applied once, by creditsForUnits.
    cost_model: {
      unit: 'result',
      quoted_credits_per_unit: creditsPerResult(env),
      price_version: (env[APIFY_PRICE_VERSION_ENV] ?? '').trim() || 'unapproved',
      pay_on_found: true,
    },
    evidence_policy: {
      source_url: 'required',
      observed_at: 'required',
      max_age_days: 90,
      min_confidence: 0.5,
    },
    ambiguity_contract: { timeout_is_ambiguous: true, receipt_fields: [...APIFY_RECEIPT_FIELDS] },
    // Apify actor runs are marketplace scrapes with no per-subject deletion
    // endpoint. Deletion is handled NOLI-SIDE: the candidate retention sweep
    // (lib/retention/sweep.ts) plus the suppression list, which is what a DSR
    // actually acts on for this layer.
    dsr: { deletion_supported: false },
  }
}

export type ApifyRunActorFn = (
  actorId: string,
  input: Record<string, unknown>,
  options: {
    token: string
    timeoutMs: number
    maxItems: number
    // required by the provider; see APIFY_MAX_CHARGE_USD_ENV above
    maxChargeUsd: number
    now: () => Date
  },
) => Promise<ApifyRunOutcome>

export type ApifySourceDeps = {
  // injected in every test; production falls through to the real client
  runActor?: ApifyRunActorFn
  fetchImpl?: ApifyFetchLike
  env?: ApifyEnv
  now?: () => Date
}

type ReceiptExtras = Record<string, unknown>

function receipt(
  actorId: string | null,
  runId: string | null,
  itemCount: number,
  extras: ReceiptExtras = {},
): Record<string, unknown> {
  // Always carries the declared ambiguity_contract.receipt_fields, on every
  // path including refusals.
  return { actor_id: actorId, run_id: runId, item_count: itemCount, ...extras }
}

function refusal(
  actorId: string | null,
  error: string,
  extras: ReceiptExtras = {},
): AdapterResult<Candidate[]> {
  return {
    status: 'error',
    data: null,
    receipt: receipt(actorId, null, 0, extras),
    cost_units: 0,
    error,
  }
}

export function createApifySourceAdapter(deps: ApifySourceDeps = {}): SourceAdapter {
  const env = deps.env ?? processEnv()
  const now = deps.now ?? (() => new Date())
  const descriptor = apifySourceDescriptor(env)
  const runActor: ApifyRunActorFn =
    deps.runActor ??
    ((actorId, input, options) =>
      runActorSync(actorId, input, {
        token: options.token,
        timeoutMs: options.timeoutMs,
        maxItems: options.maxItems,
        maxChargeUsd: options.maxChargeUsd,
        now: options.now,
        fetchImpl: deps.fetchImpl,
      }))

  return {
    descriptor,
    quote(plan) {
      const maxCandidates = Math.max(
        0,
        Math.min(Math.floor(plan.max_candidates), descriptor.constraints.max_batch),
      )
      return {
        max_candidates: maxCandidates,
        provider_units: maxCandidates,
        billable_unit: descriptor.cost_model.unit,
        expected_candidates: {
          low: 0,
          high: maxCandidates,
          basis: 'unknown',
        },
        quoted_credits_per_unit: descriptor.cost_model.quoted_credits_per_unit,
        estimated_credits_before_markup:
          maxCandidates * descriptor.cost_model.quoted_credits_per_unit,
      }
    },
    async search(plan: SourceSearchPlan): Promise<AdapterResult<Candidate[]>> {
      const attemptedAt = now().toISOString()

      // 1. Capability check FIRST, before the gate, before any actor
      //    resolution, and before any client call (SPEC-066 11.1: a
      //    contract-disabled capability cannot run even by direct call).
      const coverage = capabilityCovers(descriptor, plan)
      if (!coverage.covered) {
        return refusal(null, `unsupported_capability: ${coverage.reason ?? 'not covered'}`, {
          provider_status: 'unsupported',
          attempted_at: attemptedAt,
        })
      }
      const signalKind = plan.signal_kind.trim().toLowerCase()
      if (!isApifyCapabilityKind(signalKind)) {
        // Defense in depth: the descriptor and the actor registry are two
        // lists; a mismatch must fail closed, not fall through to a run.
        return refusal(null, `unsupported_capability: no Apify actor for ${signalKind}`, {
          provider_status: 'unsupported',
          attempted_at: attemptedAt,
        })
      }
      const actorId = resolveActorId(signalKind, env)

      // 2. HARD GATE. Default OFF, deliberately: this source is legally gated
      //    pending the review in the data-sources map. Returned as an error
      //    result, never thrown.
      if (!apifyEnabled(env)) {
        return refusal(
          actorId,
          `provider_disabled: ${APIFY_ENABLED_ENV} is not 'true'; the Apify source ships dark pending legal review`,
          { provider_status: 'disabled', attempted_at: attemptedAt },
        )
      }
      const token = apifyToken(env)
      if (!token) {
        return refusal(
          actorId,
          `provider_unconfigured: no Apify token configured (${APIFY_TOKEN_ENVS.join(' or ')})`,
          { provider_status: 'unconfigured', attempted_at: attemptedAt },
        )
      }
      if (!apifyCustomerUseApproved(env)) {
        return refusal(
          actorId,
          'provider_disabled: Apify customer use requires approved terms and price versions',
          { provider_status: 'license_unapproved', attempted_at: attemptedAt },
        )
      }

      // 3. Resolve the plan query. Discovery takes KEYWORDS + a recency
      //    window; every other capability takes a post URL the caller already
      //    holds, host-checked against the capability.
      const isSearch = isSearchCapability(signalKind)
      let postUrl: { ok: true; url: string } | null = null
      let search: SearchQuery | null = null
      if (isSearch) {
        const parsed = extractSearchQuery(plan.query)
        if (!parsed.ok) {
          return refusal(actorId, parsed.reason, {
            provider_status: 'bad_request',
            attempted_at: attemptedAt,
          })
        }
        search = parsed.search
      } else {
        const resolved = extractPostUrl(signalKind, plan.query)
        if (!resolved.ok) {
          return refusal(actorId, resolved.reason, {
            provider_status: 'bad_request',
            attempted_at: attemptedAt,
          })
        }
        postUrl = resolved
      }

      const cap = Math.max(
        0,
        Math.min(
          Number.isFinite(plan.max_candidates) ? Math.floor(plan.max_candidates) : 0,
          descriptor.constraints.max_batch,
        ),
      )
      if (cap === 0) {
        return refusal(actorId, 'bad_request: max_candidates must be at least 1', {
          provider_status: 'bad_request',
          attempted_at: attemptedAt,
        })
      }

      // 4. The single provider call. maxItems is passed through so we do not
      //    pay for results we would discard at the cap, and maxTotalChargeUsd
      //    is a hard provider-side spend cap derived from the caller's
      //    reserved budget (it is also mandatory: without it the run 400s).
      const maxChargeUsd = resolveMaxChargeUsd(env, {
        maxItems: cap,
        planBudgetUsd: plan.max_charge_usd,
      })
      const outcome = await runActor(
        actorId,
        buildActorInput(signalKind, {
          postUrl: postUrl?.url,
          search: search ?? undefined,
          maxItems: cap,
        }),
        {
          token,
          timeoutMs: timeoutMs(env),
          maxItems: cap,
          maxChargeUsd,
          now,
        },
      )

      const providerReceipt = (extras: ReceiptExtras = {}) =>
        receipt(outcome.actorId ?? actorId, outcome.runId, outcome.itemCount, {
          // what we authorized the provider to spend on this run
          max_charge_usd: maxChargeUsd,
          provider_status: outcome.kind,
          http_status: outcome.httpStatus,
          request_url: outcome.requestUrl,
          attempted_at: outcome.attemptedAt,
          ...(outcome.retryAfterSeconds != null
            ? { retry_after_seconds: outcome.retryAfterSeconds }
            : {}),
          ...(outcome.bodySnippet != null ? { body_snippet: outcome.bodySnippet } : {}),
          ...extras,
        })

      // 5. Classify. The client already mapped HTTP/transport conditions to
      //    AdapterResult statuses; we only attach data and cost.
      if (outcome.status === 'ambiguous') {
        // Unknown spend: cost_units null so the wrapper parks the operation
        // for reconciliation instead of inferring a charge. Never retried.
        return {
          status: 'ambiguous',
          data: null,
          receipt: providerReceipt(),
          cost_units: null,
          error: outcome.error ?? 'ambiguous provider outcome',
        }
      }
      if (outcome.status === 'error') {
        return {
          status: 'error',
          data: null,
          receipt: providerReceipt(),
          cost_units: 0,
          error: outcome.error ?? 'provider error',
        }
      }
      if (outcome.status === 'no_result') {
        // pay_on_found: a definitive empty answer costs zero units.
        return {
          status: 'no_result',
          data: null,
          receipt: providerReceipt(),
          cost_units: 0,
        }
      }

      const normalized = normalizeItems(signalKind, outcome.items, {
        postUrl: postUrl?.url,
        observedAt: attemptedAt,
      })
      const capped = normalized.candidates.slice(0, cap)

      /*
       * DISCOVERY BILLS PER POST, not per engager.
       *
       * The provider charges for every post RETURNED (live-measured: posts *
       * $0.002 + actor start, with nested engagers adding nothing). So a
       * search that finds real posts carrying no engagement is a legitimate,
       * fully-billable outcome, not an anomaly - the live probe hit exactly
       * that, three posts with zero comments between them. Routing it through
       * the unusable-identity branch below would park a routine result as
       * ambiguous and flood the reconciliation queue.
       *
       * So: posts returned -> 'ok', charged on POSTS (the invoiced quantity),
       * even when no engagers came back. Zero posts -> a genuine no_result,
       * free under pay_on_found.
       */
      if (isSearch) {
        const postsBilled = Array.isArray(outcome.items) ? outcome.items.length : 0
        if (postsBilled === 0) {
          return { status: 'no_result', data: null, receipt: providerReceipt(), cost_units: 0 }
        }
        return {
          status: 'ok',
          data: capped,
          receipt: providerReceipt({
            returned_count: capped.length,
            dropped_items: normalized.dropped,
            // duplicate child rows the actor emits beside the posts; skipped,
            // not failed, and reported separately so they never look like drops
            skipped_child_rows: normalized.skippedChildRows ?? 0,
            posts_billed: postsBilled,
            truncated: normalized.candidates.length > capped.length,
          }),
          cost_units: postsBilled,
        }
      }

      if (capped.length === 0) {
        // The actor returned rows but none carried a usable identity.
        //
        // This is NOT the same as a zero-item run. Apify's pay-per-event
        // billing charges per item RETURNED, so a run that handed back 25
        // unusable rows was billed for 25 while a genuine zero-item run costs
        // $0.00 (live-verified). Settling this as 'no_result' sent it down the
        // pay_on_found refund path: we paid the provider and recorded the
        // operation as free, silently, with nothing to reconcile against.
        //
        // Park it instead. 'ambiguous' holds the escrow, charges nothing,
        // refunds nothing, and flags reconciliation_required - which is the
        // honest description of "we spent money and produced no usable
        // result". Recurring hits here mean an actor changed its output shape
        // or the target is bad, and both want a human, not a silent write-off.
        const billedItems = Array.isArray(outcome.items) ? outcome.items.length : 0
        if (billedItems > 0) {
          return {
            status: 'ambiguous',
            data: null,
            receipt: providerReceipt({
              returned_count: 0,
              dropped_items: normalized.dropped,
            }),
            error: `no_usable_identity: Apify billed ${billedItems} item(s) but none carried a usable identity`,
            cost_units: null,
          }
        }
        // A genuine zero-item run: pay_on_found makes this actually free.
        return {
          status: 'no_result',
          data: null,
          receipt: providerReceipt({
            returned_count: 0,
            dropped_items: normalized.dropped,
          }),
          cost_units: 0,
        }
      }
      return {
        status: 'ok',
        data: capped,
        receipt: providerReceipt({
          returned_count: capped.length,
          dropped_items: normalized.dropped,
          truncated: normalized.candidates.length > capped.length,
        }),
        // Charged on usable candidates delivered, not on raw items fetched.
        // item_count stays on the receipt so provider spend can be reconciled
        // against what we billed.
        cost_units: capped.length,
      }
    },
  }
}
