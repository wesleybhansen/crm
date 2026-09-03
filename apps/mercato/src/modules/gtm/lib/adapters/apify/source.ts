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
  APIFY_ACTORS,
  APIFY_MEASURED_USD,
  APIFY_SELECTED_SOURCE_CAPABILITY_KINDS,
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
export const APIFY_RECEIPT_FIELDS = ['actor_id', 'actor_build', 'run_id', 'item_count'] as const

/*
 * CUSTOMER-SERVING RIGHTS DECISION.
 *
 * The owner accepted the selected actors for customer-serving use on
 * 2026-08-21 after review of Apify's Actor Terms and General Terms. Runtime
 * still requires the exact terms and price versions below: approval of the
 * stack does not let a deployment silently use another actor or rate card.
 */
export const APIFY_CUSTOMER_SERVING_RIGHTS_APPROVED = true
/** Compatibility signal for older contract checks. */
export const APIFY_PROVISIONAL_LICENSE = !APIFY_CUSTOMER_SERVING_RIGHTS_APPROVED

// Env gate default: OFF. Both conditions must hold.
export const APIFY_ENABLED_ENV = 'GTM_APIFY_ENABLED'
export const APIFY_TOKEN_ENVS = ['GTM_APIFY_TOKEN', 'APIFY_TOKEN'] as const
export const APIFY_TIMEOUT_MS_ENV = 'GTM_APIFY_TIMEOUT_MS'
export const APIFY_CUSTOMER_USE_APPROVED_ENV = 'GTM_APIFY_CUSTOMER_USE_APPROVED'
export const APIFY_TERMS_VERSION_ENV = 'GTM_APIFY_TERMS_VERSION'
export const APIFY_PRICE_VERSION_ENV = 'GTM_APIFY_PRICE_VERSION'
export const APIFY_ACCOUNT_TIER_ENV = 'GTM_APIFY_ACCOUNT_TIER'
export const APIFY_REQUIRED_TERMS_VERSION = 'apify-actor-terms-2026-07-09'
export const APIFY_REQUIRED_PRICE_VERSION = 'harvestapi-selected-stack-2026-08-21'
export const APIFY_REQUIRED_ACCOUNT_TIER = 'BRONZE'
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
 * The selected comments actor publishes $0.002/result for Free/Starter as of
 * 2026-08-21 and prices at 500 credits before markup. The exact frozen price
 * version above must match before the adapter can register.
 */
// Retained as a documented compatibility no-op. Runtime pricing is bound to
// APIFY_REQUIRED_PRICE_VERSION and cannot be overridden independently.
export const APIFY_USD_PER_RESULT_ENV = 'GTM_APIFY_USD_PER_RESULT'
export const APIFY_DEFAULT_USD_PER_RESULT = APIFY_MEASURED_USD.sourcing_per_result

function processEnv(): ApifyEnv {
  return process.env as unknown as ApifyEnv
}

export function apifyEnabled(env: ApifyEnv = processEnv()): boolean {
  return env[APIFY_ENABLED_ENV] === 'true'
}

export function apifyAccountTierApproved(env: ApifyEnv = processEnv()): boolean {
  return (env[APIFY_ACCOUNT_TIER_ENV] ?? '').trim() === APIFY_REQUIRED_ACCOUNT_TIER
}

export function apifyCustomerUseApproved(env: ApifyEnv = processEnv()): boolean {
  return (
    env[APIFY_CUSTOMER_USE_APPROVED_ENV] === 'true' &&
    (env[APIFY_TERMS_VERSION_ENV] ?? '').trim() === APIFY_REQUIRED_TERMS_VERSION &&
    (env[APIFY_PRICE_VERSION_ENV] ?? '').trim() === APIFY_REQUIRED_PRICE_VERSION &&
    apifyAccountTierApproved(env)
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

// USD the selected actor charges per returned result. A new rate requires a
// new reviewed price version in code; an arbitrary deployment value cannot
// mutate a frozen quote while retaining the same version identifier.
export function usdPerResult(_env: ApifyEnv): number {
  return APIFY_DEFAULT_USD_PER_RESULT
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
    channels: ['email', 'linkedin'],
  }
}

export function apifySourceDescriptor(env: ApifyEnv = processEnv()): AdapterDescriptor {
  const approved = apifyCustomerUseApproved(env)
  return {
    contract_version: '2',
    adapter_id: APIFY_SOURCE_ADAPTER_ID,
    layer: 'source',
    capabilities: APIFY_SELECTED_SOURCE_CAPABILITY_KINDS.map(capabilityRow),
    constraints: {
      // Deployment approval is exact-version gated even though the selected
      // stack's customer-serving rights have been accepted by the owner.
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
    // The selected comments actor is pay-per-result, so a definitive
    // no-comment answer is free under its current rate card. Post search is
    // not exposed from THIS people adapter. The separate opportunity adapter
    // uses finalized event billing and disables nested people collection.
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
    build: string
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
  return {
    actor_id: actorId,
    actor_build: extras.actor_build ?? null,
    run_id: runId,
    item_count: itemCount,
    ...extras,
  }
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
        build: options.build,
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
      const actorBuild = APIFY_ACTORS[signalKind].actorBuild

      // Actor overrides are separate provider contracts. Never let an
      // arbitrary marketplace actor inherit the selected actor's parser,
      // frozen price or customer-use approval merely through an env value.
      if (actorId !== APIFY_ACTORS[signalKind].defaultActorId) {
        return refusal(
          actorId,
          `provider_disabled: actor override for ${signalKind} has no approved contract`,
          { provider_status: 'actor_contract_unapproved', attempted_at: attemptedAt },
        )
      }
      if (!actorBuild) {
        return refusal(
          actorId,
          `provider_disabled: ${signalKind} has no reviewed actor build`,
          { provider_status: 'actor_build_unapproved', attempted_at: attemptedAt },
        )
      }

      // 2. HARD GATE. Default OFF. Deployment activation remains explicit and
      //    is returned as an error result, never thrown.
      if (!apifyEnabled(env)) {
        return refusal(
          actorId,
          `provider_disabled: ${APIFY_ENABLED_ENV} is not 'true'; the selected Apify source is not active in this deployment`,
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
          build: actorBuild,
          timeoutMs: timeoutMs(env),
          maxItems: cap,
          maxChargeUsd,
          now,
        },
      )

      const providerReceipt = (extras: ReceiptExtras = {}) =>
        receipt(outcome.actorId ?? actorId, outcome.runId, outcome.itemCount, {
          actor_build: actorBuild,
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
      // The actor invoices every RETURNED item, not every usable candidate
      // (review 2026-09-02, M1). Charging capped.length under-billed by the
      // rows the normalizer dropped or the cap discarded, and Noli absorbed
      // the difference with nothing on the receipt to reconcile against. The
      // charge is the invoiced quantity; 'partial' says fewer usable rows were
      // delivered than were paid for, mirroring company-source.ts.
      const billedItems = outcome.itemCount
      return {
        status: capped.length < billedItems ? 'partial' : 'ok',
        data: capped,
        receipt: providerReceipt({
          returned_count: capped.length,
          dropped_items: normalized.dropped,
          truncated: normalized.candidates.length > capped.length,
          undelivered_billed_results: Math.max(0, billedItems - capped.length),
        }),
        cost_units: billedItems,
      }
    },
  }
}
