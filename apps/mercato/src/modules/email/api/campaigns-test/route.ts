export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['email.campaigns.manage'] },
  POST: { requireAuth: true, requireFeatures: ['email.campaigns.manage'] },
}
export const openApi = { summary: 'Send test email', methods: {} }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { sendEmailByPurpose } from '@/modules/email/lib/email-router'
import { fillBlastVariables, parseTestRecipient } from '../../lib/blastPreview'

type Auth = { sub: string; tenantId: string; orgId: string }

/** The signed-in user's email and name (decrypted; stored encrypted at rest). */
async function loadSignedInUser(container: Awaited<ReturnType<typeof createRequestContainer>>, auth: Auth) {
  const { findOneWithDecryption } = await import('@open-mercato/shared/lib/encryption/find')
  const { User } = await import('@open-mercato/core/modules/auth/data/entities')
  const em = container.resolve('em') as EntityManager
  const userEntity = await findOneWithDecryption(
    em.fork(), User, { id: auth.sub },
    {},
    { tenantId: auth.tenantId ?? null, organizationId: auth.orgId ?? null },
  )
  const email = (userEntity?.email ?? '').trim()
  return { email: email.includes('@') ? email : '', name: (userEntity?.name ?? '').trim() }
}

/** Where a test goes by default (the signed-in user), so the page can show it before sending. */
export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId || !auth?.sub) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const container = await createRequestContainer()
    const user = await loadSignedInUser(container, auth as Auth)
    return NextResponse.json({ ok: true, defaultTo: user.email || null })
  } catch (error) {
    console.error('[campaigns.test.default]', error)
    return NextResponse.json({ ok: false, error: 'Could not look up your email address' }, { status: 500 })
  }
}

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

    // The page shows the recipient and lets the user change it. A test goes
    // to one address; with none given it goes to the signed-in user.
    let requestedTo: unknown = undefined
    try {
      const body = await req.json()
      requestedTo = body && typeof body === 'object' ? (body as { to?: unknown }).to : undefined
    } catch { /* no body: default recipient */ }
    const user = await loadSignedInUser(container, auth as Auth)
    let toEmail = user.email
    if (typeof requestedTo === 'string' && requestedTo.trim()) {
      const parsed = parseTestRecipient(requestedTo)
      if (!parsed) return NextResponse.json({ ok: false, error: 'Enter one valid email address for the test.' }, { status: 400 })
      toEmail = parsed
    }
    if (!toEmail) {
      return NextResponse.json({ ok: false, error: 'Could not find your email address. Enter one to send the test to.' }, { status: 400 })
    }

    const sample = {
      firstName: user.name.split(' ')[0] || 'Test',
      name: user.name || 'Test User',
      email: toEmail,
    }
    const subjectLine = fillBlastVariables(campaign.subject || '', sample)
    const bodyHtml = fillBlastVariables(campaign.body_html || '', sample)

    const result = await sendEmailByPurpose(knex, auth.orgId, auth.tenantId, 'marketing', {
      actingUserId: auth.sub || null,
      to: toEmail,
      subject: `[TEST] ${subjectLine}`,
      htmlBody: bodyHtml,
    })

    if (result.ok) {
      return NextResponse.json({ ok: true, sentTo: toEmail })
    } else {
      return NextResponse.json({ ok: false, code: result.code, error: result.error || 'Failed to send test' }, { status: result.code === 'email_not_connected' ? 422 : 500 })
    }
  } catch (error) {
    console.error('[campaigns.test]', error)
    const message = error instanceof Error ? error.message : 'Failed to send test'
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
