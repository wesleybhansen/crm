export const metadata = { path: '/surveys/[id]/responses', GET: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { Survey, SurveyResponse } from '../../../../data/schema'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const { id: surveyId } = await params
    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()

    const survey = await em.findOne(Survey, { id: surveyId, organizationId: auth.orgId, tenantId: auth.tenantId })
    if (!survey) return NextResponse.json({ ok: false, error: 'Survey not found' }, { status: 404 })

    const responses = await em.find(SurveyResponse, {
      surveyId, organizationId: auth.orgId,
    }, { orderBy: { createdAt: 'desc' }, limit: 500 })

    const fields = Array.isArray(survey.fields) ? survey.fields : []

    // Build summary stats per field
    const summary: Record<string, unknown> = {}
    for (const field of fields as Array<{ id: string; type: string }>) {
      const key = `field_${field.id}`
      const values = responses
        .map(r => {
          const resp = r.responses as Record<string, unknown>
          return resp[key]
        })
        .filter(v => v !== undefined && v !== null && v !== '')

      if (field.type === 'rating' || field.type === 'nps' || field.type === 'number') {
        const nums = values.map(v => parseFloat(String(v))).filter(n => !isNaN(n))
        const avg = nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : 0
        const distribution: Record<string, number> = {}
        for (const n of nums) { distribution[String(n)] = (distribution[String(n)] || 0) + 1 }
        summary[field.id] = { type: 'numeric', count: nums.length, average: Math.round(avg * 100) / 100, distribution }
      } else if (['select', 'radio', 'checkbox'].includes(field.type)) {
        const counts: Record<string, number> = {}
        for (const v of values) { counts[String(v)] = (counts[String(v)] || 0) + 1 }
        summary[field.id] = { type: 'choice', count: values.length, counts }
      } else if (field.type === 'multi_select') {
        const counts: Record<string, number> = {}
        for (const v of values) {
          for (const item of (Array.isArray(v) ? v : [v])) { counts[String(item)] = (counts[String(item)] || 0) + 1 }
        }
        summary[field.id] = { type: 'multi_choice', count: values.length, counts }
      } else {
        summary[field.id] = { type: 'text', count: values.length, samples: values.slice(0, 20) }
      }
    }

    return NextResponse.json({
      ok: true,
      data: {
        survey: {
          id: survey.id, title: survey.title, description: survey.description,
          slug: survey.slug, fields: survey.fields, is_active: survey.isActive,
          response_count: survey.responseCount, created_at: survey.createdAt,
        },
        responses: responses.map(r => ({
          id: r.id, survey_id: r.surveyId, contact_id: r.contactId,
          respondent_email: r.respondentEmail, respondent_name: r.respondentName,
          responses: r.responses, created_at: r.createdAt,
        })),
        summary,
        totalResponses: responses.length,
      },
    })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed to load responses' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Surveys', summary: 'Survey responses with summary stats',
  methods: { GET: { summary: 'List responses for a survey with aggregated stats', tags: ['Surveys'] } },
}
