import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

// Send a campaign to all matching contacts
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const campaign = await knex('email_campaigns')
      .where('id', params.id)
      .where('organization_id', auth.orgId)
      .first()

    if (!campaign) return NextResponse.json({ ok: false, error: 'Campaign not found' }, { status: 404 })
    if (campaign.status !== 'draft') return NextResponse.json({ ok: false, error: 'Campaign already sent' }, { status: 400 })

    // Get recipients — filter by segment if set
    let query = knex('customer_entities')
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .whereNotNull('primary_email')
      .where('kind', 'person')

    // Check for tag filter
    const filter = campaign.segment_filter ? (typeof campaign.segment_filter === 'string' ? JSON.parse(campaign.segment_filter) : campaign.segment_filter) : null
    if (filter?.tag) {
      const taggedIds = await knex('customer_tag_assignments as cta')
        .join('customer_tags as ct', 'ct.id', 'cta.tag_id')
        .where('ct.slug', filter.tag)
        .select('cta.entity_id')
      query = query.whereIn('id', taggedIds.map((t: any) => t.entity_id))
    }

    // Exclude unsubscribed
    const unsubscribed = await knex('email_unsubscribes')
      .where('organization_id', auth.orgId)
      .select('email')
    const unsubEmails = new Set(unsubscribed.map((u: any) => u.email.toLowerCase()))

    const contacts = await query.select('id', 'primary_email', 'display_name')
    const recipients = contacts.filter((c: any) => !unsubEmails.has(c.primary_email?.toLowerCase()))

    // Mark campaign as sending
    await knex('email_campaigns').where('id', params.id).update({
      status: 'sending',
      stats: JSON.stringify({ total: recipients.length, sent: 0, delivered: 0, opened: 0, clicked: 0 }),
      updated_at: new Date(),
    })

    // Create recipient records
    for (const contact of recipients) {
      await knex('email_campaign_recipients').insert({
        id: require('crypto').randomUUID(),
        campaign_id: params.id,
        contact_id: contact.id,
        email: contact.primary_email,
        status: 'pending',
      }).catch(() => {})
    }

    // Send emails (in batches)
    const baseUrl = process.env.APP_URL || 'http://localhost:3000'
    let sentCount = 0

    for (const contact of recipients) {
      const trackingId = require('crypto').randomUUID()
      const firstName = (contact.display_name || '').split(' ')[0] || 'there'

      // Personalize email
      let html = campaign.body_html
        .replace(/\{\{firstName\}\}/g, firstName)
        .replace(/\{\{name\}\}/g, contact.display_name || '')
        .replace(/\{\{email\}\}/g, contact.primary_email || '')

      // Add tracking pixel
      html = html.replace('</body>',
        `<img src="${baseUrl}/api/email/track/open/${trackingId}" width="1" height="1" style="display:none" />\n</body>`)

      // Add unsubscribe link
      html = html.replace('</body>',
        `<div style="text-align:center;padding:20px;font-size:12px;color:#999"><a href="${baseUrl}/api/email/unsubscribe/${contact.id}" style="color:#999">Unsubscribe</a></div>\n</body>`)

      // Store message
      await knex('email_messages').insert({
        id: require('crypto').randomUUID(),
        tenant_id: auth.tenantId,
        organization_id: auth.orgId,
        direction: 'outbound',
        from_address: process.env.EMAIL_FROM || 'noreply@localhost',
        to_address: contact.primary_email,
        subject: campaign.subject,
        body_html: html,
        contact_id: contact.id,
        campaign_id: params.id,
        status: 'queued',
        tracking_id: trackingId,
        created_at: new Date(),
      }).catch(() => {})

      // Send via Resend (if configured)
      try {
        const apiKey = process.env.RESEND_API_KEY
        if (apiKey) {
          const { Resend } = await import('resend')
          const resend = new Resend(apiKey)
          await resend.emails.send({
            from: process.env.EMAIL_FROM || 'noreply@localhost',
            to: [contact.primary_email],
            subject: campaign.subject,
            html,
          })
          sentCount++

          // Update recipient status
          await knex('email_campaign_recipients')
            .where('campaign_id', params.id)
            .where('contact_id', contact.id)
            .update({ status: 'sent', sent_at: new Date() })
        } else {
          console.log(`[campaign] DEV: would send to ${contact.primary_email}`)
          sentCount++
        }
      } catch (err) {
        console.error(`[campaign] Failed to send to ${contact.primary_email}:`, err)
      }
    }

    // Mark campaign as sent
    await knex('email_campaigns').where('id', params.id).update({
      status: 'sent',
      sent_at: new Date(),
      stats: JSON.stringify({ total: recipients.length, sent: sentCount, delivered: 0, opened: 0, clicked: 0 }),
      updated_at: new Date(),
    })

    return NextResponse.json({ ok: true, data: { sent: sentCount, total: recipients.length } })
  } catch (error) {
    console.error('[campaigns.send]', error)
    return NextResponse.json({ ok: false, error: 'Failed to send campaign' }, { status: 500 })
  }
}
