import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId || !auth?.sub) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const campaign = await knex('email_campaigns')
      .where('id', params.id)
      .where('organization_id', auth.orgId)
      .first()

    if (!campaign) return NextResponse.json({ ok: false, error: 'Campaign not found' }, { status: 404 })

    // Get the user's email from staff/auth tables
    const user = await knex('users').where('id', auth.sub).first()
    if (!user?.email) {
      return NextResponse.json({ ok: false, error: 'Could not find your email address' }, { status: 400 })
    }

    const toEmail = user.email
    const fromAddress = process.env.EMAIL_FROM || 'noreply@localhost'

    // Personalize with sample data
    const sampleFirstName = user.name?.split(' ')[0] || 'Test'
    const sampleName = user.name || 'Test User'
    const subject = (campaign.subject || '')
      .replace(/\{\{firstName\}\}/g, sampleFirstName)
      .replace(/\{\{name\}\}/g, sampleName)
      .replace(/\{\{email\}\}/g, toEmail)
    const bodyHtml = (campaign.body_html || '')
      .replace(/\{\{firstName\}\}/g, sampleFirstName)
      .replace(/\{\{name\}\}/g, sampleName)
      .replace(/\{\{email\}\}/g, toEmail)

    const apiKey = process.env.RESEND_API_KEY
    if (apiKey) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: fromAddress,
          to: [toEmail],
          subject: `[TEST] ${subject}`,
          html: bodyHtml,
        }),
      })
      if (!res.ok) {
        const err = await res.text()
        console.error('[campaigns.test] Resend error:', err)
        return NextResponse.json({ ok: false, error: 'Failed to send test email' }, { status: 500 })
      }
    } else {
      console.log(`[campaigns.test] DEV: would send test email to ${toEmail} — subject: [TEST] ${subject}`)
    }

    return NextResponse.json({ ok: true, sentTo: toEmail })
  } catch (error) {
    console.error('[campaigns.test]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Campaigns', summary: 'Send test email',
  methods: { POST: { summary: 'Send a test email to yourself', tags: ['Campaigns'] } },
}
