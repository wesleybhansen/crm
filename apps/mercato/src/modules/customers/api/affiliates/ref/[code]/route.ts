import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export const metadata = { path: '/affiliates/ref/[code]',
  GET: { requireAuth: false },
}

export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  try {
    await (await import('@/bootstrap')).bootstrap()
    const { code } = await params
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const affiliate = await knex('affiliates')
      .where('affiliate_code', code)
      .where('status', 'active')
      .first()

    if (!affiliate) {
      return NextResponse.json({ ok: false, error: 'Invalid affiliate link' }, { status: 404 })
    }

    // Increment referral count
    await knex('affiliates')
      .where('id', affiliate.id)
      .increment('total_referrals', 1)
      .update({ updated_at: new Date() })

    // Determine redirect URL
    const redirectUrl = process.env.AFFILIATE_REDIRECT_URL || process.env.APP_URL || '/'

    const response = NextResponse.redirect(new URL(redirectUrl, req.url))

    // Determine cookie duration from campaign or default to 30 days
    let cookieDays = 30
    if (affiliate.campaign_id) {
      const campaign = await knex('affiliate_campaigns').where('id', affiliate.campaign_id).first()
      if (campaign?.cookie_duration_days) cookieDays = campaign.cookie_duration_days
    }

    const maxAge = 60 * 60 * 24 * cookieDays
    response.cookies.set('affiliate_ref', code, { path: '/', maxAge, httpOnly: false, sameSite: 'lax' })
    response.cookies.set('affiliate_id', affiliate.id, { path: '/', maxAge, httpOnly: false, sameSite: 'lax' })

    return response
  } catch (error) {
    console.error('[affiliates.ref] failed', error)
    return NextResponse.redirect(new URL('/', req.url))
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Affiliates',
  summary: 'Affiliate referral link',
  methods: { GET: { summary: 'Track affiliate referral and redirect', tags: ['Affiliates'] } },
}
