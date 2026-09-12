import { GtmPlay } from '../data/entities'
import { fallbackPlayName, type GeneratedPlayName } from './play-name'

/*
 * Name backfill for plays created before gtm_plays.name existed. Pure
 * orchestration over a narrow EntityManager slice (FakeEm-testable); the
 * route supplies the per-org namer factory. Rules:
 *
 *   - candidates are live rows with name IS NULL, oldest first, capped by
 *     `limit` (default 50, max 500 from the validator)
 *   - dryRun NEVER calls the model and NEVER writes: it reports the
 *     deterministic fallback names so an operator can eyeball them
 *   - each write is one conditional UPDATE (name still null): a play named
 *     concurrently by its creation path is left alone and counted as named
 *   - one play's failure never aborts the batch; it is counted in `failed`
 *   - the result carries at most SAMPLE_CAP {id, name} pairs and no audience
 *     text, so the response never becomes a bulk export of play content
 */

export const PLAY_NAME_BACKFILL_DEFAULT_LIMIT = 50
export const PLAY_NAME_BACKFILL_SAMPLE_CAP = 10

export type PlayNameBackfillEm = {
  find<T extends object>(
    entityClass: new () => T,
    where: Record<string, unknown>,
    options?: { orderBy?: Record<string, 'asc' | 'desc'>; limit?: number },
  ): Promise<T[]>
  nativeUpdate<T extends object>(
    entityClass: new () => T,
    where: Record<string, unknown>,
    data: Record<string, unknown>,
  ): Promise<number>
}

export type PlayNameBackfillNamer = (play: GtmPlay) => Promise<GeneratedPlayName>

// Resolves the namer for a play's org, or null to use the deterministic
// fallback (no allowance, no key). Called at most once per (org, tenant).
export type PlayNameBackfillNamerFactory = (play: GtmPlay) => Promise<PlayNameBackfillNamer | null>

export type PlayNameBackfillResult = {
  considered: number
  named: number
  failed: number
  sample: { id: string; name: string }[]
}

export async function backfillPlayNames(
  em: PlayNameBackfillEm,
  input: { dryRun: boolean; limit?: number },
  namerFor: PlayNameBackfillNamerFactory,
): Promise<PlayNameBackfillResult> {
  const limit = Number.isSafeInteger(input.limit) && (input.limit as number) > 0
    ? (input.limit as number)
    : PLAY_NAME_BACKFILL_DEFAULT_LIMIT
  const rows = await em.find(
    GtmPlay,
    { name: null, deletedAt: null },
    { orderBy: { createdAt: 'asc' }, limit },
  )
  const result: PlayNameBackfillResult = { considered: rows.length, named: 0, failed: 0, sample: [] }
  const namers = new Map<string, PlayNameBackfillNamer | null>()

  for (const play of rows) {
    try {
      let name: string
      if (input.dryRun) {
        name = fallbackPlayName(play)
      } else {
        const scope = `${play.organizationId}:${play.tenantId}`
        if (!namers.has(scope)) {
          let namer: PlayNameBackfillNamer | null = null
          try {
            namer = await namerFor(play)
          } catch (error) {
            console.error('[gtm.play-name.backfill] namer unavailable, using fallback', error instanceof Error ? error.message : error)
          }
          namers.set(scope, namer)
        }
        const namer = namers.get(scope) ?? null
        name = namer ? (await namer(play)).name : fallbackPlayName(play)
        await em.nativeUpdate(
          GtmPlay,
          { id: play.id, organizationId: play.organizationId, tenantId: play.tenantId, name: null },
          { name },
        )
      }
      result.named += 1
      if (result.sample.length < PLAY_NAME_BACKFILL_SAMPLE_CAP) result.sample.push({ id: play.id, name })
    } catch (error) {
      result.failed += 1
      console.error('[gtm.play-name.backfill] play skipped', play.id, error instanceof Error ? error.message : error)
    }
  }
  return result
}
