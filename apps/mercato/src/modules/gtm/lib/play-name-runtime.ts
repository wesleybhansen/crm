import type { EntityManager } from '@mikro-orm/postgresql'
import type { GtmCtx } from './campaign/build'
import type { GtmPlay } from '../data/entities'
import {
  fallbackPlayName,
  generatePlayName,
  playNameModelId,
  type GeneratedPlayName,
  type PlayNameInput,
} from './play-name'

/*
 * Route-side wiring for play naming. Everything that touches the platform
 * (allowance gate, Gemini key, canonical Noli Core metering, local telemetry
 * receipt) lives here behind dynamic imports, exactly as the strategy /
 * campaigns routes wire their drafting calls, so lib/play-name.ts stays pure
 * and the unit suite never loads server-only modules.
 *
 * A "namer" is one prepared (org, tenant) context: the allowance has been
 * checked once, the model client built once, and each play then costs one
 * metered call keyed `gtm:play-name:<org>:<play id>` (idempotent on retry).
 */

export type PlayNamer = (play: PlayNameInput & { id: string }) => Promise<GeneratedPlayName>

export type PlayNameSurfaceCtx = Pick<GtmCtx, 'organizationId' | 'tenantId' | 'requestId'> & { userId?: string }

/*
 * Prepares a metered namer for one org, or returns null when the model must
 * not be called (no AI allowance, metering unavailable, no key configured).
 * Callers treat null as "use the deterministic fallback".
 */
export async function createPlayNamer(
  em: EntityManager,
  ctx: PlayNameSurfaceCtx,
  noliUserId: string | null,
): Promise<PlayNamer | null> {
  const { checkCustomersAiAllowance } = await import('@/lib/usage/allowance')
  const { meterCustomersAiStrict } = await import('@/lib/usage/meter')
  const gate = await checkCustomersAiAllowance(
    { orgId: ctx.organizationId },
    'google',
    { failureMode: 'closed' },
  )
  if (!gate.allowed) return null
  const apiKey = gate.byoApiKey || process.env.GOOGLE_GENERATIVE_AI_API_KEY
  if (!apiKey) return null

  const { createGeminiDraftModel, GTM_DRAFT_MODEL } = await import('./ai/model')
  const { createGtmTelemetryMeter } = await import('./ai/telemetry')
  const model = createGeminiDraftModel(apiKey, playNameModelId(GTM_DRAFT_MODEL))
  const telemetryCtx: GtmCtx = {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    userId: ctx.userId ?? 'system',
    requestId: ctx.requestId ?? null,
  }

  return async (play) => {
    const meter = createGtmTelemetryMeter({
      em,
      ctx: telemetryCtx,
      surface: 'play_name',
      operationKey: `gtm:play-name:${ctx.organizationId}:${play.id}`,
      canonicalMeter: async (usage, operationKey) => {
        await meterCustomersAiStrict({ orgId: ctx.organizationId }, {
          noliUserId,
          model: usage.model,
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
          feature: usage.feature,
          byoKey: !!gate.byoApiKey,
          idempotencyKey: operationKey,
          metadata: {
            status: usage.status === 'failed' ? 'failed' : 'completed',
            attempt: 1,
            token_usage_known: usage.tokenUsageKnown !== false,
            failure_code: usage.failureCode ?? null,
            retry_count: usage.retryCount ?? 0,
          },
        })
      },
    })
    return generatePlayName({ model, meter }, play)
  }
}

/*
 * Names one freshly committed play. Never throws: any failure leaves the row
 * unnamed for the backfill and returns null. The write is a single
 * conditional UPDATE (name still null) so a concurrent namer never
 * overwrites a name that landed first, and so it works regardless of which
 * EntityManager fork created the row.
 */
export async function assignNameToNewPlay(
  em: EntityManager,
  ctx: PlayNameSurfaceCtx,
  play: GtmPlay,
  noliUserId: string | null,
): Promise<string | null> {
  if (play.name) return play.name
  try {
    let generated: GeneratedPlayName
    try {
      const namer = await createPlayNamer(em, ctx, noliUserId)
      generated = namer
        ? await namer(play)
        : { name: fallbackPlayName(play), source: 'fallback', failureCode: 'model_unavailable' }
    } catch (error) {
      console.error('[gtm.play-name] model path failed, using fallback', error instanceof Error ? error.message : error)
      generated = { name: fallbackPlayName(play), source: 'fallback', failureCode: 'model_unavailable' }
    }
    const { GtmPlay: GtmPlayEntity } = await import('../data/entities')
    const updated = await em.nativeUpdate(
      GtmPlayEntity,
      { id: play.id, organizationId: ctx.organizationId, tenantId: ctx.tenantId, name: null },
      { name: generated.name },
    )
    if (updated === 0) return null
    play.name = generated.name
    return generated.name
  } catch (error) {
    console.error('[gtm.play-name] naming skipped', error instanceof Error ? error.message : error)
    return null
  }
}
