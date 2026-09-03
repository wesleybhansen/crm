import { UniqueConstraintViolationException } from '@mikro-orm/core'
import { GtmAiTelemetry } from '../../data/entities'
import type { CampaignEm, GtmCtx } from '../campaign/build'
import type { GtmAiMeter } from './model'

type GtmCanonicalAiMeter = (
  usage: Parameters<GtmAiMeter>[0],
  operationKey: string,
) => void | Promise<void>

const COMPONENT_KEYS = [
  'system',
  'tool_schema',
  'history',
  'evidence',
  'provider_rows',
  'durable_summary',
] as const

// 'pending' is the local receipt written BEFORE the canonical Noli Core
// metering call; it is settled to succeeded/failed once that call returns.
export type GtmAiTelemetryStatus = 'pending' | 'succeeded' | 'failed'

export const CANONICAL_METERING_FAILED = 'canonical_metering_failed'

export type GtmAiTelemetryInput = {
  operationKey: string
  surface: string
  model: string | null
  status: GtmAiTelemetryStatus
  tokensIn: number
  tokensOut: number
  tokenUsageKnown?: boolean
  componentEstimates?: Record<string, number> | null
  latencyMs?: number | null
  retryCount?: number
  failureCode?: string | null
  requestId?: string | null
}

export class GtmAiMeteringError extends Error {
  constructor(message = 'GTM AI usage could not be recorded') {
    super(message)
    this.name = 'GtmAiMeteringError'
  }
}

function boundedInteger(value: number | null | undefined, max: number): number | null {
  return Number.isFinite(value) && value != null
    ? Math.max(0, Math.min(Math.round(value), max))
    : null
}

function normalizeComponents(input: Record<string, number> | null | undefined): Record<string, number> | null {
  if (!input) return null
  return Object.fromEntries(COMPONENT_KEYS.map((key) => [key, boundedInteger(input[key], 10_000_000) ?? 0]))
}

function costEstimate(tokensIn: number, tokensOut: number): {
  estimatedCostMicrousd: number | null
  rateCardVersion: string | null
} {
  const version = process.env.GTM_AI_RATE_CARD_VERSION?.trim()
  const inputRate = Number(process.env.GTM_AI_INPUT_USD_PER_MILLION_TOKENS)
  const outputRate = Number(process.env.GTM_AI_OUTPUT_USD_PER_MILLION_TOKENS)
  if (!version || !Number.isFinite(inputRate) || inputRate < 0 || !Number.isFinite(outputRate) || outputRate < 0) {
    return { estimatedCostMicrousd: null, rateCardVersion: null }
  }
  // USD / 1M tokens converted to micro-USD cancels the 1M divisor.
  const estimate = Math.round(tokensIn * inputRate + tokensOut * outputRate)
  if (!Number.isSafeInteger(estimate) || estimate < 0) {
    return { estimatedCostMicrousd: null, rateCardVersion: null }
  }
  return { estimatedCostMicrousd: estimate, rateCardVersion: version.slice(0, 200) }
}

export async function recordGtmAiTelemetry(
  em: CampaignEm,
  ctx: Pick<GtmCtx, 'organizationId' | 'tenantId'>,
  input: GtmAiTelemetryInput,
): Promise<GtmAiTelemetry> {
  const operationKey = input.operationKey.trim().slice(0, 500)
  const existing = await em.findOne(GtmAiTelemetry, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    operationKey,
    deletedAt: null,
  })
  if (existing) return existing
  const tokensIn = boundedInteger(input.tokensIn, 100_000_000) ?? 0
  const tokensOut = boundedInteger(input.tokensOut, 100_000_000) ?? 0
  const tokenUsageKnown = input.tokenUsageKnown !== false
  const cost = tokenUsageKnown
    ? costEstimate(tokensIn, tokensOut)
    : { estimatedCostMicrousd: null, rateCardVersion: null }
  const row = em.create(GtmAiTelemetry, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    operationKey,
    surface: input.surface.trim().slice(0, 200),
    model: input.model?.trim().slice(0, 200) || null,
    status: input.status,
    tokensIn,
    tokensOut,
    tokenUsageKnown,
    componentEstimates: normalizeComponents(input.componentEstimates),
    latencyMs: boundedInteger(input.latencyMs, 24 * 60 * 60 * 1000),
    retryCount: boundedInteger(input.retryCount, 100) ?? 0,
    estimatedCostMicrousd: cost.estimatedCostMicrousd,
    rateCardVersion: cost.rateCardVersion,
    failureCode: input.failureCode?.trim().slice(0, 200) || null,
    requestId: input.requestId?.trim().slice(0, 500) || null,
  })
  em.persist(row)
  try {
    await em.flush()
    return row
  } catch (error) {
    if (!(error instanceof UniqueConstraintViolationException)) throw error
    const winner = await em.findOne(GtmAiTelemetry, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      operationKey,
      deletedAt: null,
    })
    if (!winner) throw error
    return winner
  }
}

/*
 * Settles a pending local receipt after canonical metering returned. A row
 * that already reads 'succeeded' (a replayed call whose canonical write landed
 * earlier) is never downgraded by a later transport failure: the canonical
 * usage row exists, so the local receipt stays truthful.
 */
export async function settleGtmAiTelemetry(
  em: CampaignEm,
  ctx: Pick<GtmCtx, 'organizationId' | 'tenantId'>,
  input: {
    operationKey: string
    status: 'succeeded' | 'failed'
    failureCode?: string | null
  },
): Promise<GtmAiTelemetry | null> {
  const operationKey = input.operationKey.trim().slice(0, 500)
  const row = await em.findOne(GtmAiTelemetry, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    operationKey,
    deletedAt: null,
  })
  if (!row) return null
  if (row.status === 'succeeded' && input.status === 'failed') return row
  row.status = input.status
  if (input.failureCode !== undefined) {
    row.failureCode = input.failureCode?.trim().slice(0, 200) || null
  }
  em.persist(row)
  await em.flush()
  return row
}

export function createGtmTelemetryMeter(input: {
  em: CampaignEm
  ctx: GtmCtx
  operationKey: string
  surface: string
  canonicalMeter: GtmCanonicalAiMeter
}): GtmAiMeter {
  let invocation = 0
  return async (usage) => {
    invocation += 1
    const operationKey = `${input.operationKey}:call:${invocation}`
    // Preserve a local, content-free receipt BEFORE crossing the Noli Core
    // boundary, in status 'pending': the row must never claim 'succeeded'
    // until the canonical usage write has actually landed, otherwise an
    // outage produces a dashboard full of successes with no usage behind
    // them. If canonical metering is unavailable the call is not returned as
    // successful, while the exact invocation remains observable for operator
    // reconciliation.
    let recorded = false
    try {
      await recordGtmAiTelemetry(input.em, input.ctx, {
        operationKey,
        surface: input.surface,
        model: usage.model,
        status: 'pending',
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        tokenUsageKnown: usage.tokenUsageKnown,
        componentEstimates: usage.componentEstimates ?? null,
        latencyMs: usage.latencyMs ?? null,
        retryCount: usage.retryCount ?? 0,
        failureCode: usage.failureCode ?? null,
        requestId: input.ctx.requestId ?? null,
      })
      recorded = true
    } catch (error) {
      // Canonical metering can still succeed even if observational telemetry
      // is degraded. Never skip the customer credit write because this table
      // failed independently.
      console.error('[gtm.ai.telemetry]', error)
    }
    try {
      await input.canonicalMeter(usage, operationKey)
    } catch (error) {
      if (recorded) {
        try {
          await settleGtmAiTelemetry(input.em, input.ctx, {
            operationKey,
            status: 'failed',
            failureCode: CANONICAL_METERING_FAILED,
          })
        } catch (settleError) {
          console.error('[gtm.ai.telemetry]', settleError)
        }
      }
      throw new GtmAiMeteringError(
        error instanceof Error ? error.message : 'GTM AI usage could not be recorded',
      )
    }
    if (recorded) {
      try {
        await settleGtmAiTelemetry(input.em, input.ctx, {
          operationKey,
          status: usage.status ?? 'succeeded',
        })
      } catch (error) {
        console.error('[gtm.ai.telemetry]', error)
      }
    }
  }
}
