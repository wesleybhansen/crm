import type { EntityManager } from '@mikro-orm/postgresql'
import { dispatchWebhook } from './dispatch'

export type ResolverContext = { resolve: <T = unknown>(name: string) => T }

/**
 * Shared handler used by the per-module-event subscribers in this module.
 * Looks up knex, calls dispatchWebhook with the public event name.
 *
 * Each subscriber file is a thin wrapper around this so the mapping from
 * internal event → public event is explicit and grep-able.
 */
export async function dispatchFromInternalEvent(
  publicEventId: string,
  payload: { id?: string; organizationId?: string | null; [key: string]: unknown },
  ctx: ResolverContext,
): Promise<void> {
  if (!payload?.organizationId) return
  try {
    const em = ctx.resolve<EntityManager>('em')
    const knex = em.getKnex()
    await dispatchWebhook(knex, payload.organizationId as string, publicEventId, payload as Record<string, unknown>)
  } catch (err) {
    console.error(`[webhooks.subscriber] dispatch failed for ${publicEventId}`, err)
  }
}
