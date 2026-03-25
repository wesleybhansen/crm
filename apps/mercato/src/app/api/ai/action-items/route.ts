import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

export async function GET() {
  try {
    const auth = await getAuthFromCookies()
    if (!auth?.tenantId || !auth?.orgId) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    }

    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const w = { tenant_id: auth.tenantId, organization_id: auth.orgId }

    const now = new Date()
    const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000)
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

    const actionItems: Array<{ type: string; title: string; description: string; href: string; priority: number }> = []

    // 1. Stale deals (not updated in 5+ days)
    try {
      const staleDeals = await knex('customer_deals')
        .where(w).whereNull('deleted_at')
        .where('status', 'open')
        .where('updated_at', '<', fiveDaysAgo)
        .select('id', 'title', 'updated_at')
        .orderBy('updated_at', 'asc')
        .limit(3)

      for (const deal of staleDeals) {
        const days = Math.floor((now.getTime() - new Date(deal.updated_at).getTime()) / (1000 * 60 * 60 * 24))
        actionItems.push({
          type: 'deal',
          title: `Follow up on "${deal.title}"`,
          description: `This deal hasn't been updated in ${days} days.`,
          href: `/backend/customers/deals/${deal.id}`,
          priority: 1,
        })
      }
    } catch {}

    // 2. New form submissions without deals
    try {
      const recentSubmissions = await knex('form_submissions')
        .where('organization_id', auth.orgId)
        .where('created_at', '>', sevenDaysAgo)
        .whereNull('contact_id')
        .count('* as count')
        .first()

      const count = Number(recentSubmissions?.count || 0)
      if (count > 0) {
        actionItems.push({
          type: 'lead',
          title: `${count} new form submission${count > 1 ? 's' : ''} need review`,
          description: 'Leads from your landing pages are waiting to be followed up.',
          href: '/backend/landing-pages',
          priority: 2,
        })
      }
    } catch {}

    // 3. Contacts with no activity in 30+ days
    try {
      const [coldContacts] = await knex('customer_entities')
        .where(w).whereNull('deleted_at')
        .where('status', 'active')
        .where('updated_at', '<', thirtyDaysAgo)
        .count('* as count')

      const count = Number(coldContacts?.count || 0)
      if (count > 0) {
        actionItems.push({
          type: 'contact',
          title: `${count} contact${count > 1 ? 's' : ''} going cold`,
          description: 'No activity in 30+ days. Consider reaching out.',
          href: '/backend/customers/people',
          priority: 3,
        })
      }
    } catch {}

    // 4. No landing pages yet (getting started)
    try {
      const [lpCount] = await knex('landing_pages').where(w).whereNull('deleted_at').count('* as count')
      if (Number(lpCount?.count || 0) === 0) {
        actionItems.push({
          type: 'getting-started',
          title: 'Create your first landing page',
          description: 'Start capturing leads with an AI-generated landing page.',
          href: '/backend/landing-pages/create',
          priority: 4,
        })
      }
    } catch {}

    // 5. No contacts yet
    try {
      const [contactCount] = await knex('customer_entities').where(w).whereNull('deleted_at').count('* as count')
      if (Number(contactCount?.count || 0) === 0) {
        actionItems.push({
          type: 'getting-started',
          title: 'Add your first contact',
          description: 'Start building your contact list.',
          href: '/backend/customers/people',
          priority: 5,
        })
      }
    } catch {}

    // Stats
    const stats: Record<string, any> = {}

    try {
      const [cs] = await knex('customer_entities').where(w).whereNull('deleted_at').select(
        knex.raw('count(*) as total'),
        knex.raw('count(*) filter (where created_at >= ?) as last_7', [sevenDaysAgo]),
      )
      stats.contacts = { total: Number(cs?.total || 0), last7Days: Number(cs?.last_7 || 0) }
    } catch { stats.contacts = { total: 0, last7Days: 0 } }

    try {
      const [ds] = await knex('customer_deals').where(w).whereNull('deleted_at').select(
        knex.raw("count(*) filter (where status = 'open') as open_deals"),
        knex.raw("coalesce(sum(value_amount) filter (where status = 'open'), 0) as pipeline_value"),
        knex.raw("count(*) filter (where status = 'win' and updated_at >= ?) as won_7", [sevenDaysAgo]),
      )
      stats.deals = { open: Number(ds?.open_deals || 0), pipelineValue: Number(ds?.pipeline_value || 0), wonThisWeek: Number(ds?.won_7 || 0) }
    } catch { stats.deals = { open: 0, pipelineValue: 0, wonThisWeek: 0 } }

    try {
      const [lp] = await knex('landing_pages').where(w).whereNull('deleted_at').select(
        knex.raw("count(*) filter (where status = 'published') as published"),
        knex.raw('coalesce(sum(view_count), 0) as views'),
        knex.raw('coalesce(sum(submission_count), 0) as submissions'),
      )
      stats.landingPages = { published: Number(lp?.published || 0), views: Number(lp?.views || 0), submissions: Number(lp?.submissions || 0) }
    } catch { stats.landingPages = { published: 0, views: 0, submissions: 0 } }

    // Recent activity
    const recentActivity: Array<{ type: string; text: string; time: string }> = []
    try {
      const activities = await knex('customer_activities')
        .where(w)
        .orderBy('occurred_at', 'desc')
        .limit(5)
        .select('activity_type', 'subject', 'occurred_at')

      for (const a of activities) {
        recentActivity.push({
          type: a.activity_type,
          text: a.subject,
          time: a.occurred_at,
        })
      }
    } catch {}

    // Sort action items by priority
    actionItems.sort((a, b) => a.priority - b.priority)

    return NextResponse.json({
      ok: true,
      data: {
        actionItems: actionItems.slice(0, 5),
        stats,
        recentActivity,
      },
    })
  } catch (error) {
    console.error('[ai.action-items]', error)
    return NextResponse.json({ ok: false, error: 'Failed to load action items' }, { status: 500 })
  }
}
