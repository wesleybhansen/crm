/**
 * AI Gateway — all AI calls go through here.
 * Handles: usage tracking, cap enforcement, BYOK fallback.
 */

import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

export interface AICallResult {
  allowed: boolean
  reason?: string
  apiKey: string
  provider: string
  model: string
}

/**
 * Check if an AI call is allowed and return the appropriate API key.
 * Call this before every AI API call.
 */
export async function checkAIAccess(): Promise<AICallResult> {
  const auth = await getAuthFromCookies()
  const systemKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY || ''
  const provider = process.env.AI_PROVIDER || 'google'
  const model = process.env.AI_MODEL || 'gemini-2.0-flash'

  if (!auth?.orgId) {
    return { allowed: !!systemKey, apiKey: systemKey, provider, model }
  }

  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()

    const month = new Date().toISOString().substring(0, 7) // '2026-03'

    // Get current usage
    let usage = await knex('ai_usage')
      .where('organization_id', auth.orgId)
      .where('month', month)
      .first()

    if (!usage) {
      // Create usage record
      await knex('ai_usage').insert({
        id: require('crypto').randomUUID(),
        tenant_id: auth.tenantId,
        organization_id: auth.orgId,
        month,
        call_count: 0,
        token_count: 0,
        updated_at: new Date(),
      })
      usage = { call_count: 0 }
    }

    // Get cap — check org-specific override first, then global platform setting, then default
    const orgCap = await knex('ai_settings')
      .where('setting_key', 'monthly_ai_cap')
      .where('organization_id', auth.orgId)
      .first()
    let cap = 500
    if (orgCap) {
      cap = parseInt(orgCap.setting_value)
    } else {
      try {
        const globalCap = await knex('platform_settings')
          .where('setting_key', 'global_ai_monthly_cap')
          .first()
        if (globalCap) cap = parseInt(globalCap.setting_value)
      } catch {} // table may not exist yet
    }

    // Check if under cap
    if (usage.call_count < cap) {
      return { allowed: true, apiKey: systemKey, provider, model }
    }

    // Over cap — check for BYOK
    const userKey = await knex('ai_settings')
      .where('setting_key', 'user_ai_key')
      .where('user_id', auth.sub)
      .first()

    if (userKey?.setting_value) {
      // Detect provider from key format
      const key = userKey.setting_value
      let userProvider = provider
      if (key.startsWith('sk-')) userProvider = 'openai'
      else if (key.startsWith('AIza')) userProvider = 'google'

      return {
        allowed: true,
        apiKey: key,
        provider: userProvider,
        model: userProvider === 'openai' ? 'gpt-4o-mini' : model,
      }
    }

    return {
      allowed: false,
      reason: 'Monthly AI limit reached. Add your own API key in Settings to continue using AI features.',
      apiKey: '',
      provider,
      model,
    }
  } catch {
    // On error, allow with system key (don't block users due to DB issues)
    return { allowed: !!systemKey, apiKey: systemKey, provider, model }
  }
}

/**
 * Track an AI call after it completes.
 */
export async function trackAIUsage(tokenCount: number = 0): Promise<void> {
  try {
    const auth = await getAuthFromCookies()
    if (!auth?.orgId) return

    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()

    const month = new Date().toISOString().substring(0, 7)

    await knex('ai_usage')
      .where('organization_id', auth.orgId)
      .where('month', month)
      .increment('call_count', 1)
      .increment('token_count', tokenCount)
      .update('updated_at', new Date())

    // If no row was updated, create one
    const updated = await knex('ai_usage')
      .where('organization_id', auth.orgId)
      .where('month', month)
      .first()

    if (!updated) {
      await knex('ai_usage').insert({
        id: require('crypto').randomUUID(),
        tenant_id: auth.tenantId,
        organization_id: auth.orgId,
        month,
        call_count: 1,
        token_count: tokenCount,
        updated_at: new Date(),
      }).catch(() => {})
    }
  } catch {}
}
