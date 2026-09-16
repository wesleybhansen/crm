import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import './commands/social'

type CommandBusLike = {
  execute<TInput, TResult>(
    id: string,
    payload: { input: TInput; ctx: Record<string, unknown> },
  ): Promise<{ result: TResult }>
}

/*
 * Cron entry point for Threads OAuth token maintenance. The command itself
 * needs no user or organization scope (it walks every active connection and
 * refreshes tokens under each tenant's own key), so the CLI runs it with an
 * empty auth context. Usage: `mercato gtm social:refresh-threads-tokens`.
 */
const refreshThreadsTokens: ModuleCli = {
  command: 'social:refresh-threads-tokens',
  async run() {
    const container = await createRequestContainer()
    const commandBus = container.resolve('commandBus') as CommandBusLike
    const executed = await commandBus.execute<Record<string, never>, Record<string, number>>(
      'gtm.social.refresh-threads-tokens',
      {
        input: {},
        ctx: {
          container,
          auth: null,
          organizationScope: null,
          selectedOrganizationId: null,
          organizationIds: null,
        },
      },
    )
    console.log(JSON.stringify({ command: 'gtm.social.refresh-threads-tokens', ...executed.result }))
  },
}

/*
 * One-time backfill: give every live play with no name the same short name
 * the creation path generates (lib/play-name.ts, the Strategist model, 3 to 6
 * words from audience + signal).
 *
 *   mercato gtm plays:name-backfill                 # dry run, writes nothing
 *   mercato gtm plays:name-backfill --apply         # names them
 *   mercato gtm plays:name-backfill --apply --limit 25
 *
 * Dry run by default, deliberately: it prints how many plays would be named
 * and what the model calls are estimated to cost BEFORE anything is spent,
 * and it calls no model (the names it shows are the deterministic fallbacks,
 * which is also what a play gets when its model call fails).
 *
 * Idempotent: only rows whose name is still null are candidates, and each
 * write is a conditional UPDATE on name still being null, so re-running names
 * nothing twice and a play named concurrently by its creation path is left
 * alone. A single play's failure never aborts the batch.
 *
 * Service-level, like the /internal/gtm/plays/name-backfill route it shares
 * its engine with: it walks every organization and meters each model call
 * against the play's own org under feature 'gtm-play-name'.
 */
const PLAY_NAME_BATCH_SIZE = 50
const PLAY_NAME_MAX_BATCHES = 200

function flagValue(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag)
  if (index < 0) return null
  return argv[index + 1] ?? null
}

const backfillPlayNamesCommand: ModuleCli = {
  command: 'plays:name-backfill',
  async run(argv) {
    const apply = argv.includes('--apply')
    const limitRaw = flagValue(argv, '--limit')
    const limit = limitRaw != null && /^\d+$/.test(limitRaw.trim()) ? Number(limitRaw.trim()) : null
    if (limitRaw != null && limit == null) {
      console.error('--limit must be a positive whole number')
      process.exitCode = 1
      return
    }

    const container = await createRequestContainer()
    const em = container.resolve('em') as import('@mikro-orm/postgresql').EntityManager
    const { GtmPlay } = await import('./data/entities')
    const { backfillPlayNames } = await import('./lib/play-name-backfill')
    const { estimatePlayNameCost, formatPlayNameCost } = await import('./lib/play-name-cost')
    const { createPlayNamer } = await import('./lib/play-name-runtime')

    // Cost first, always, whether or not this run writes. The estimate covers
    // the rows this invocation would actually touch, not the whole table.
    const pending = await em.find(
      GtmPlay,
      { name: null, deletedAt: null },
      { orderBy: { createdAt: 'asc' }, ...(limit ? { limit } : {}) },
    )
    const estimate = estimatePlayNameCost(pending)
    console.log(formatPlayNameCost(estimate))

    if (pending.length === 0) {
      console.log('Every live play already has a name. Nothing to do.')
      return
    }

    if (!apply) {
      console.log('Dry run: no model was called and nothing was written. Re-run with --apply to name them.')
      console.log('Fallback names for the first few rows (a live run replaces these with model names):')
      const preview = await backfillPlayNames(em, { dryRun: true, limit: Math.min(pending.length, 10) }, async () => null)
      for (const row of preview.sample) console.log(`  ${row.id}  ${row.name}`)
      return
    }

    let considered = 0
    let named = 0
    let failed = 0
    for (let batch = 0; batch < PLAY_NAME_MAX_BATCHES; batch += 1) {
      const remaining = limit != null ? limit - considered : PLAY_NAME_BATCH_SIZE
      if (remaining <= 0) break
      const result = await backfillPlayNames(
        em,
        { dryRun: false, limit: Math.min(PLAY_NAME_BATCH_SIZE, remaining) },
        async (play) => createPlayNamer(
          em,
          { organizationId: play.organizationId, tenantId: play.tenantId, requestId: null },
          null,
        ),
      )
      considered += result.considered
      named += result.named
      failed += result.failed
      if (result.considered === 0) break
    }
    console.log(JSON.stringify({ command: 'gtm plays:name-backfill', applied: true, considered, named, failed }))
  },
}

const commands: ModuleCli[] = [refreshThreadsTokens, backfillPlayNamesCommand]

export default commands
