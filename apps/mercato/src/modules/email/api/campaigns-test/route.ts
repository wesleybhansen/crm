export const metadata = { POST: { requireAuth: true, requireFeatures: ['email.campaigns.manage'] } }
export const openApi = { summary: 'Send test email', methods: {} }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { sendEmailByPurpose } from '@/app/api/email/email-router'

export async function POST(req: Request) {
  const url = new URL(req.url)
  const id = url.searchParams.get('id')
  if (!id) return NextResponse.json({ ok: false, error: 'id query param required' }, { status: 400 })
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId || !auth?.sub) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const campaign = await knex('email_campaigns')
      .where('id', id)
      .where('organization_id', auth.orgId)
      .first()

    if (!campaign) return NextResponse.json({ ok: false, error: 'Blast not found' }, { status: 404 })

    // Get the user's email
    const user = await knex('users').where('id', auth.sub).first()
    if (!user?.email) {
      return NextResponse.json({ ok: false, error: 'Could not find your email address' }, { status: 400 })
    }

    const toEmail = user.email.trim()
    if (!toEmail || !toEmail.includes('@')) {
      return NextResponse.json({ ok: false, error: `Invalid email address on your account: "${toEmail}"` }, { status: 400 })
    }

    const sampleFirstName = user.name?.split(' ')[0] || 'Test'
    const sampleName = user.name || 'Test User'
    const subjectLine = (campaign.subject || '')
      .replace(/\{\{firstName\}\}/g, sampleFirstName)
      .replace(/\{\{name\}\}/g, sampleName)
      .replace(/\{\{email\}\}/g, toEmail)
    const bodyHtml = (campaign.body_html || '')
      .replace(/\{\{firstName\}\}/g, sampleFirstName)
      .replace(/\{\{name\}\}/g, sampleName)
      .replace(/\{\{email\}\}/g, toEmail)

    const result = await sendEmailByPurpose(knex, auth.orgId, auth.tenantId, 'marketing', {
      to: toEmail,
      subject: `[TEST] ${subjectLine}`,
      htmlBody: bodyHtml,
    })

    if (result.ok) {
      return NextResponse.json({ ok: true, sentTo: toEmail })
    } else {
      return NextResponse.json({ ok: false, error: result.error || 'Failed to send test' }, { status: 500 })
    }
  } catch (error) {
    console.error('[campaigns.test]', error)
    const message = error instanceof Error ? error.message : 'Failed to send test'
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
