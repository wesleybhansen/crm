export const metadata = { GET: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const { id: surveyId } = await params
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const survey = await knex('surveys').where('id', surveyId).where('organization_id', auth.orgId).first()
    if (!survey) return NextResponse.json({ ok: false, error: 'Survey not found' }, { status: 404 })

    const responses = await knex('survey_responses')
      .where('survey_id', surveyId)
      .orderBy('created_at', 'desc')
      .limit(500)

    const fields = typeof survey.fields === 'string' ? JSON.parse(survey.fields) : survey.fields

    // Build summary stats per field
    const summary: Record<string, unknown> = {}
    for (const field of fields) {
      const key = `field_${field.id}`
      const values = responses
        .map((r: { responses: Record<string, unknown> | string }) => {
          const resp = typeof r.responses === 'string' ? JSON.parse(r.responses) : r.responses
          return resp[key]
        })
        .filter((v: unknown) => v !== undefined && v !== null && v !== '')

      if (field.type === 'rating' || field.type === 'nps' || field.type === 'number') {
        const nums = values.map((v: unknown) => parseFloat(String(v))).filter((n: number) => !isNaN(n))
        const avg = nums.length > 0 ? nums.reduce((a: number, b: number) => a + b, 0) / nums.length : 0
        const distribution: Record<string, number> = {}
        for (const n of nums) {
          const k = String(n)
          distribution[k] = (distribution[k] || 0) + 1
        }
        summary[field.id] = { type: 'numeric', count: nums.length, average: Math.round(avg * 100) / 100, distribution }
      } else if (field.type === 'select' || field.type === 'radio' || field.type === 'checkbox') {
        const counts: Record<string, number> = {}
        for (const v of values) {
          const k = String(v)
          counts[k] = (counts[k] || 0) + 1
        }
        summary[field.id] = { type: 'choice', count: values.length, counts }
      } else if (field.type === 'multi_select') {
        const counts: Record<string, number> = {}
        for (const v of values) {
          const arr = Array.isArray(v) ? v : [v]
          for (const item of arr) {
            const k = String(item)
            counts[k] = (counts[k] || 0) + 1
          }
        }
        summary[field.id] = { type: 'multi_choice', count: values.length, counts }
      } else {
        summary[field.id] = { type: 'text', count: values.length, samples: values.slice(0, 20) }
      }
    }

    return NextResponse.json({
      ok: true,
      data: {
        survey,
        responses,
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
  methods: {
    GET: { summary: 'List responses for a survey with aggregated stats', tags: ['Surveys'] },
  },
}
