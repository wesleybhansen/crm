import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { syncPersonalInbox } from '@/modules/email/lib/personal-inbox-sync'

/* Batch cron: pull new incoming mail from EVERY user's active personal mailbox
 * into email_messages so the Unified Inbox stays current. Service-secret authed;
 * driven by /root/crm-cron/personal-inbox-sync.sh on the box. Short (3-day)
 * window since it runs frequently. Independent of the broken email-intelligence
 * pipeline. */

export const metadata = {
  path: '/internal/personal-inbox-sync',
  POST: { requireAuth: false },
}
export const dynamic = 'force-dynamic'
export const maxDuration = 300

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Knex = any

export async function POST(req: Request) {
  const secret = process.env.NOLI_INTERNAL_SERVICE_SECRET
  const authHeader = (req.headers.get('authorization') || '').trim()
  if (!secret || !safeEq(authHeader, `Bearer ${secret}`)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex() as Knex
    const rows = (await knex('email_connections')
      .where('is_active', true)
      .whereNull('purpose')
      .distinct('organization_id', 'tenant_id', 'user_id')
      .select('organization_id', 'tenant_id', 'user_id')) as Array<Record<string, unknown>>

    let synced = 0
    let users = 0
    const errors: string[] = []
    for (const r of rows) {
      const orgId = String(r.organization_id)
      const tenantId = String(r.tenant_id)
      const userId = String(r.user_id)
      if (!orgId || !userId) continue
      try {
        const res = await syncPersonalInbox(knex, orgId, tenantId, userId, 3)
        synced += res.synced
        users++
        if (res.errors.length) errors.push(...res.errors.slice(0, 1))
      } catch (e) {
        errors.push(e instanceof Error ? e.message : 'user sync failed')
      }
    }
    return NextResponse.json({ ok: true, users, synced, errors: errors.slice(0, 8) })
  } catch (e) {
    console.error('[personal-inbox-sync]', (e as Error).message)
    return NextResponse.json({ ok: false, error: 'Server error' }, { status: 500 })
  }
}
