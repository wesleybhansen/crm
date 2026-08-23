import { creditsFromUsd } from '../../credits/markup'
import {
  capabilityCovers,
  type AdapterDescriptor,
  type AdapterResult,
  type VerificationOutcome,
  type VerificationState,
  type VerifyAdapter,
} from '../types'
import {
  APIFY_DEFAULT_TIMEOUT_MS,
  APIFY_MIN_CHARGE_USD,
  normalizeMaxChargeUsd,
  runActorSync,
  type ApifyFetchLike,
  type ApifyRunOutcome,
} from './client'
import {
  APIFY_REQUIRED_TERMS_VERSION,
  APIFY_TERMS_VERSION_ENV,
  apifyCustomerUseApproved,
  apifyEnabled,
  apifyToken,
} from './source'
import type { ApifyEnv } from './actors'

export const APIFY_EMAIL_VERIFY_ADAPTER_ID = 'apify-email-verification'
export const APIFY_EMAIL_VERIFY_ACTOR_ID = 'automation-lab/email-enrichment'
export const APIFY_EMAIL_VERIFY_BUILD = '0.1.49'
export const APIFY_EMAIL_VERIFY_ENABLED_ENV = 'GTM_APIFY_EMAIL_VERIFY_ENABLED'
export const APIFY_EMAIL_VERIFY_PRICE_VERSION_ENV = 'GTM_APIFY_EMAIL_VERIFY_PRICE_VERSION'
export const APIFY_EMAIL_VERIFY_ACTOR_ENV = 'GTM_APIFY_ACTOR_EMAIL_VERIFY'
export const APIFY_EMAIL_VERIFY_REQUIRED_PRICE_VERSION =
  'automation-lab-email-enrichment-0.1.49-free-0.001-start-0.003-confidence-50-2026-08-23'
export const APIFY_EMAIL_VERIFY_START_USD = 0.001
export const APIFY_EMAIL_VERIFY_RESULT_USD = 0.003
export const APIFY_EMAIL_VERIFY_PROVIDER_CAP_USD = APIFY_MIN_CHARGE_USD
export const APIFY_EMAIL_VERIFY_START_ONLY_UNITS =
  APIFY_EMAIL_VERIFY_START_USD / APIFY_EMAIL_VERIFY_PROVIDER_CAP_USD
export const APIFY_EMAIL_VERIFY_BILLED_UNITS =
  (APIFY_EMAIL_VERIFY_START_USD + APIFY_EMAIL_VERIFY_RESULT_USD) /
  APIFY_EMAIL_VERIFY_PROVIDER_CAP_USD

const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/
const RECEIPT_FIELDS = [
  'actor_id',
  'run_id',
  'item_count',
  'provider_status',
  'build_number',
  'confidence_score',
  'verification_method',
] as const

export type ApifyEmailVerifierRunActorFn = (
  actorId: string,
  input: Record<string, unknown>,
  options: {
    token: string
    build: string
    timeoutMs: number
    maxItems: number
    maxChargeUsd: number
    now: () => Date
  },
) => Promise<ApifyRunOutcome>

export type ApifyEmailVerifierDeps = {
  env?: ApifyEnv
  fetchImpl?: ApifyFetchLike
  runActor?: ApifyEmailVerifierRunActorFn
  now?: () => Date
}

type ParsedVerification = {
  email: string
  isValidFormat: boolean
  hasMxRecords: boolean
  isVerified: boolean
  isCatchAll: boolean
  isDisposable: boolean
  isFreeProvider: boolean
  isRoleAccount: boolean
  confidenceScore: number
  verificationMethod: string
  provider: string | null
  deliverabilityGrade: string | null
}

function processEnv(): ApifyEnv {
  return process.env as unknown as ApifyEnv
}

function envValue(env: ApifyEnv, name: string): string {
  return (env[name] ?? '').trim()
}

export function apifyEmailVerifierApproved(env: ApifyEnv = processEnv()): boolean {
  return (
    apifyCustomerUseApproved(env) &&
    envValue(env, APIFY_EMAIL_VERIFY_ENABLED_ENV) === 'true' &&
    envValue(env, APIFY_EMAIL_VERIFY_PRICE_VERSION_ENV) ===
      APIFY_EMAIL_VERIFY_REQUIRED_PRICE_VERSION
  )
}

export function apifyEmailVerifierEnabled(env: ApifyEnv = processEnv()): boolean {
  return apifyEnabled(env) && apifyToken(env) !== null && apifyEmailVerifierApproved(env)
}

export function apifyEmailVerifierDescriptor(
  env: ApifyEnv = processEnv(),
): AdapterDescriptor {
  const approved = apifyEmailVerifierApproved(env)
  return {
    contract_version: '2',
    adapter_id: APIFY_EMAIL_VERIFY_ADAPTER_ID,
    layer: 'verify',
    capabilities: [
      {
        signal_kind: 'email_verification',
        entity_units: ['contacts'],
        geographies: ['US'],
        channels: ['email'],
      },
    ],
    constraints: {
      license: {
        status: approved ? 'approved' : 'provisional',
        terms_version: approved
          ? envValue(env, APIFY_TERMS_VERSION_ENV)
          : 'unapproved',
        export: approved,
        customer_display: approved,
        outreach_allowed: approved,
        retention_days: 90,
      },
      rate_limits: { requests_per_minute: 30, concurrent: 2 },
      max_batch: 1,
    },
    cost_model: {
      unit: 'verification_run_cap',
      quoted_credits_per_unit: creditsFromUsd(APIFY_EMAIL_VERIFY_PROVIDER_CAP_USD),
      price_version:
        envValue(env, APIFY_EMAIL_VERIFY_PRICE_VERSION_ENV) || 'unapproved',
      pay_on_found: false,
    },
    evidence_policy: {
      source_url: 'not_applicable',
      observed_at: 'preferred',
      max_age_days: 30,
      min_confidence: 80,
    },
    ambiguity_contract: {
      timeout_is_ambiguous: true,
      receipt_fields: [...RECEIPT_FIELDS],
    },
    dsr: { deletion_supported: false },
  }
}

function normalizedEmail(value: string): string | null {
  const normalized = value.trim().toLowerCase()
  if (!normalized || normalized.length > 254 || !EMAIL_PATTERN.test(normalized)) return null
  return normalized
}

function safeString(value: unknown, maxLength = 80): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return normalized ? normalized.slice(0, maxLength) : null
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number.NaN
  return Number.isFinite(parsed) ? parsed : null
}

function parseVerification(value: unknown): ParsedVerification | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const email = normalizedEmail(typeof row.email === 'string' ? row.email : '')
  const confidenceScore = finiteNumber(row.confidenceScore)
  const verificationMethod = safeString(row.verificationMethod)
  const booleans = [
    row.isValidFormat,
    row.hasMxRecords,
    row.isVerified,
    row.isCatchAll,
    row.isDisposable,
    row.isFreeProvider,
    row.isRoleAccount,
  ]
  if (
    !email ||
    confidenceScore === null ||
    confidenceScore < 0 ||
    confidenceScore > 100 ||
    !verificationMethod ||
    booleans.some((entry) => typeof entry !== 'boolean')
  ) {
    return null
  }
  return {
    email,
    isValidFormat: row.isValidFormat as boolean,
    hasMxRecords: row.hasMxRecords as boolean,
    isVerified: row.isVerified as boolean,
    isCatchAll: row.isCatchAll as boolean,
    isDisposable: row.isDisposable as boolean,
    isFreeProvider: row.isFreeProvider as boolean,
    isRoleAccount: row.isRoleAccount as boolean,
    confidenceScore,
    verificationMethod,
    provider: safeString(row.provider),
    deliverabilityGrade: safeString(row.deliverabilityGrade, 12),
  }
}

function verificationState(row: ParsedVerification): VerificationState {
  if (!row.isValidFormat || !row.hasMxRecords) return 'not_found'
  if (row.isCatchAll) return 'catch_all'
  if (row.isDisposable || row.isFreeProvider || row.isRoleAccount) return 'risky'
  if (
    row.isVerified &&
    row.verificationMethod === 'smtp' &&
    row.confidenceScore >= 80
  ) {
    return 'verified'
  }
  return 'unknown'
}

function billedUnits(confidenceScore: number): number {
  return confidenceScore >= 50
    ? APIFY_EMAIL_VERIFY_BILLED_UNITS
    : APIFY_EMAIL_VERIFY_START_ONLY_UNITS
}

function receipt(
  outcome: ApifyRunOutcome | null,
  providerStatus: string,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  const {
    confidence_score: confidenceScore = null,
    verification_method: verificationMethod = null,
    ...remainingExtras
  } = extras
  return {
    actor_id: outcome?.actorId ?? APIFY_EMAIL_VERIFY_ACTOR_ID,
    run_id: outcome?.runId ?? null,
    item_count: outcome?.itemCount ?? 0,
    provider_status: providerStatus,
    build_number: APIFY_EMAIL_VERIFY_BUILD,
    confidence_score: confidenceScore,
    verification_method: verificationMethod,
    ...remainingExtras,
  }
}

function refusal(
  providerStatus: string,
  error: string,
): AdapterResult<VerificationOutcome> {
  return {
    status: 'error',
    data: null,
    receipt: receipt(null, providerStatus),
    cost_units: 0,
    error,
  }
}

export function createApifyEmailVerifierAdapter(
  deps: ApifyEmailVerifierDeps = {},
): VerifyAdapter {
  const env = deps.env ?? processEnv()
  const now = deps.now ?? (() => new Date())
  const descriptor = apifyEmailVerifierDescriptor(env)
  const runActor: ApifyEmailVerifierRunActorFn =
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
    async verify(request): Promise<AdapterResult<VerificationOutcome>> {
      const coverage = capabilityCovers(descriptor, request)
      if (!coverage.covered) {
        return refusal(
          'unsupported',
          `unsupported_capability: ${coverage.reason ?? 'not covered'}`,
        )
      }
      if (!apifyEmailVerifierEnabled(env)) {
        return refusal(
          'disabled',
          'provider_disabled: Apify email verification requires the exact reviewed actor, build, and price contract',
        )
      }
      const actorId = envValue(env, APIFY_EMAIL_VERIFY_ACTOR_ENV) || APIFY_EMAIL_VERIFY_ACTOR_ID
      if (actorId !== APIFY_EMAIL_VERIFY_ACTOR_ID) {
        return refusal(
          'actor_contract_unapproved',
          'provider_disabled: email verification actor override is unapproved',
        )
      }
      const token = apifyToken(env)
      if (!token) return refusal('unconfigured', 'provider_unconfigured: Apify token is missing')
      const email = normalizedEmail(request.value)
      if (!email) return refusal('bad_request', 'invalid_email: address is not well formed')

      const maxChargeUsd = normalizeMaxChargeUsd(
        request.max_charge_usd ?? APIFY_EMAIL_VERIFY_PROVIDER_CAP_USD,
      )
      const outcome = await runActor(
        actorId,
        {
          emails: [email],
          verificationLevel: 'smtp',
          detectCatchAll: true,
          checkDeliverability: true,
        },
        {
          token,
          build: APIFY_EMAIL_VERIFY_BUILD,
          timeoutMs: APIFY_DEFAULT_TIMEOUT_MS,
          maxItems: 1,
          maxChargeUsd,
          now,
        },
      )

      if (outcome.status === 'ambiguous' || outcome.kind === 'server_error') {
        return {
          status: 'ambiguous',
          data: null,
          receipt: receipt(outcome, outcome.kind, { max_charge_usd: maxChargeUsd }),
          cost_units: null,
          error: outcome.error ?? 'ambiguous provider outcome',
        }
      }
      if (outcome.status === 'error') {
        return {
          status: 'error',
          data: null,
          receipt: receipt(outcome, outcome.kind, { max_charge_usd: maxChargeUsd }),
          cost_units: 0,
          error: outcome.error ?? 'provider error',
        }
      }
      if (outcome.status === 'no_result') {
        return {
          status: 'ok',
          data: {
            channel: 'email',
            value: email,
            verification_state: 'unknown',
            detail: { verification_method: 'none', confidence_score: 0 },
          },
          receipt: receipt(outcome, 'empty_result', {
            max_charge_usd: maxChargeUsd,
            billing_event: 'start',
          }),
          cost_units: APIFY_EMAIL_VERIFY_START_ONLY_UNITS,
        }
      }
      if (outcome.items.length !== 1) {
        return {
          status: 'ambiguous',
          data: null,
          receipt: receipt(outcome, 'invalid_item_count', { max_charge_usd: maxChargeUsd }),
          cost_units: null,
          error: 'invalid_schema: expected exactly one verification result',
        }
      }

      const parsed = parseVerification(outcome.items[0])
      if (!parsed || parsed.email !== email) {
        return {
          status: 'ambiguous',
          data: null,
          receipt: receipt(outcome, 'invalid_schema', { max_charge_usd: maxChargeUsd }),
          cost_units: null,
          error: 'invalid_schema: verification result did not match the requested address',
        }
      }

      const state = verificationState(parsed)
      const detail = {
        confidence_score: parsed.confidenceScore,
        verification_method: parsed.verificationMethod,
        provider: parsed.provider,
        deliverability_grade: parsed.deliverabilityGrade,
        is_catch_all: parsed.isCatchAll,
        is_disposable: parsed.isDisposable,
        is_free_provider: parsed.isFreeProvider,
        is_role_account: parsed.isRoleAccount,
      }
      return {
        status: 'ok',
        data: {
          channel: 'email',
          value: email,
          verification_state: state,
          detail,
        },
        receipt: receipt(outcome, state, {
          max_charge_usd: maxChargeUsd,
          billing_event:
            parsed.confidenceScore >= 50 ? 'start+email-verified' : 'start',
          ...detail,
        }),
        cost_units: billedUnits(parsed.confidenceScore),
      }
    },
  }
}

export const APIFY_EMAIL_VERIFY_REQUIRED_TERMS_VERSION = APIFY_REQUIRED_TERMS_VERSION
