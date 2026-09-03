import type { EntityManager } from '@mikro-orm/postgresql'
import type { SourceAdapterContext } from './registry'
import { threadsKeywordSearchEnabled } from './threads/keyword-search-opportunity-source'
import {
  createThreadsConnectionAccess,
  findActiveThreadsConnection,
  type ThreadsConnectionEm,
} from './threads/connection'

type TenantEncryption = {
  isEnabled(): boolean
  getDek(tenantId: string): Promise<{ key: string } | null>
}

type Container = { resolve(name: string): unknown }

/**
 * Resolves the customer-grant-backed adapter context for one org/tenant.
 * Every failure path yields an empty context (the grant-backed sources are
 * absent), never a thrown error, so a missing key or connection cannot break
 * planning for the deployment-gated sources.
 */
export async function resolveSourceAdapterContext(
  container: Container,
  em: EntityManager,
  scope: { organizationId: string; tenantId: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<SourceAdapterContext> {
  if (!threadsKeywordSearchEnabled(env)) return {}
  try {
    const { GtmSocialConnection } = await import('../../data/entities')
    const connection = await findActiveThreadsConnection(
      em as unknown as ThreadsConnectionEm,
      GtmSocialConnection,
      scope,
    )
    if (!connection) return {}
    const encryption = container.resolve('tenantEncryptionService') as TenantEncryption | null
    if (!encryption?.isEnabled()) return {}
    const dek = await encryption.getDek(scope.tenantId)
    if (!dek?.key) return {}
    return {
      threadsConnection: createThreadsConnectionAccess(
        em as unknown as ThreadsConnectionEm,
        connection,
        { dekKey: dek.key },
      ),
    }
  } catch (error) {
    console.error('[gtm.adapters] Threads connection context unavailable', error)
    return {}
  }
}
