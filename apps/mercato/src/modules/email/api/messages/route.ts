import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { EmailSenderService } from '../../services/email-sender'
import { sendEmailForOrg } from '../../../../app/api/email/email-router'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['email.view'] },
  POST: { requireAuth: true, requireFeatures: ['email.send'] },
}

function getScope(ctx: any) {
  const auth = ctx?.auth
  if (!auth?.tenantId || !auth?.orgId) return null
  return { tenantId: auth.tenantId, orgId: auth.orgId, userId: auth.sub }
}

export async function GET(req: Request, ctx: any) {
  const scope = getScope(ctx)
  if (!scope) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const url = new URL(req.url)

    const contactId = url.searchParams.get('contactId')
    const dealId = url.searchParams.get('dealId')
    const direction = url.searchParams.get('direction')
    const page = parseInt(url.searchParams.get('page') || '1')
    const pageSize = parseInt(url.searchParams.get('pageSize') || '20')

    let query = knex('email_messages')
      .where('tenant_id', scope.tenantId)
      .where('organization_id', scope.orgId)
    if (contactId) query = query.where('contact_id', contactId)
    if (dealId) query = query.where('deal_id', dealId)
    if (direction) query = query.where('direction', direction)

    const [{ count: total }] = await query.clone().count()
    const messages = await query.select('*').orderBy('created_at', 'desc').limit(pageSize).offset((page - 1) * pageSize)

    return NextResponse.json({
      ok: true, data: messages,
      pagination: { page, pageSize, total: Number(total), totalPages: Math.ceil(Number(total) / pageSize) },
    })
  } catch (error) {
    console.error('[email.messages.list]', error)
    return NextResponse.json({ ok: false, error: 'Failed to list messages' }, { status: 500 })
  }
}

export async function POST(req: Request, ctx: any) {
  const scope = getScope(ctx)
  if (!scope) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const body = await req.json()

    const { to, subject, bodyHtml, bodyText, contactId, dealId, replyTo } = body
    if (!to || !subject || !bodyHtml) {
      return NextResponse.json({ ok: false, error: 'to, subject, and bodyHtml are required' }, { status: 400 })
    }

    const baseUrl = process.env.APP_URL || 'http://localhost:3000'
    const sender = new EmailSenderService()
    const id = require('crypto').randomUUID()
    const trackingId = require('crypto').randomUUID()

    let trackedHtml = sender.injectTrackingPixel(bodyHtml, trackingId, baseUrl)
    trackedHtml = sender.wrapLinksForTracking(trackedHtml, trackingId, baseUrl)
    if (contactId) trackedHtml = sender.injectUnsubscribeLink(trackedHtml, contactId, baseUrl)

    // Try sending via user's connected email (Gmail, SMTP, etc.)
    const routerResult = await sendEmailForOrg(knex, scope.orgId, scope.tenantId, scope.userId, {
      to,
      subject,
      htmlBody: trackedHtml,
      textBody: bodyText,
      contactId,
    })

    let status: string
    let sentAt: Date | null = null
    let fromAddress: string
    let metadata: Record<string, any> = {}

    if (routerResult.ok) {
      // Sent via connected email provider
      status = 'sent'
      sentAt = new Date()
      fromAddress = routerResult.fromAddress || ''
      metadata = { providerId: routerResult.messageId, provider: routerResult.sentVia }
    } else {
      // No connected email — fall back to Resend/system sender
      fromAddress = process.env.EMAIL_FROM || 'noreply@localhost'
      try {
        const result = await sender.send({ to, subject, html: trackedHtml, text: bodyText, replyTo })
        status = 'sent'
        sentAt = new Date()
        metadata = { providerId: result.id, provider: result.provider, fallback: true }
      } catch (err) {
        status = 'failed'
        metadata = { error: err instanceof Error ? err.message : 'Unknown error' }
      }
    }

    await knex('email_messages').insert({
      id,
      tenant_id: scope.tenantId,
      organization_id: scope.orgId,
      direction: 'outbound',
      from_address: fromAddress,
      to_address: to,
      subject,
      body_html: bodyHtml,
      body_text: bodyText || null,
      contact_id: contactId || null,
      deal_id: dealId || null,
      status,
      tracking_id: trackingId,
      metadata: JSON.stringify(metadata),
      created_at: new Date(),
      sent_at: sentAt,
    })

    return NextResponse.json({ ok: true, data: { id, status, sentVia: routerResult.sentVia || metadata.provider } })
  } catch (error) {
    console.error('[email.messages.send]', error)
    return NextResponse.json({ ok: false, error: 'Failed to send email' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Email', summary: 'Email messages',
  methods: {
    GET: { summary: 'List email messages', tags: ['Email'] },
    POST: { summary: 'Send an email', tags: ['Email'] },
  },
}
