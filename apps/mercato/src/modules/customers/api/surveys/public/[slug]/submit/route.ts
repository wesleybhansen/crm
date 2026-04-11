
import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import crypto from 'crypto'

export const metadata = { path: '/surveys/public/[slug]/submit', POST: { requireAuth: false } }

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const survey = await knex('surveys').where('slug', slug).where('is_active', true).first()
    if (!survey) return NextResponse.json({ ok: false, error: 'Survey not found' }, { status: 404 })

    const body = await req.json()
    const fields = typeof survey.fields === 'string' ? JSON.parse(survey.fields) : survey.fields

    // Validate required fields
    for (const field of fields) {
      if (field.required) {
        const key = `field_${field.id}`
        const value = body[key]
        if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
          return NextResponse.json({ ok: false, error: `${field.label} is required` }, { status: 400 })
        }
      }
    }

    // Extract responses (only field_ keys)
    const responses: Record<string, unknown> = {}
    for (const key of Object.keys(body)) {
      if (key.startsWith('field_')) {
        responses[key] = body[key]
      }
    }

    const respondentEmail = body.respondent_email?.trim() || null
    const respondentName = body.respondent_name?.trim() || null

    // Try to match contact by email
    let contactId: string | null = null
    if (respondentEmail) {
      const contact = await knex('customer_entities')
        .where('primary_email', respondentEmail)
        .where('organization_id', survey.organization_id)
        .whereNull('deleted_at')
        .first()
      if (contact) contactId = contact.id
    }

    const responseId = crypto.randomUUID()
    await knex('survey_responses').insert({
      id: responseId,
      organization_id: survey.organization_id,
      survey_id: survey.id,
      contact_id: contactId,
      respondent_email: respondentEmail,
      respondent_name: respondentName,
      responses: JSON.stringify(responses),
      created_at: new Date(),
    })

    // Increment response count
    await knex('surveys').where('id', survey.id).increment('response_count', 1).update({ updated_at: new Date() })

    // Log to contact timeline
    if (contactId) {
      const { logTimelineEvent } = await import('@/lib/timeline')
      await logTimelineEvent(knex, {
        tenantId: survey.tenant_id, organizationId: survey.organization_id, contactId,
        eventType: 'survey_response', title: `Completed survey: ${survey.title}`,
        metadata: { surveyId: survey.id },
      })
    }

    return NextResponse.json({ ok: true, thankYouMessage: survey.thank_you_message })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed to submit response' }, { status: 500 })
  }
}
