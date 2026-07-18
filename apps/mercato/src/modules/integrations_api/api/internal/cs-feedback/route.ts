import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'

/* Internal service endpoint (shared NOLI_INTERNAL_SERVICE_SECRET). When the user
 * leaves feedback in the hub inbox's Recent Work tab on a customer-service reply,
 * this writes it into the CRM's customer_service_knowledge (kind 'guidance') —
 * the same store the drafter consults — so the correction sharpens future drafts.
 * Org+tenant scoped. Capped so the store can't grow unbounded. */

export const metadata = {
  path: '/internal/cs-feedback',
  POST: { requireAuth: false },
}

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}

type Auth = { userId: string; orgId: string; tenantId: string }
async function resolveAuth(noliUserId: string): Promise<Auth | null> {
  const { findNoliUserById } = await import('@open-mercato/shared/lib/noli/core-client')
  const noliUser = await findNoliUserById(noliUserId)
  if (!noliUser?.clerk_user_id) return null
  const { resolveClerkUserToAuthContext } = await import('@open-mercato/shared/lib/auth/clerk')
  const a = await resolveClerkUserToAuthContext(noliUser.clerk_user_id)
  if (!a?.userId || !a?.orgId || !a?.tenantId) return null
  return { userId: String(a.userId), orgId: String(a.orgId), tenantId: String(a.tenantId) }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Knex = any

export async function POST(req: Request) {
  const secret = process.env.NOLI_INTERNAL_SERVICE_SECRET
  const authHeader = (req.headers.get('authorization') || '').trim()
  if (!secret || !safeEq(authHeader, `Bearer ${secret}`)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const noliUserId = typeof body.noliUserId === 'string' ? body.noliUserId.trim() : ''
  const feedback = typeof body.feedback === 'string' ? body.feedback.trim() : ''
  const itemTitle = typeof body.itemTitle === 'string' ? body.itemTitle.slice(0, 200) : ''
  if (!noliUserId || !feedback) return NextResponse.json({ ok: false, error: 'noliUserId and feedback are required' }, { status: 400 })

  try {
    const auth = await resolveAuth(noliUserId)
    if (!auth) return NextResponse.json({ ok: false, error: 'no CRM account for this user' }, { status: 404 })
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex() as Knex

    const now = new Date()
    const title = `Your feedback${itemTitle ? `: ${itemTitle}` : ''}`.slice(0, 200)
    await knex('customer_service_knowledge').insert({
      id: crypto.randomUUID(),
      tenant_id: auth.tenantId,
      organization_id: auth.orgId,
      // Same kind the drafter's approved-reply captures use, so it consults this.
      kind: 'model_answer',
      title,
      content: feedback.slice(0, 4000),
      is_active: true,
      created_at: now,
      updated_at: now,
    })

    // Keep the reviewer-feedback set bounded: newest 50 stay active.
    const excess = await knex('customer_service_knowledge')
      .where('organization_id', auth.orgId)
      .where('kind', 'model_answer')
      .where('title', 'like', 'Your feedback%')
      .where('is_active', true)
      .orderBy('updated_at', 'desc')
      .offset(50)
      .select('id')
    if (excess.length > 0) {
      await knex('customer_service_knowledge').whereIn('id', excess.map((r: { id: string }) => r.id)).update({ is_active: false, updated_at: now })
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[internal.cs-feedback]', error)
    return NextResponse.json({ ok: false, error: 'Server error' }, { status: 500 })
  }
}
