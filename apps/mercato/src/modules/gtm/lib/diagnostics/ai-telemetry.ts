import { GtmAiTelemetry } from '../../data/entities'
import type { CampaignEm, GtmCtx } from '../campaign/build'

export const AI_TELEMETRY_DIAGNOSTIC_CAP = 5_000

export type AiTelemetryDiagnosticRow = {
  surface: string
  model: string
  status: string
  operations: number
  usageKnown: number
  usageUnknown: number
  tokensInKnown: number
  tokensOutKnown: number
  retries: number
  latencySamples: number
  latencyTotalMs: number
  latencyMaxMs: number | null
  costSamples: number
  estimatedCostMicrousd: number
  lastObservedAt: Date | null
}

function boundedCount(value: unknown): number {
  const parsed = typeof value === 'bigint' ? Number(value) : Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

function later(left: Date | null, right: Date | null | undefined): Date | null {
  if (!right) return left
  return !left || right > left ? right : left
}

function emptyRow(row: GtmAiTelemetry): AiTelemetryDiagnosticRow {
  return {
    surface: row.surface || 'unknown',
    model: row.model || 'unknown',
    status: row.status || 'unknown',
    operations: 0,
    usageKnown: 0,
    usageUnknown: 0,
    tokensInKnown: 0,
    tokensOutKnown: 0,
    retries: 0,
    latencySamples: 0,
    latencyTotalMs: 0,
    latencyMaxMs: null,
    costSamples: 0,
    estimatedCostMicrousd: 0,
    lastObservedAt: null,
  }
}

function add(target: AiTelemetryDiagnosticRow, row: GtmAiTelemetry): void {
  const usageKnown = row.tokenUsageKnown !== false
  target.operations += 1
  target.usageKnown += usageKnown ? 1 : 0
  target.usageUnknown += usageKnown ? 0 : 1
  if (usageKnown) {
    target.tokensInKnown += boundedCount(row.tokensIn)
    target.tokensOutKnown += boundedCount(row.tokensOut)
  }
  target.retries += boundedCount(row.retryCount)
  if (row.latencyMs != null && boundedCount(row.latencyMs) === row.latencyMs) {
    target.latencySamples += 1
    target.latencyTotalMs += row.latencyMs
    target.latencyMaxMs = Math.max(target.latencyMaxMs ?? 0, row.latencyMs)
  }
  if (usageKnown && row.estimatedCostMicrousd != null) {
    target.costSamples += 1
    target.estimatedCostMicrousd += boundedCount(row.estimatedCostMicrousd)
  }
  target.lastObservedAt = later(target.lastObservedAt, row.createdAt)
}

export async function getAiTelemetryDiagnostics(
  em: CampaignEm,
  ctx: Pick<GtmCtx, 'organizationId' | 'tenantId'>,
): Promise<{
  totals: Omit<AiTelemetryDiagnosticRow, 'surface' | 'model' | 'status'>
  groups: AiTelemetryDiagnosticRow[]
  window: { rowCap: number; truncated: boolean }
}> {
  const window = await em.find(
    GtmAiTelemetry,
    {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      deletedAt: null,
    },
    { orderBy: { createdAt: 'desc' }, limit: AI_TELEMETRY_DIAGNOSTIC_CAP + 1 },
  )
  const rows = window.slice(0, AI_TELEMETRY_DIAGNOSTIC_CAP)
  const grouped = new Map<string, AiTelemetryDiagnosticRow>()
  const totals: AiTelemetryDiagnosticRow = {
    ...emptyRow(new GtmAiTelemetry()),
    surface: 'all',
    model: 'all',
    status: 'all',
  }
  for (const row of rows) {
    const key = `${row.surface}\u0000${row.model ?? 'unknown'}\u0000${row.status}`
    const group = grouped.get(key) ?? emptyRow(row)
    add(group, row)
    add(totals, row)
    grouped.set(key, group)
  }
  const totalValues: Omit<AiTelemetryDiagnosticRow, 'surface' | 'model' | 'status'> = {
    operations: totals.operations,
    usageKnown: totals.usageKnown,
    usageUnknown: totals.usageUnknown,
    tokensInKnown: totals.tokensInKnown,
    tokensOutKnown: totals.tokensOutKnown,
    retries: totals.retries,
    latencySamples: totals.latencySamples,
    latencyTotalMs: totals.latencyTotalMs,
    latencyMaxMs: totals.latencyMaxMs,
    costSamples: totals.costSamples,
    estimatedCostMicrousd: totals.estimatedCostMicrousd,
    lastObservedAt: totals.lastObservedAt,
  }
  return {
    totals: totalValues,
    groups: [...grouped.values()].sort((left, right) =>
      left.surface.localeCompare(right.surface)
      || left.model.localeCompare(right.model)
      || left.status.localeCompare(right.status),
    ),
    window: {
      rowCap: AI_TELEMETRY_DIAGNOSTIC_CAP,
      truncated: window.length > AI_TELEMETRY_DIAGNOSTIC_CAP,
    },
  }
}
