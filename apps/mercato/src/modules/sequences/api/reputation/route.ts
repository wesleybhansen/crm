/* eslint-disable @typescript-eslint/no-explicit-any */
export const metadata = { GET: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

/**
 * Reputation dashboard data: review-request send counts (30/90 days) and the
 * most recent review requests with contact names. Backs /backend/reputation.
 * Resilient to scripts/sql/reputation.sql not being applied yet (returns zeros).
 */

export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    const knex = em.getKnex()

    let sent30 = 0
    let sent90 = 0
    let recent: Array<Record<string, any>> = []

    try {
      const now = Date.now()
      const d30 = new Date(now - 30 * 24 * 60 * 60 * 1000)
      const d90 = new Date(now - 90 * 24 * 60 * 60 * 1000)

      const [row30, row90] = await Promise.all([
        knex('review_requests').where('organization_id', auth.orgId).where('sent_at', '>=', d30).count('id as count').first(),
        knex('review_requests').where('organization_id', auth.orgId).where('sent_at', '>=', d90).count('id as count').first(),
      ])
      sent30 = Number((row30 as any)?.count || 0)
      sent90 = Number((row90 as any)?.count || 0)

      recent = await knex('review_requests')
        .where('organization_id', auth.orgId)
        .orderBy('sent_at', 'desc')
        .limit(20)
    } catch {
      // review_requests table not created yet — return an empty dashboard.
    }

    // Resolve contact names (decrypted) and rule names for the recent list.
    const contactNames = new Map<string, { name: string; email: string | null }>()
    const contactIds = Array.from(new Set(recent.map((r) => r.contact_id).filter(Boolean)))
    if (contactIds.length > 0) {
      try {
        const { findWithDecryption } = await import('@open-mercato/shared/lib/encryption/find')
        const contacts = await findWithDecryption(em, 'CustomerEntity' as any, { id: { $in: contactIds } } as any)
        for (const c of contacts as any[]) {
          contactNames.set(String(c.id), {
            name: c.displayName || c.display_name || '',
            email: c.primaryEmail || c.primary_email || null,
          })
        }
      } catch {
        // Fall back to ids only.
      }
    }

    const ruleNames = new Map<string, string>()
    const ruleIds = Array.from(new Set(recent.map((r) => r.rule_id).filter(Boolean)))
    if (ruleIds.length > 0) {
      try {
        const rules = await knex('automation_rules').whereIn('id', ruleIds).select('id', 'name')
        for (const r of rules) ruleNames.set(String(r.id), r.name)
      } catch {}
    }

    return NextResponse.json({
      ok: true,
      data: {
        sent30,
        sent90,
        recent: recent.map((r) => ({
          id: r.id,
          contact_id: r.contact_id,
          contact_name: contactNames.get(String(r.contact_id))?.name || null,
          contact_email: contactNames.get(String(r.contact_id))?.email || null,
          channel: r.channel,
          status: r.status,
          sent_at: r.sent_at,
          rule_id: r.rule_id,
          rule_name: r.rule_id ? ruleNames.get(String(r.rule_id)) || null : null,
        })),
      },
    })
  } catch (error) {
    console.error('[reputation] GET error', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Reputation',
  summary: 'Review request stats and history',
  methods: {
    GET: { summary: 'Review requests sent in the last 30/90 days plus the most recent requests', tags: ['Reputation'] },
  },
}
