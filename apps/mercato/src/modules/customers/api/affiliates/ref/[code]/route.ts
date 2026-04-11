import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { Affiliate, AffiliateCampaign } from '../../../../data/schema'

export const metadata = { path: '/affiliates/ref/[code]', GET: { requireAuth: false } }

export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  try {
    const { code } = await params
    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()

    const affiliate = await em.findOne(Affiliate, { affiliateCode: code, status: 'active' })
    if (!affiliate) return NextResponse.json({ ok: false, error: 'Invalid affiliate link' }, { status: 404 })

    // Increment referral count
    affiliate.totalReferrals += 1
    await em.flush()

    const redirectUrl = process.env.AFFILIATE_REDIRECT_URL || process.env.APP_URL || '/'
    const response = NextResponse.redirect(new URL(redirectUrl, req.url))

    // Cookie duration from campaign or default 30 days
    let cookieDays = 30
    if (affiliate.campaignId) {
      const campaign = await em.findOne(AffiliateCampaign, { id: affiliate.campaignId })
      if (campaign?.cookieDurationDays) cookieDays = campaign.cookieDurationDays
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
