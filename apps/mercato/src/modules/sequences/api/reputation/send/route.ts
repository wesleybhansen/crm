/* eslint-disable @typescript-eslint/no-explicit-any */
export const metadata = { POST: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { sendEmailByPurpose } from '@/modules/email/lib/email-router'
import {
  buildSenderContext,
  htmlifyIfPlainText,
  recordReviewRequest,
  requiresReviewUrl,
  substituteTemplateVars,
} from '@/modules/sequences/lib/template-vars'

/**
 * "Request a review" quick action from /backend/reputation: sends the review
 * request email to one contact right now, through the same template-variable
 * substitution path the automations use, and logs it to review_requests.
 */

const REVIEW_REQUEST_SUBJECT = 'Would you mind leaving a quick review?'
const REVIEW_REQUEST_BODY =
  'Hi {{contact.first_name}},\n\n' +
  'Thank you again for your business. If you had a good experience, would you mind taking two minutes to leave a quick review? It really helps other people decide if we are a good fit.\n\n' +
  'Here is the link: {{sender.review_url}}\n\n' +
  'Even a sentence or two makes a big difference. Thank you so much!\n\n' +
  '{{sender.first_name}}'

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const body = await req.json().catch(() => ({}))
    const contactId = typeof body.contactId === 'string' ? body.contactId : ''
    if (!contactId) return NextResponse.json({ ok: false, error: 'contactId is required' }, { status: 400 })

    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    const knex = em.getKnex()

    // Fresh sender context: the user may have just saved their review link.
    const senderCtx = await buildSenderContext(knex, auth.orgId, { fresh: true })
    if (requiresReviewUrl(REVIEW_REQUEST_BODY) && !senderCtx.review_url) {
      return NextResponse.json(
        { ok: false, error: 'No review link configured. Save your review link in the settings above first.' },
        { status: 400 },
      )
    }

    // Load the contact with decryption (same pattern as automation-execute).
    let contactEmail: string | null = null
    let contactName = ''
    try {
      const { findOneWithDecryption } = await import('@open-mercato/shared/lib/encryption/find')
      const decrypted = await findOneWithDecryption(em, 'CustomerEntity' as any, { id: contactId, organizationId: auth.orgId } as any)
      if (decrypted) {
        contactEmail = (decrypted as any).primaryEmail || (decrypted as any).primary_email || null
        contactName = (decrypted as any).displayName || (decrypted as any).display_name || ''
      }
    } catch {
      const contact = await knex('customer_entities')
        .where('id', contactId)
        .where('organization_id', auth.orgId)
        .first()
      contactEmail = contact?.primary_email || null
      contactName = contact?.display_name || ''
    }
    if (!contactEmail || contactEmail.includes(':v1')) {
      return NextResponse.json({ ok: false, error: 'Contact has no valid email address' }, { status: 400 })
    }

    const firstName = (contactName || '').split(' ')[0] || 'there'
    const varCtx = {
      contact: { first_name: firstName, full_name: contactName || null, email: contactEmail },
      sender: senderCtx,
    }
    const subject = substituteTemplateVars(REVIEW_REQUEST_SUBJECT, varCtx)
    const htmlBody = htmlifyIfPlainText(substituteTemplateVars(REVIEW_REQUEST_BODY, varCtx))

    const result = await sendEmailByPurpose(knex, auth.orgId, auth.tenantId, 'automations', {
      to: contactEmail,
      subject,
      htmlBody,
      contactId,
    })
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error || 'Email send failed' }, { status: 502 })
    }

    await recordReviewRequest(knex, {
      organizationId: auth.orgId,
      tenantId: auth.tenantId,
      contactId,
      ruleId: null,
      channel: 'email',
    })

    try {
      const { logTimelineEvent } = await import('@/lib/timeline')
      await logTimelineEvent(knex, {
        tenantId: auth.tenantId,
        organizationId: auth.orgId,
        contactId,
        eventType: 'automation_email',
        title: `Review request sent: ${subject}`,
        metadata: { source: 'reputation_quick_action' },
      })
    } catch {}

    return NextResponse.json({ ok: true, data: { sentVia: result.sentVia, to: contactEmail } })
  } catch (error) {
    console.error('[reputation/send] POST error', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Reputation',
  summary: 'Send a review request email',
  methods: {
    POST: { summary: 'Send the review-request email to a contact immediately and log it', tags: ['Reputation'] },
  },
}
