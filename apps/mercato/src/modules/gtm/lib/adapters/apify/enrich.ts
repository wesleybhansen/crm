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
  APIFY_ENRICH_ACTOR,
  APIFY_MEASURED_USD,
  buildProfileEnrichInput,
  extractProfileUrl,
  normalizeProfileItem,
  profileContactPoint,
  profileEnrichMode,
  resolveEnrichActorId,
  type ApifyEnv,
} from './actors'
import {
  APIFY_DEFAULT_TIMEOUT_MS,
  APIFY_MIN_CHARGE_USD,
  normalizeMaxChargeUsd,
  runActorSync,
  type ApifyFetchLike,
  type ApifyRunOutcome,
} from './client'
import {
  APIFY_ENABLED_ENV,
  APIFY_PRICE_VERSION_ENV,
  APIFY_TERMS_VERSION_ENV,
  APIFY_MAX_CHARGE_USD_ENV,
  APIFY_RECEIPT_FIELDS,
  APIFY_TOKEN_ENVS,
  apifyEnabled,
  apifyCustomerUseApproved,
  apifyToken,
} from './source'

/*
 * Apify-backed ENRICHMENT adapter: LinkedIn profile + email search
 * (SPEC-066 section 11.1/11.2, step 2 of the verified Origami pipeline).
 *
 * The sourcing adapter returns engagers with a name, a headline, and a profile
 * URL, and NO company and NO email. This adapter takes that profile URL and
 * turns it into a contact: `harvestapi/linkedin-profile-scraper` in its
 * "Profile details + email search" mode. It is a drop-in behind the same
 * EnrichAdapter contract the fixture adapter implements, so the section 11.2
 * enrichment waterfall (lib/enrich/waterfall.ts) needs no change.
 *
 * SHIPS DARK, DELIBERATELY, on the SAME hard gate as the source adapter:
 * `enrich` refuses unless BOTH GTM_APIFY_ENABLED === 'true' AND a token is
 * configured. The reason is legal, not ergonomic: scraping LinkedIn violates
 * LinkedIn's ToS regardless of tool, and reselling scraped personal data adds
 * CCPA "sale" plus GDPR exposure that lands on us, not the marketplace. See
 * `Software Strategy/gtm-data-sources-origami-map-2026-07-24.md`. No provider
 * spend until a written customer-serving license exists.
 *
 * =========================================================================
 * CRITICAL, AND THE REASON THIS FILE EXISTS SEPARATELY FROM THE SOURCE ONE:
 * THE EMAIL SEARCH IS PAY-PER-ATTEMPT, NOT PAY-ON-FOUND.
 *
 * A live run on 2026-07-24 was CHARGED $0.01 while returning `emails: []`.
 * The provider bills for the attempt, not the hit. Therefore:
 *   - cost_model.pay_on_found is FALSE on this descriptor;
 *   - every definitive outcome reports cost_units = profiles ATTEMPTED (1),
 *     including the "no address found" outcome, so the 11.2 wrapper settles
 *     it 'charged' rather than 'refunded';
 *   - true cost per VERIFIED email is $0.01 / hit-rate and MUST be measured,
 *     never assumed.
 * The SOURCING adapter is the opposite and stays pay_on_found: a zero-item
 * reactions run was verified to cost $0.00.
 * =========================================================================
 *
 * Refusal is returned as an error AdapterResult, never thrown: the wrapper
 * settles it as a definitive failure with zero charged credits.
 */

export const APIFY_ENRICH_ADAPTER_ID = 'apify-linkedin-profile-enrich'

/*
 * PROVISIONAL LICENSE FLAG (same posture as the source adapter). The descriptor
 * declares export / customer_display / outreach_allowed true because that is
 * what the product needs of this layer; the declaration is PROVISIONAL pending
 * the legal review recorded in the data-sources map. AdapterDescriptor is a
 * frozen shape with no metadata field, so the flag is exported and asserted in
 * tests instead of hidden inside the descriptor.
 */
export const APIFY_ENRICH_PROVISIONAL_LICENSE = true

/*
 * Whether to pay for the email search. Default TRUE: finding a contact is the
 * entire point of this layer, and the cheaper profile-only mode returns a
 * profile we cannot email. Set GTM_APIFY_ENRICH_EMAIL=false to run the
 * $0.004 profile-only mode (company data, no address).
 */
export const APIFY_ENRICH_EMAIL_ENV = 'GTM_APIFY_ENRICH_EMAIL'
export const APIFY_USD_PER_PROFILE_ENV = 'GTM_APIFY_USD_PER_PROFILE'
export const APIFY_ENRICH_TIMEOUT_MS_ENV = 'GTM_APIFY_TIMEOUT_MS'

/*
 * One profile per call. The actor accepts a `queries` array, but the waterfall
 * enriches one candidate at a time and the ledger reserves per candidate, so
 * batching here would decouple the reservation from the spend.
 */
export const APIFY_ENRICH_MAX_BATCH = 1

/*
 * The signal_kind the section 11.2 enrichment waterfall requests
 * (lib/enrich/waterfall.ts ENRICH_SIGNAL). The descriptor MUST declare it or
 * capabilityCovers fails closed and this adapter is never reachable.
 */
export const APIFY_ENRICH_WATERFALL_SIGNAL = 'contact_discovery'
// This adapter's own capability name for the same work.
export const APIFY_ENRICH_SIGNAL = 'enrich_contact'
export const APIFY_ENRICH_SIGNAL_KINDS = [
  APIFY_ENRICH_SIGNAL,
  APIFY_ENRICH_WATERFALL_SIGNAL,
] as const

function processEnv(): ApifyEnv {
  return process.env as unknown as ApifyEnv
}

// Registry-facing gate: BOTH conditions, default off.
export function apifyEnrichEnabled(env: ApifyEnv = processEnv()): boolean {
  return apifyEnabled(env) && apifyToken(env) !== null && apifyCustomerUseApproved(env)
}

// Default true; only an explicit 'false' turns the email search off.
export function apifyEnrichEmailMode(env: ApifyEnv): boolean {
  return (env[APIFY_ENRICH_EMAIL_ENV] ?? '').trim().toLowerCase() !== 'false'
}

/*
 * USD the provider charges per profile ATTEMPTED, straight from the actor's own
 * pricing labels, env-overridable per deploy:
 *   email search on  -> $0.01  ("Profile details + email search ($10 per 1k)")
 *   email search off -> $0.004 ("Profile details no email ($4 per 1k)")
 */
export function usdPerProfile(env: ApifyEnv): number {
  const parsed = Number(env[APIFY_USD_PER_PROFILE_ENV])
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  return apifyEnrichEmailMode(env)
    ? APIFY_MEASURED_USD.profile_with_email
    : APIFY_MEASURED_USD.profile_without_email
}

/*
 * The descriptor's quoted price, in NOLI credits per profile, PRE-markup:
 * 2,500 credits with the email search ($0.01), 1,000 without ($0.004). Markup
 * is applied in exactly one place (creditsForUnits) and never here.
 */
function creditsPerProfile(env: ApifyEnv): number {
  return creditsFromUsd(usdPerProfile(env))
}

function timeoutMs(env: ApifyEnv): number {
  const parsed = Number(env[APIFY_ENRICH_TIMEOUT_MS_ENV])
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : APIFY_DEFAULT_TIMEOUT_MS
}

/*
 * Resolve the hard per-run spend cap (maxTotalChargeUsd). Same precedence as
 * the source adapter, most specific first:
 *   1. request.max_charge_usd  (the caller's reserved per-call budget, with our
 *      markup already divided back out by providerSpendCapUsd)
 *   2. GTM_APIFY_MAX_CHARGE_USD  (deployment ceiling)
 *   3. profiles x the per-profile USD cost basis the credit quote uses
 * and the result is ALWAYS floored at the provider minimum of $0.01, because a
 * cap below it is a guaranteed HTTP 400.
 */
export function resolveEnrichMaxChargeUsd(
  env: ApifyEnv,
  args: { profiles: number; planBudgetUsd?: number | null },
): number {
  const planBudget = Number(args.planBudgetUsd)
  if (Number.isFinite(planBudget) && planBudget > 0) return normalizeMaxChargeUsd(planBudget)
  const configured = Number(env[APIFY_MAX_CHARGE_USD_ENV])
  if (Number.isFinite(configured) && configured > 0) return normalizeMaxChargeUsd(configured)
  return normalizeMaxChargeUsd(
    Math.max(APIFY_MIN_CHARGE_USD, Math.max(1, args.profiles) * usdPerProfile(env)),
  )
}

function capabilityRow(signalKind: string): AdapterCapability {
  return {
    signal_kind: signalKind,
    // V1 is US B2B PEOPLE only. A company unit fails closed at plan time: this
    // actor scrapes person profiles and has nothing to say about a company.
    entity_units: ['people'],
    geographies: ['US'],
    channels: ['email'],
  }
}

export function apifyEnrichDescriptor(env: ApifyEnv = processEnv()): AdapterDescriptor {
  const approved = apifyCustomerUseApproved(env)
  return {
    contract_version: '2',
    adapter_id: APIFY_ENRICH_ADAPTER_ID,
    layer: 'enrich',
    capabilities: APIFY_ENRICH_SIGNAL_KINDS.map(capabilityRow),
    constraints: {
      // PROVISIONAL pending legal review; see APIFY_ENRICH_PROVISIONAL_LICENSE.
      license: {
        status: approved ? 'approved' : 'provisional',
        terms_version: (env[APIFY_TERMS_VERSION_ENV] ?? '').trim() || 'unapproved',
        export: approved,
        customer_display: approved,
        outreach_allowed: approved,
        retention_days: 90,
      },
      rate_limits: { requests_per_minute: 30, concurrent: 2 },
      max_batch: APIFY_ENRICH_MAX_BATCH,
    },
    cost_model: {
      // one billed unit = one profile ATTEMPTED, not one email delivered
      unit: 'profile',
      quoted_credits_per_unit: creditsPerProfile(env),
      price_version: (env[APIFY_PRICE_VERSION_ENV] ?? '').trim() || 'unapproved',
      /*
       * FALSE, and this is a LIVE-VERIFIED fact, not a conservative guess: a
       * run that returned `emails: []` was still charged $0.01. Flipping this
       * to true would make every miss free in OUR ledger while Apify still
       * invoices us for it, so we would eat the cost of every unfound contact.
       */
      pay_on_found: false,
    },
    evidence_policy: {
      source_url: 'not_applicable',
      observed_at: 'not_applicable',
      max_age_days: null,
      min_confidence: 0,
    },
    ambiguity_contract: { timeout_is_ambiguous: true, receipt_fields: [...APIFY_RECEIPT_FIELDS] },
    // No per-subject deletion endpoint exists on a marketplace actor run.
    // Deletion is handled NOLI-SIDE (retention sweep + suppression list), which
    // is what a DSR actually acts on for this layer.
    dsr: { deletion_supported: false },
  }
}

export type ApifyEnrichRunActorFn = (
  actorId: string,
  input: Record<string, unknown>,
  options: {
    token: string
    timeoutMs: number
    maxItems: number
    // required by the provider; a run without it is HTTP 400
    maxChargeUsd: number
    now: () => Date
  },
) => Promise<ApifyRunOutcome>

export type ApifyEnrichDeps = {
  // injected in every test; production falls through to the real client
  runActor?: ApifyEnrichRunActorFn
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
): AdapterResult<ContactPoint[]> {
  return {
    status: 'error',
    data: null,
    receipt: receipt(actorId, null, 0, extras),
    // a refusal never reached the provider, so nothing was attempted and
    // nothing is billable, pay-per-attempt or not
    cost_units: 0,
    error,
  }
}

export function createApifyEnrichAdapter(deps: ApifyEnrichDeps = {}): EnrichAdapter {
  const env = deps.env ?? processEnv()
  const now = deps.now ?? (() => new Date())
  const descriptor = apifyEnrichDescriptor(env)
  const withEmail = apifyEnrichEmailMode(env)
  const runActor: ApifyEnrichRunActorFn =
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
    async enrich(request: EnrichRequest): Promise<AdapterResult<ContactPoint[]>> {
      const attemptedAt = now().toISOString()

      // 1. Capability check FIRST, before the gate, before actor resolution and
      //    before any client call (SPEC-066 11.1: a contract-disabled
      //    capability cannot run even by direct call).
      const coverage = capabilityCovers(descriptor, request)
      if (!coverage.covered) {
        return refusal(null, `unsupported_capability: ${coverage.reason ?? 'not covered'}`, {
          provider_status: 'unsupported',
          attempted_at: attemptedAt,
        })
      }
      const actorId = resolveEnrichActorId(env)

      // 2. HARD GATE. Default OFF; returned as an error result, never thrown.
      if (!apifyEnabled(env)) {
        return refusal(
          actorId,
          `provider_disabled: ${APIFY_ENABLED_ENV} is not 'true'; the Apify enrichment ships dark pending legal review`,
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

      // 3. The input profile URL, host- and shape-checked. A candidate whose
      //    urls point anywhere but a LinkedIn profile never reaches the actor.
      const profileUrl = extractProfileUrl(request.candidate.identity.urls)
      if (!profileUrl.ok) {
        return refusal(actorId, profileUrl.reason, {
          provider_status: 'bad_request',
          attempted_at: attemptedAt,
        })
      }

      // 4. The single provider call. maxTotalChargeUsd is mandatory AND is the
      //    caller's reservation expressed in provider dollars, so the provider
      //    refuses to bill past what our ledger escrowed.
      const maxChargeUsd = resolveEnrichMaxChargeUsd(env, {
        profiles: APIFY_ENRICH_MAX_BATCH,
        planBudgetUsd: request.max_charge_usd,
      })
      const outcome = await runActor(
        actorId,
        buildProfileEnrichInput({ profileUrl: profileUrl.url, withEmail }),
        {
          token,
          timeoutMs: timeoutMs(env),
          maxItems: APIFY_ENRICH_MAX_BATCH,
          maxChargeUsd,
          now,
        },
      )

      const providerReceipt = (extras: ReceiptExtras = {}) =>
        receipt(outcome.actorId ?? actorId, outcome.runId, outcome.itemCount, {
          // what we authorized the provider to spend on this run
          max_charge_usd: maxChargeUsd,
          // the billing model, on every receipt, so a reconciler never has to
          // guess why a miss was still charged
          pay_per_attempt: true,
          profile_scraper_mode: profileEnrichMode(withEmail),
          provider_status: outcome.kind,
          http_status: outcome.httpStatus,
          request_url: outcome.requestUrl,
          attempted_at: outcome.attemptedAt,
          ...(outcome.retryAfterSeconds != null
            ? { retry_after_seconds: outcome.retryAfterSeconds }
            : {}),
          /*
           * The raw body is a full personal profile. It is kept ONLY on failure
           * paths, where it is the diagnostic, and never on a success path,
           * where we already hold the structured fields and a receipt is a
           * long-lived jsonb row.
           */
          ...(outcome.bodySnippet != null &&
          (outcome.status === 'error' || outcome.status === 'ambiguous')
            ? { body_snippet: outcome.bodySnippet }
            : {}),
          ...extras,
        })

      // 5. Classify. Identical mapping to the source adapter (the client
      //    already turned HTTP/transport conditions into AdapterResult
      //    statuses); only data and cost differ, because of pay-per-attempt.
      if (outcome.status === 'ambiguous') {
        // Unknown spend: cost_units null so the wrapper parks the operation for
        // reconciliation instead of inferring a charge. Never retried.
        return {
          status: 'ambiguous',
          data: null,
          receipt: providerReceipt(),
          cost_units: null,
          error: outcome.error ?? 'ambiguous provider outcome',
        }
      }
      if (outcome.status === 'error') {
        // A rejected request never ran an actor, so nothing was attempted.
        return {
          status: 'error',
          data: null,
          receipt: providerReceipt(),
          cost_units: 0,
          error: outcome.error ?? 'provider error',
        }
      }
      if (outcome.status === 'no_result') {
        /*
         * The actor ran and returned zero profile rows. PAY-PER-ATTEMPT: we
         * charge the attempt, exactly as we do for a returned profile with no
         * email. UNVERIFIED EDGE: the live probe measured the charge for a
         * returned-row-with-no-email run, not for a zero-row run. If an invoice
         * ever shows $0.00 for zero rows, this branch (and only this branch)
         * should drop to cost_units 0.
         */
        return {
          status: 'no_result',
          data: null,
          receipt: providerReceipt({ emails_found: 0, email_state: 'not_found', profiles_attempted: 1 }),
          cost_units: 1,
        }
      }

      // 6. A profile row came back. Normalize it, then decide on the email.
      const normalized = normalizeProfileItem(outcome.items[0])
      const point = profileContactPoint(normalized, {
        adapter_id: APIFY_ENRICH_ADAPTER_ID,
        actor_id: outcome.actorId ?? actorId,
        profile_scraper_mode: profileEnrichMode(withEmail),
        source_profile_url: profileUrl.url,
        observed_at: attemptedAt,
      })

      if (!point) {
        /*
         * VERIFIED no-hit shape: `emails: []` on an otherwise complete profile.
         * No contact point, but the attempt WAS billed, so this settles charged
         * (pay_on_found is false), never refunded. The company facts we did
         * learn ride along on the receipt so the run is not a total loss.
         */
        return {
          status: 'no_result',
          data: null,
          receipt: providerReceipt({
            emails_found: 0,
            email_state: 'not_found',
            profiles_attempted: 1,
            ...(normalized.profile.company ? { company: normalized.profile.company } : {}),
            ...(normalized.profile.title ? { title: normalized.profile.title } : {}),
          }),
          cost_units: 1,
        }
      }

      return {
        status: 'ok',
        data: [point],
        receipt: providerReceipt({
          emails_found: normalized.emailsFound,
          email_state: 'found',
          profiles_attempted: 1,
          ...(normalized.profile.company ? { company: normalized.profile.company } : {}),
          ...(normalized.profile.title ? { title: normalized.profile.title } : {}),
        }),
        /*
         * PROFILES ATTEMPTED, not contact points delivered. Two addresses on
         * one profile is still one billed profile, and the customer is charged
         * for one. (Only the first address becomes a contact point; the rest
         * are not silently dropped into a second billable unit.)
         */
        cost_units: 1,
      }
    },
  }
}
