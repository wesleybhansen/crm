export const metadata = { GET: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

    // Total emails sent in last 30 days
    const [{ count: totalSent }] = await knex('email_messages')
      .where('organization_id', auth.orgId)
      .where('direction', 'outbound')
      .where('created_at', '>=', thirtyDaysAgo)
      .count()

    // Bounced
    const [{ count: bounced }] = await knex('email_messages')
      .where('organization_id', auth.orgId)
      .where('status', 'bounced')
      .where('created_at', '>=', thirtyDaysAgo)
      .count()

    // Complaints (from unsubscribes with reason = spam_complaint)
    const [{ count: complaints }] = await knex('email_unsubscribes')
      .where('organization_id', auth.orgId)
      .where('reason', 'spam_complaint')
      .where('created_at', '>=', thirtyDaysAgo)
      .count()

    // Unsubscribes (all reasons)
    const [{ count: unsubscribes }] = await knex('email_unsubscribes')
      .where('organization_id', auth.orgId)
      .where('created_at', '>=', thirtyDaysAgo)
      .count()

    // Suppressed contacts count
    const [{ count: suppressed }] = await knex('customer_entities')
      .where('organization_id', auth.orgId)
      .whereIn('email_status', ['hard_bounced', 'complained'])
      .count()

    // Contacts with no opens in 90 days
    let inactiveCount = 0
    try {
      const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
      const inactive = await knex('customer_entities as ce')
        .where('ce.organization_id', auth.orgId)
        .where('ce.email_status', 'active')
        .whereNotNull('ce.primary_email')
        .whereNull('ce.deleted_at')
        .whereNotExists(
          knex('email_messages')
            .whereRaw('email_messages.contact_id = ce.id')
            .where('email_messages.opened_at', '>=', ninetyDaysAgo)
            .select(knex.raw('1'))
        )
        .count()
        .first()
      inactiveCount = Number(inactive?.count || 0)
    } catch { /* ignore — non-critical */ }

    const total = Number(totalSent) || 1
    const bounceRate = ((Number(bounced) / total) * 100).toFixed(2)
    const complaintRate = ((Number(complaints) / total) * 100).toFixed(3)
    const unsubRate = ((Number(unsubscribes) / total) * 100).toFixed(2)

    const warnings: string[] = []
    if (Number(bounceRate) > 2) warnings.push(`Bounce rate is ${bounceRate}% (should be under 2%)`)
    if (Number(complaintRate) > 0.1) warnings.push(`Complaint rate is ${complaintRate}% (should be under 0.1%)`)
    if (Number(unsubRate) > 5) warnings.push(`Unsubscribe rate is ${unsubRate}% — consider reviewing your email content`)

    return NextResponse.json({
      ok: true,
      data: {
        period: 'last 30 days',
        totalSent: Number(totalSent),
        bounced: Number(bounced),
        complaints: Number(complaints),
        unsubscribes: Number(unsubscribes),
        bounceRate: Number(bounceRate),
        complaintRate: Number(complaintRate),
        unsubscribeRate: Number(unsubRate),
        suppressedContacts: Number(suppressed),
        inactiveContacts: inactiveCount,
        warnings,
        healthy: warnings.length === 0,
      },
    })
  } catch (error) {
    console.error('[email.health]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Email', summary: 'Email health metrics',
  methods: { GET: { summary: 'Get email deliverability health metrics', tags: ['Email'] } },
}
