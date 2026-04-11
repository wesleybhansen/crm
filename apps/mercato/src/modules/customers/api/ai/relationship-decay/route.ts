// ORM-SKIP: AI generation/analysis — complex prompt construction, not CRUD

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { buildPersonaPrompt, getPersonaForOrg } from '../persona'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export const openApi: OpenApiRouteDoc = {
  GET: { summary: 'Get relationship decay alerts for current org', tags: ['AI', 'Relationship Decay'] },
  POST: { summary: 'Cron: detect decaying relationships and draft follow-ups', tags: ['AI', 'Relationship Decay'] },
}

export const metadata = { path: '/ai/relationship-decay',
  POST: { requireAuth: false },
}

interface DecayAlert {
  contactId: string
  displayName: string
  email: string
  score: number
  lastActivity: string
  avgFrequencyDays: number
  currentGapDays: number
  severity: 'yellow' | 'red'
  draftEmail?: string
}

async function detectDecayingRelationships(knex: any, orgId: string): Promise<DecayAlert[]> {
  const now = new Date()
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)

  // Get contacts with engagement scores and last_activity_at
  const scoredContacts = await knex('contact_engagement_scores as ces')
    .join('customer_entities as ce', 'ce.id', 'ces.contact_id')
    .where('ces.organization_id', orgId)
    .where('ces.score', '>', 0)
    .whereNotNull('ces.last_activity_at')
    .whereNull('ce.deleted_at')
    .select(
      'ce.id as contact_id',
      'ce.display_name',
      'ce.primary_email',
      'ces.score',
      'ces.last_activity_at'
    )

  if (scoredContacts.length === 0) return []

  const contactIds = scoredContacts.map((c: any) => c.contact_id)

  // Count interactions (emails + notes) per contact in last 90 days
  const emailCounts = await knex('email_messages')
    .whereIn('contact_id', contactIds)
    .where('organization_id', orgId)
    .where('created_at', '>=', ninetyDaysAgo)
    .groupBy('contact_id')
    .select('contact_id')
    .count('* as cnt')

  const noteCounts = await knex('contact_notes')
    .whereIn('contact_id', contactIds)
    .where('organization_id', orgId)
    .where('created_at', '>=', ninetyDaysAgo)
    .groupBy('contact_id')
    .select('contact_id')
    .count('* as cnt')

  const interactionMap: Record<string, number> = {}
  for (const row of emailCounts) {
    interactionMap[row.contact_id] = (interactionMap[row.contact_id] || 0) + Number(row.cnt)
  }
  for (const row of noteCounts) {
    interactionMap[row.contact_id] = (interactionMap[row.contact_id] || 0) + Number(row.cnt)
  }

  const alerts: DecayAlert[] = []

  for (const contact of scoredContacts) {
    const totalInteractions = interactionMap[contact.contact_id] || 0
    if (totalInteractions === 0) continue // No interaction history to calculate frequency from

    const avgFrequencyDays = 90 / totalInteractions
    const lastActivity = new Date(contact.last_activity_at)
    const currentGapDays = Math.floor((now.getTime() - lastActivity.getTime()) / (24 * 60 * 60 * 1000))

    let severity: 'yellow' | 'red' | null = null
    if (currentGapDays > 2 * avgFrequencyDays) {
      severity = 'red'
    } else if (currentGapDays > 1.5 * avgFrequencyDays) {
      severity = 'yellow'
    }

    if (severity) {
      alerts.push({
        contactId: contact.contact_id,
        displayName: contact.display_name || 'Unknown',
        email: contact.primary_email || '',
        score: contact.score,
        lastActivity: contact.last_activity_at,
        avgFrequencyDays: Math.round(avgFrequencyDays * 10) / 10,
        currentGapDays,
        severity,
      })
    }
  }

  // Sort: red first, then by gap size descending
  alerts.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'red' ? -1 : 1
    return b.currentGapDays - a.currentGapDays
  })

  return alerts.slice(0, 20)
}

export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()

    const alerts = await detectDecayingRelationships(knex, auth.orgId)

    return NextResponse.json({ ok: true, data: alerts })
  } catch (error) {
    console.error('[relationship-decay] GET error:', error)
    return NextResponse.json({ ok: false, error: 'Failed to compute decay alerts' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    // Cron auth
    const authHeader = req.headers.get('authorization')
    const cronSecret = process.env.SEQUENCE_PROCESS_SECRET
    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    }

    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()

    // Get all orgs
    const orgs = await knex('organizations').select('id', 'tenant_id')

    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY
    const model = process.env.AI_MODEL || 'gemini-2.0-flash'
    const results: Array<{ orgId: string; alertCount: number; draftsGenerated: number }> = []

    for (const org of orgs) {
      const alerts = await detectDecayingRelationships(knex, org.id)
      const redAlerts = alerts.filter(a => a.severity === 'red')

      let draftsGenerated = 0

      if (redAlerts.length > 0 && apiKey) {
        // Load persona for draft emails
        let personaPrompt = ''
        const profile = await getPersonaForOrg(knex, org.id)
        if (profile) {
          personaPrompt = buildPersonaPrompt(profile)
        }

        for (const alert of redAlerts.slice(0, 5)) {
          try {
            const prompt = `Write a short, warm check-in email to ${alert.displayName} (${alert.email}).
It's been ${alert.currentGapDays} days since we last connected. Their typical communication frequency is every ${alert.avgFrequencyDays} days.
Keep it under 4 sentences. Be genuine, not salesy. Reference wanting to catch up, not that we're tracking their engagement.
Return ONLY the email body text, no subject line.`

            const systemPrompt = personaPrompt || 'You are a helpful business assistant drafting follow-up emails.'

            const response = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  system_instruction: { parts: [{ text: systemPrompt }] },
                  contents: [{ role: 'user', parts: [{ text: prompt }] }],
                  generationConfig: { temperature: 0.8, maxOutputTokens: 256 },
                }),
              }
            )

            const data = await response.json()
            const draftBody = data.candidates?.[0]?.content?.parts?.[0]?.text
            if (draftBody) {
              alert.draftEmail = draftBody
              draftsGenerated++
            }
          } catch (err) {
            console.error(`[relationship-decay] Failed to draft for ${alert.contactId}:`, err)
          }
        }
      }

      results.push({ orgId: org.id, alertCount: alerts.length, draftsGenerated })
    }

    return NextResponse.json({ ok: true, data: results })
  } catch (error) {
    console.error('[relationship-decay] POST error:', error)
    return NextResponse.json({ ok: false, error: 'Failed to process decay alerts' }, { status: 500 })
  }
}
