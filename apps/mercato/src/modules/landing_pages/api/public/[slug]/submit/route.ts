import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { checkSequenceTriggers } from '@/modules/sequences/services/sequence-triggers'
import { trackEngagement } from '@/modules/customers/lib/engagement-score'
import { dispatchWebhook } from '@/modules/customers/api/webhooks/dispatch'
import { executeAutomationRules } from '@/modules/sequences/lib/automation-execute'
import { attributeReferral } from '@/modules/customers/api/affiliates/attribute'

export const metadata = {
  POST: { requireAuth: false },
}

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()

    const url = new URL(req.url)

    const page = await knex('landing_pages')
      .where('slug', params.slug)
      .where('status', 'published')
      .whereNull('deleted_at')
      .first()

    if (!page) return NextResponse.json({ ok: false, error: 'Page not found' }, { status: 404 })

    const body = await req.json()
    const data = body.data || body

    const form = await knex('landing_page_forms').where('landing_page_id', page.id).first()
    if (!form) return NextResponse.json({ ok: false, error: 'No form configured' }, { status: 400 })

    const fields = typeof form.fields === 'string' ? JSON.parse(form.fields) : form.fields
    for (const field of fields) {
      if (field.required && !data[field.name]) {
        return NextResponse.json({ ok: false, error: `${field.label} is required`, field: field.name }, { status: 400 })
      }
    }

    // Extract UTM params from form data (injected by client-side script) or query string
    const utmSource = data._utm_source || url.searchParams.get('utm_source') || null
    const utmMedium = data._utm_medium || url.searchParams.get('utm_medium') || null
    const utmCampaign = data._utm_campaign || url.searchParams.get('utm_campaign') || null
    const utmContent = data._utm_content || url.searchParams.get('utm_content') || null
    const utmTerm = data._utm_term || url.searchParams.get('utm_term') || null
    const capturedReferrer = data._referrer || req.headers.get('referer') || null

    const sourceDetails: Record<string, string> = {}
    if (utmSource) sourceDetails.utm_source = utmSource
    if (utmMedium) sourceDetails.utm_medium = utmMedium
    if (utmCampaign) sourceDetails.utm_campaign = utmCampaign
    if (utmContent) sourceDetails.utm_content = utmContent
    if (utmTerm) sourceDetails.utm_term = utmTerm
    if (capturedReferrer) sourceDetails.referrer = capturedReferrer
    sourceDetails.landing_page = page.title || page.slug

    // Strip internal UTM fields from stored form data
    const cleanData = { ...data }
    delete cleanData._utm_source
    delete cleanData._utm_medium
    delete cleanData._utm_campaign
    delete cleanData._utm_content
    delete cleanData._utm_term
    delete cleanData._referrer

    await knex('form_submissions').insert({
      id: require('crypto').randomUUID(),
      tenant_id: page.tenant_id,
      organization_id: page.organization_id,
      form_id: form.id,
      landing_page_id: page.id,
      data: JSON.stringify(cleanData),
      source_ip: req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || null,
      user_agent: req.headers.get('user-agent') || null,
      referrer: capturedReferrer,
      created_at: new Date(),
    })

    await knex('landing_pages').where('id', page.id).increment('submission_count', 1)

    // Auto-create contact if email is provided
    const email = cleanData.email || cleanData.Email
    const name = cleanData.name || cleanData.Name || cleanData.full_name || cleanData.fullName || email
    let contactId = null
    if (email) {
      try {
        // Check if contact already exists
        const existing = await knex('customer_entities')
          .where('primary_email', email)
          .where('organization_id', page.organization_id)
          .whereNull('deleted_at')
          .first()

        if (existing) {
          contactId = existing.id
          // Update source_details on existing contact if not already set
          if (!existing.source_details) {
            await knex('customer_entities').where('id', existing.id).update({
              source_details: JSON.stringify(sourceDetails),
              updated_at: new Date(),
            })
          }
        } else {
          contactId = require('crypto').randomUUID()
          await knex('customer_entities').insert({
            id: contactId,
            tenant_id: page.tenant_id,
            organization_id: page.organization_id,
            kind: 'person',
            display_name: name,
            primary_email: email,
            primary_phone: cleanData.phone || cleanData.Phone || null,
            source: utmSource ? `landing_page:${utmSource}` : 'landing_page',
            source_details: JSON.stringify(sourceDetails),
            status: 'active',
            lifecycle_stage: 'prospect',
            created_at: new Date(),
            updated_at: new Date(),
          })

          // Create person profile if we have name parts
          const nameParts = (name || '').split(' ')
          if (nameParts.length > 0) {
            await knex('customer_people').insert({
              id: require('crypto').randomUUID(),
              tenant_id: page.tenant_id,
              organization_id: page.organization_id,
              entity_id: contactId,
              first_name: nameParts[0] || '',
              last_name: nameParts.slice(1).join(' ') || '',
              created_at: new Date(),
              updated_at: new Date(),
            }).catch(() => {})  // Ignore if person profile creation fails
          }
        }

        // Link submission to contact
        if (contactId) {
          await knex('form_submissions')
            .where('form_id', form.id)
            .where('landing_page_id', page.id)
            .whereNull('contact_id')
            .orderBy('created_at', 'desc')
            .limit(1)
            .update({ contact_id: contactId })
        }

        // First-touch source attribution — only tag newly-created contacts.
        // Existing contacts keep their original source to preserve the
        // original attribution in marketing reports.
        if (contactId && !existing) {
          try {
            const { tagContactSource } = await import('@open-mercato/core/modules/customers/lib/sourceTagging')
            await tagContactSource(
              knex,
              { tenantId: page.tenant_id, organizationId: page.organization_id },
              contactId,
              'landing',
              page.title || page.slug,
            )
          } catch {}
        }

        // Track engagement + check sequence triggers
        if (contactId) {
          trackEngagement(knex, page.organization_id, page.tenant_id, contactId, 'form_submitted', undefined, container).catch(() => {})
          checkSequenceTriggers(knex, page.organization_id, page.tenant_id, 'form_submit', {
            contactId, formId: form.id,
          }).catch(() => {})
        }

        // Dispatch webhooks for contact creation and form submission
        if (contactId && !existing) {
          dispatchWebhook(knex, page.organization_id, 'contact.created', {
            contactId,
            email,
            name,
            source: utmSource ? `landing_page:${utmSource}` : 'landing_page',
          }).catch(() => {})
        }

        dispatchWebhook(knex, page.organization_id, 'form.submitted', {
          contactId,
          formId: form.id,
          landingPageId: page.id,
          landingPageSlug: page.slug,
          data: cleanData,
        }).catch(() => {})

        try {
          const bus = container.resolve('eventBus') as any
          if (bus?.emitEvent) {
            await bus.emitEvent('landing_pages.form.submitted', {
              tenantId: page.tenant_id,
              organizationId: page.organization_id,
              contactId,
              formId: form.id,
              landingPageId: page.id,
              landingPageTitle: page.title,
              submitterName: name || null,
              isNewContact: !existing,
            }, { persistent: true })
          }
        } catch {}

        // Fire automation rules for form submission and contact creation
        if (contactId) {
          executeAutomationRules(knex, page.organization_id, page.tenant_id, 'form_submitted', {
            contactId, formId: form.id, landingPageSlug: page.slug,
          }).catch(() => {})
        }
        if (contactId && !existing) {
          executeAutomationRules(knex, page.organization_id, page.tenant_id, 'contact_created', {
            contactId, source: utmSource ? `landing_page:${utmSource}` : 'landing_page',
          }).catch(() => {})
        }

        // Attribute affiliate referral if cookie present
        if (email) {
          attributeReferral(knex, page.organization_id, page.tenant_id, email).catch(() => {})
        }

        // Log activity on the contact
        await knex('customer_activities').insert({
          id: require('crypto').randomUUID(),
          tenant_id: page.tenant_id,
          organization_id: page.organization_id,
          entity_id: contactId,
          activity_type: 'form_submission',
          subject: `Form submitted on "${page.title}"`,
          body: JSON.stringify(cleanData),
          occurred_at: new Date(),
          created_at: new Date(),
          updated_at: new Date(),
        }).catch(() => {})  // Don't fail the submission if activity logging fails
      } catch (err) {
        console.error('[landing_pages.submit] contact creation failed (non-blocking)', err)
      }
    }

    // Check for funnel context — if this form is part of a funnel, advance to next step
    const funnelSid = data._funnel_sid || data.funnel_sid
    const funnelStep = data._funnel_step || data.funnel_step
    const funnelSlug = data._funnel_slug || data.funnel_slug

    if (funnelSid && funnelSlug) {
      try {
        const funnelSession = await knex('funnel_sessions').where('id', funnelSid).first()
        if (funnelSession) {
          // Update session with captured email
          const capturedEmail = data.email || data.Email
          if (capturedEmail) {
            await knex('funnel_sessions').where('id', funnelSid).update({ email: capturedEmail.trim(), updated_at: new Date() })
          }

          // Find next funnel step
          const currentFunnelStep = funnelStep
            ? await knex('funnel_steps').where('id', funnelStep).first()
            : await knex('funnel_steps').where('id', funnelSession.current_step_id).first()

          if (currentFunnelStep) {
            const nextFunnelStep = await knex('funnel_steps')
              .where('funnel_id', funnelSession.funnel_id)
              .where('step_order', '>', currentFunnelStep.step_order)
              .orderBy('step_order').first()

            const baseUrl = process.env.APP_URL || 'http://localhost:3000'
            if (nextFunnelStep) {
              await knex('funnel_sessions').where('id', funnelSid).update({ current_step_id: nextFunnelStep.id })
              return NextResponse.json({
                ok: true,
                message: form.success_message || 'Thank you!',
                redirectUrl: `${baseUrl}/api/landing_pages/funnels/public/${funnelSlug}?step=${nextFunnelStep.id}&sid=${funnelSid}`,
              })
            }
          }
        }
      } catch (funnelErr) {
        console.error('[landing_pages.submit] funnel advance failed:', funnelErr)
      }
    }

    return NextResponse.json({
      ok: true,
      message: form.success_message || 'Thank you! We\'ll be in touch.',
      redirectUrl: form.redirect_url || null,
    })
  } catch (error) {
    console.error('[landing_pages.public.submit] failed', error)
    return NextResponse.json({ ok: false, error: 'Failed to submit form' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Landing Pages (Public)',
  summary: 'Form submission',
  methods: { POST: { summary: 'Submit landing page form', tags: ['Landing Pages (Public)'] } },
}
