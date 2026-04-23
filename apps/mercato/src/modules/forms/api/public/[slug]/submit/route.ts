import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { trackEngagement } from '@/modules/customers/lib/engagement-score'
import { dispatchWebhook } from '@/modules/customers/api/webhooks/dispatch'
import { executeAutomationRules } from '@/modules/sequences/lib/automation-execute'
import { checkSequenceTriggers } from '@/modules/sequences/services/sequence-triggers'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export const metadata = {
  POST: { requireAuth: false },
  OPTIONS: { requireAuth: false },
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

export async function POST(req: Request, { params }: { params: { slug: string } }) {
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()

    const form = await knex('forms')
      .where('slug', params.slug)
      .where('status', 'published')
      .where('is_active', true)
      .first()

    if (!form) {
      return NextResponse.json({ ok: false, error: 'Form not found' }, { status: 404, headers: CORS_HEADERS })
    }

    const body = await req.json()
    const data = body.data || body

    const fields = typeof form.fields === 'string' ? JSON.parse(form.fields) : (form.fields || [])
    const settings = typeof form.settings === 'string' ? JSON.parse(form.settings || '{}') : (form.settings || {})

    for (const field of fields) {
      if (field.required && !data[field.id] && data[field.id] !== 0 && data[field.id] !== false) {
        return NextResponse.json(
          { ok: false, error: `${field.label} is required`, field: field.id },
          { status: 400, headers: CORS_HEADERS },
        )
      }
    }

    const submissionId = require('crypto').randomUUID()
    const now = new Date()

    await knex('form_submissions').insert({
      id: submissionId,
      tenant_id: form.tenant_id,
      organization_id: form.organization_id,
      form_id: form.id,
      data: JSON.stringify(data),
      source_ip: req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || null,
      user_agent: req.headers.get('user-agent') || null,
      referrer: req.headers.get('referer') || null,
      created_at: now,
    })

    await knex('forms').where('id', form.id).increment('submission_count', 1)

    // Find email field for CRM contact linking
    const emailField = fields.find((f: any) => f.type === 'email' || f.crm_mapping === 'contact.email' || f.crmMapping === 'primary_email')
    const nameField = fields.find((f: any) => f.crm_mapping === 'contact.first_name' || f.crmMapping === 'display_name' || f.crmMapping === 'first_name')
    const lastNameField = fields.find((f: any) => f.crm_mapping === 'contact.last_name')
    const phoneField = fields.find((f: any) => f.type === 'phone' || f.crm_mapping === 'contact.phone' || f.crmMapping === 'primary_phone')

    // Fallback: if the form owner didn't mark an email field, scan the
    // submitted data for the first string that parses as an email. Keeps
    // auto-contact-creation working for hand-built forms.
    const isEmailLike = (v: unknown): v is string => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())
    const fallbackEmail = (() => {
      for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
        if (key.startsWith('_')) continue
        if (isEmailLike(value)) return (value as string).trim()
      }
      return null
    })()
    // Gate auto-contact-creation on the "Auto-create CRM contact" form
    // setting. If off (or unset), the submitter is NOT added to the CRM —
    // they only land in form_submissions.
    const shouldCreateContact = settings.createContact === true
    const email = shouldCreateContact ? ((emailField ? data[emailField.id] : null) || fallbackEmail) : null
    const rawName = nameField ? data[nameField.id] : null
    const isDisplayNameMapping = nameField && (nameField.crmMapping === 'display_name' || nameField.crm_mapping === 'display_name')
    const firstName = isDisplayNameMapping ? (rawName || '').split(' ')[0] : rawName
    const lastName = lastNameField ? data[lastNameField.id] : (isDisplayNameMapping ? (rawName || '').split(' ').slice(1).join(' ') : null)
    const displayName = rawName || (firstName ? (lastName ? `${firstName} ${lastName}` : firstName) : email)
    const phone = phoneField ? data[phoneField.id] : null
    let contactId: string | null = null

    if (email) {
      try {
        const existing = await knex('customer_entities')
          .where('primary_email', email)
          .where('organization_id', form.organization_id)
          .whereNull('deleted_at')
          .first()

        if (existing) {
          contactId = existing.id
        } else {
          contactId = require('crypto').randomUUID()
          await knex('customer_entities').insert({
            id: contactId,
            tenant_id: form.tenant_id,
            organization_id: form.organization_id,
            kind: 'person',
            display_name: displayName || email,
            primary_email: email,
            primary_phone: phone || null,
            source: 'form',
            source_details: JSON.stringify({ form_name: form.name, form_slug: form.slug }),
            status: 'active',
            // Leave lifecycle_stage null unless the form owner picked one in
            // settings — auto-inserting 'prospect' put submitters on the
            // pipeline board without the user asking for it.
            lifecycle_stage: settings.pipelineStage || null,
            created_at: now,
            updated_at: now,
          })

          const resolvedFirst = firstName || (displayName || '').split(' ')[0] || email.split('@')[0] || ''
          const resolvedLast = lastName || (displayName || '').split(' ').slice(1).join(' ') || ''
          {
            await knex('customer_people').insert({
              id: require('crypto').randomUUID(),
              tenant_id: form.tenant_id,
              organization_id: form.organization_id,
              entity_id: contactId,
              first_name: resolvedFirst,
              last_name: resolvedLast,
              created_at: now,
              updated_at: now,
            }).catch(() => {})
          }
        }

        // First-touch source attribution — only tag newly-created contacts
        // so re-submissions don't overwrite the original source.
        if (contactId && !existing) {
          try {
            const { tagContactSource } = await import('@open-mercato/core/modules/customers/lib/sourceTagging')
            await tagContactSource(knex, { tenantId: form.tenant_id, organizationId: form.organization_id }, contactId, 'form', form.name || form.slug)
          } catch {}
        }

        // Link submission to contact
        if (contactId) {
          await knex('form_submissions').where('id', submissionId).update({ contact_id: contactId })
        }

        // Apply tags from form settings
        if (contactId && settings.tags && Array.isArray(settings.tags) && settings.tags.length > 0) {
          for (const tagName of settings.tags) {
            try {
              let tag = await knex('customer_tags')
                .where('name', tagName)
                .where('organization_id', form.organization_id)
                .first()

              if (!tag) {
                const tagId = require('crypto').randomUUID()
                await knex('customer_tags').insert({
                  id: tagId,
                  tenant_id: form.tenant_id,
                  organization_id: form.organization_id,
                  name: tagName,
                  created_at: now,
                  updated_at: now,
                })
                tag = { id: tagId }
              }

              const existingLink = await knex('customer_entity_tags')
                .where('entity_id', contactId)
                .where('tag_id', tag.id)
                .first()

              if (!existingLink) {
                await knex('customer_entity_tags').insert({
                  id: require('crypto').randomUUID(),
                  entity_id: contactId,
                  tag_id: tag.id,
                  created_at: now,
                })
              }
            } catch {
              // Non-critical, don't fail
            }
          }
        }

        // Track engagement
        if (contactId) {
          trackEngagement(knex, form.organization_id, form.tenant_id, contactId, 'form_submitted').catch(() => {})
          checkSequenceTriggers(knex, form.organization_id, form.tenant_id, 'form_submit', {
            contactId, formId: form.id,
          }).catch(() => {})
        }

        // Dispatch webhooks
        if (contactId && !existing) {
          dispatchWebhook(knex, form.organization_id, 'contact.created', {
            contactId, email, name: displayName, source: 'form',
          }).catch(() => {})
        }

        dispatchWebhook(knex, form.organization_id, 'form.submitted', {
          contactId, formId: form.id, formName: form.name, formSlug: form.slug, data,
        }).catch(() => {})

        // Fire automation rules
        if (contactId) {
          executeAutomationRules(knex, form.organization_id, form.tenant_id, 'form_submitted', {
            contactId, formId: form.id, formSlug: form.slug,
          }).catch(() => {})
        }
        if (contactId && !existing) {
          executeAutomationRules(knex, form.organization_id, form.tenant_id, 'contact_created', {
            contactId, source: 'form',
          }).catch(() => {})
        }

        // Auto-add to email lists with form_submitted trigger
        if (contactId) {
          try {
            const autoLists = await knex('email_lists')
              .where('organization_id', form.organization_id)
              .where('source_type', 'form_submitted')
            for (const list of autoLists) {
              // Check if this list targets specific forms
              const desc = list.description || ''
              const triggerMatch = desc.match(/\[auto_trigger:(.+?)\]/)
              if (triggerMatch) {
                try {
                  const targetIds = JSON.parse(triggerMatch[1])
                  if (Array.isArray(targetIds) && targetIds.length > 0 && !targetIds.includes(form.id)) continue
                } catch {}
              }
              await knex.raw('INSERT INTO email_list_members (id, list_id, contact_id, added_at) VALUES (?, ?, ?, ?) ON CONFLICT (list_id, contact_id) DO NOTHING',
                [require('crypto').randomUUID(), list.id, contactId, new Date()])
              const [{ count }] = await knex('email_list_members').where('list_id', list.id).count()
              await knex('email_lists').where('id', list.id).update({ member_count: Number(count), updated_at: new Date() })
            }
          } catch {}
        }

        // Log activity
        if (contactId) {
          await knex('customer_activities').insert({
            id: require('crypto').randomUUID(),
            tenant_id: form.tenant_id,
            organization_id: form.organization_id,
            entity_id: contactId,
            activity_type: 'form_submission',
            subject: `Form submitted: "${form.name}"`,
            body: JSON.stringify(data),
            occurred_at: now,
            created_at: now,
            updated_at: now,
          }).catch(() => {})
        }
      } catch (err) {
        console.error('[forms.submit] contact creation failed (non-blocking)', err)
      }
    }

    // Send email notification if configured
    const notifyEmail = settings.notifyEmail
    if (notifyEmail) {
      try {
        const fieldLabels: Record<string, string> = {}
        for (const f of fields) fieldLabels[f.id] = f.label

        const rows = Object.entries(data)
          .filter(([, v]) => v !== '' && v !== null && v !== undefined)
          .map(([k, v]) => {
            const label = fieldLabels[k] || k
            const val = Array.isArray(v) ? v.join(', ') : String(v)
            return `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:500;color:#555;white-space:nowrap;vertical-align:top">${label}</td><td style="padding:8px 12px;border-bottom:1px solid #eee">${val}</td></tr>`
          })
          .join('')

        const emailHtml = `
          <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto">
            <h2 style="color:#1e293b;margin-bottom:4px">New form submission</h2>
            <p style="color:#64748b;margin-bottom:20px">${form.name} received a new response</p>
            <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
              ${rows}
            </table>
            <p style="color:#94a3b8;font-size:12px;margin-top:16px">This notification was sent because you have email notifications enabled for this form.</p>
          </div>`

        const { sendEmailByPurpose } = await import('@/modules/email/lib/email-router')
        await sendEmailByPurpose(knex, form.organization_id, form.tenant_id, 'transactional', {
          to: notifyEmail,
          subject: `New submission: ${form.name}`,
          htmlBody: emailHtml,
        }).catch((err: unknown) => console.error('[forms.submit] notification email failed', err))
      } catch (err) {
        console.error('[forms.submit] notification email failed (non-blocking)', err)
      }
    }

    // Send lead magnet delivery email
    if (email && settings.leadMagnet?.downloadUrl) {
      try {
        const lm = settings.leadMagnet
        const lmSubject = lm.emailSubject || 'Your download is ready'
        const lmBody = lm.emailBody || 'Thank you for signing up! Click the link below to download.'
        const lmUrl = lm.downloadUrl

        const safeUrl = lmUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        const safeBody = lmBody.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        const plainUrl = lmUrl.replace(/[<>"]/g, '')

        const lmHtml = `
          <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:32px 0">
            <p style="color:#475569;font-size:16px;line-height:1.6;margin-bottom:24px">${safeBody}</p>
            <a href="${safeUrl}"
               style="display:inline-block;padding:14px 28px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:16px"
               target="_blank">
              Download Now
            </a>
            <p style="color:#94a3b8;font-size:13px;margin-top:32px">
              If the button doesn't work, copy and paste this link into your browser:<br/>
              <a href="${safeUrl}" style="color:#2563eb;word-break:break-all">${plainUrl}</a>
            </p>
          </div>`

        const { sendEmailByPurpose } = await import('@/modules/email/lib/email-router')
        await sendEmailByPurpose(knex, form.organization_id, form.tenant_id, 'transactional', {
          to: email,
          subject: lmSubject,
          htmlBody: lmHtml,
        }).catch((err: unknown) => console.error('[forms.submit] lead magnet email failed', err))
      } catch (err) {
        console.error('[forms.submit] lead magnet email failed (non-blocking)', err)
      }
    }

    const successMessage = settings.successMessage || 'Thank you! Your response has been recorded.'
    const redirectUrl = settings.redirectUrl || null

    return NextResponse.json(
      { ok: true, message: successMessage, redirectUrl },
      { headers: CORS_HEADERS },
    )
  } catch (error) {
    console.error('[forms.public.submit] failed', error)
    return NextResponse.json({ ok: false, error: 'Failed to submit form' }, { status: 500, headers: CORS_HEADERS })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Forms (Public)',
  summary: 'Submit form response',
  methods: {
    POST: { summary: 'Submit a form response', tags: ['Forms (Public)'] },
    OPTIONS: { summary: 'CORS preflight', tags: ['Forms (Public)'] },
  },
}
