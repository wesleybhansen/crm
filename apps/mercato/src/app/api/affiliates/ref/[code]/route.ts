import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export const metadata = {
  GET: { requireAuth: false },
}

export async function GET(req: Request, { params }: { params: { code: string } }) {
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const affiliate = await knex('affiliates')
      .where('affiliate_code', params.code)
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

    // Determine redirect URL — use org's main page or root
    const redirectUrl = '/'

    const response = NextResponse.redirect(new URL(redirectUrl, req.url))

    // Set affiliate referral cookie with 30-day expiry
    response.cookies.set('affiliate_ref', params.code, {
      path: '/',
      maxAge: 60 * 60 * 24 * 30, // 30 days
      httpOnly: false,
      sameSite: 'lax',
    })

    return response
  } catch (error) {
    console.error('[affiliates.ref] failed', error)
    return NextResponse.redirect(new URL('/', req.url))
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Affiliates',
  summary: 'Affiliate referral link',
  methods: {
    GET: { summary: 'Track affiliate referral and redirect', tags: ['Affiliates'] },
  },
}
