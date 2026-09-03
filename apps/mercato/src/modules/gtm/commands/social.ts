import type { EntityManager } from '@mikro-orm/postgresql'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import type { CommandHandler } from '@open-mercato/shared/lib/commands'
import { GtmSocialConnection } from '../data/entities'
import {
  THREADS_PROVIDER,
  ThreadsOAuthError,
  refreshThreadsToken,
  sealThreadsToken,
  openThreadsToken,
  shouldRefreshThreadsToken,
} from '../lib/adapters/threads/connection'

export type RefreshThreadsTokensResult = {
  scanned: number
  refreshed: number
  invalidated: number
  skipped: number
}

/**
 * Proactive 60-day token maintenance for every active Threads connection.
 * The adapter already refreshes lazily on use; this keeps idle connections
 * alive so a customer who runs research monthly is not forced to reconnect.
 * Intended for a daily cron: `mercato gtm.social.refresh-threads-tokens`.
 */
const refreshCommand: CommandHandler<Record<string, never>, RefreshThreadsTokensResult> = {
  id: 'gtm.social.refresh-threads-tokens',
  async execute(_input, runtime) {
    const em = runtime.container.resolve('em') as EntityManager
    const encryption = runtime.container.resolve('tenantEncryptionService') as {
      isEnabled(): boolean
      getDek(tenantId: string): Promise<{ key: string } | null>
    } | null
    const result: RefreshThreadsTokensResult = { scanned: 0, refreshed: 0, invalidated: 0, skipped: 0 }
    if (!encryption?.isEnabled()) return result
    const rows = await em.find(GtmSocialConnection, { provider: THREADS_PROVIDER, status: 'active', deletedAt: null })
    const now = new Date()
    for (const row of rows) {
      result.scanned += 1
      if (!shouldRefreshThreadsToken(row, now)) {
        result.skipped += 1
        continue
      }
      const dek = await encryption.getDek(row.tenantId)
      if (!dek?.key) {
        result.skipped += 1
        continue
      }
      try {
        const refreshed = await refreshThreadsToken(openThreadsToken(row.accessTokenSealed, dek.key))
        row.accessTokenSealed = sealThreadsToken(refreshed.accessToken, dek.key)
        row.lastRefreshedAt = now
        row.tokenExpiresAt = new Date(now.getTime() + refreshed.expiresInSeconds * 1_000)
        result.refreshed += 1
      } catch (error) {
        if (error instanceof ThreadsOAuthError && error.code === 'token_invalid') {
          row.status = 'reauth_required'
          row.statusReason = 'refresh_rejected'
          result.invalidated += 1
        } else {
          result.skipped += 1
        }
      }
      em.persist(row)
    }
    await em.flush()
    return result
  },
  buildLog: ({ result }) => ({
    actionLabel: 'gtm.social.refresh-threads-tokens',
    resourceKind: 'gtm_social_connection',
    payload: result,
  }),
}

registerCommand(refreshCommand)
