// ORM-SKIP: AI generation/analysis — complex prompt construction, not CRUD

import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { buildPersonaPrompt, getPersonaForOrg } from '../persona'
import { meterCustomersAi } from '@/lib/usage/meter'
import { checkCustomersAiAllowance } from '@/lib/usage/allowance'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { requireProcessAuth } from '@/lib/cron-auth'

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

// Reuses the proactive-followups inbox-proposal mechanism: a synthetic
// inbox_emails row (the proposal UI renders its subject), an inbox_proposals
// row (pending, shown in the dashboard review queue + bell), and a draft_reply
// inbox_proposal_actions row carrying the drafted body. The owner reviews and
// sends from the approval queue. NEVER auto-sends.
const DECAY_MARKER = 'Re-engage'

async function createDecayProposal(
  knex: any,
  orgId: string,
  tenantId: string,
  alert: DecayAlert,
): Promise<boolean> {
  if (!alert.draftEmail || !alert.email) return false

  // Idempotent: skip if an open (pending) re-engage proposal already exists for
  // this contact's email.
  const existing = await knex('inbox_proposals')
    .where('organization_id', orgId)
    .where('status', 'pending')
    .where('summary', 'like', `${DECAY_MARKER}%`)
    .whereRaw("participants::text ilike '%' || ? || '%'", [alert.email])
    .first()
  if (existing) return false

  const now = new Date()
  const title = `${DECAY_MARKER} ${alert.displayName} (going cold)`
  const subject = `Checking in, ${alert.displayName}`

  const emailId = crypto.randomUUID()
  await knex('inbox_emails').insert({
    id: emailId,
    tenant_id: tenantId,
    organization_id: orgId,
    forwarded_by_address: 'scout@noliai.com',
    to_address: alert.email,
    subject: title,
    status: 'processed',
    received_at: now,
    is_active: true,
    created_at: now,
    updated_at: now,
  })

  const proposalId = crypto.randomUUID()
  await knex('inbox_proposals').insert({
    id: proposalId,
    inbox_email_id: emailId,
    tenant_id: tenantId,
    organization_id: orgId,
    summary: `${title}. It has been ${alert.currentGapDays} days since you last connected. Your team drafted a check-in email.`,
    participants: JSON.stringify([{ name: alert.displayName, email: alert.email }]),
    confidence: 0.7,
    category: 'inquiry',
    status: 'pending',
    is_active: true,
    created_at: now,
    updated_at: now,
  })

  await knex('inbox_proposal_actions').insert({
    id: crypto.randomUUID(),
    proposal_id: proposalId,
    tenant_id: tenantId,
    organization_id: orgId,
    action_type: 'draft_reply',
    sort_order: 0,
    description: `Save a drafted check-in email for ${alert.displayName} to the contact timeline`,
    payload: JSON.stringify({
      to: alert.email,
      toName: alert.displayName,
      contactId: alert.contactId,
      subject,
      body: alert.draftEmail,
      context: 'Drafted by your Noli team (relationship decay): this contact is going cold.',
    }),
    status: 'pending',
    confidence: 0.7,
    created_at: now,
    updated_at: now,
  })

  return true
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
    // Cron auth (fail-closed, constant-time)
    const denied = requireProcessAuth(req, process.env.SEQUENCE_PROCESS_SECRET)
    if (denied) return denied

    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()

    // Get all orgs
    const orgs = await knex('organizations').select('id', 'tenant_id')

    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY
    const model = process.env.AI_MODEL || 'gemini-3.5-flash'
    const results: Array<{ orgId: string; alertCount: number; draftsGenerated: number; proposalsCreated: number }> = []

    for (const org of orgs) {
      // Per-org opt-in. business_profiles.decay_alerts_enabled defaults on;
      // a missing column/row is treated as enabled (feature is default-on).
      const profileFlag = await knex('business_profiles')
        .where('organization_id', org.id)
        .select('tenant_id', 'decay_alerts_enabled')
        .first()
        .catch(() => null as { tenant_id?: string; decay_alerts_enabled?: boolean } | null)
      if (profileFlag && profileFlag.decay_alerts_enabled === false) continue

      // Skip orgs over their AI allowance — don't bill the platform for cron AI.
      // Over-allowance orgs with a BYO key run on that key.
      const capGate = await checkCustomersAiAllowance({ orgId: org.id })
      if (!capGate.allowed) continue
      const orgKey = capGate.byoApiKey || apiKey
      const alerts = await detectDecayingRelationships(knex, org.id)
      const redAlerts = alerts.filter(a => a.severity === 'red')

      let draftsGenerated = 0
      let proposalsCreated = 0
      const tenantId = org.tenant_id || profileFlag?.tenant_id || null

      if (redAlerts.length > 0 && orgKey) {
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
              `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': orgKey },
                body: JSON.stringify({
                  system_instruction: { parts: [{ text: systemPrompt }] },
                  contents: [{ role: 'user', parts: [{ text: prompt }] }],
                  generationConfig: { temperature: 0.8, maxOutputTokens: 256 },
                }),
              }
            )

            const data = await response.json()
            void meterCustomersAi({ orgId: org.id }, {
              model,
              tokensIn: data?.usageMetadata?.promptTokenCount || 0,
              tokensOut: data?.usageMetadata?.candidatesTokenCount || 0,
              feature: 'relationship-decay',
              byoKey: !!capGate.byoApiKey,
            })
            const draftBody = data.candidates?.[0]?.content?.parts?.[0]?.text
            if (draftBody) {
              alert.draftEmail = draftBody
              draftsGenerated++

              // Persist the draft as an inbox proposal for owner review. The
              // owner approves/sends from the queue — NEVER auto-sent. Idempotent:
              // skips if an open re-engage proposal for this contact exists.
              if (tenantId) {
                try {
                  const created = await createDecayProposal(knex, org.id, tenantId, alert)
                  if (created) proposalsCreated++
                } catch (perr) {
                  console.error(`[relationship-decay] Failed to create proposal for ${alert.contactId}:`, perr)
                }
              }
            }
          } catch (err) {
            console.error(`[relationship-decay] Failed to draft for ${alert.contactId}:`, err)
          }
        }
      }

      results.push({ orgId: org.id, alertCount: alerts.length, draftsGenerated, proposalsCreated })
    }

    return NextResponse.json({ ok: true, data: results })
  } catch (error) {
    console.error('[relationship-decay] POST error:', error)
    return NextResponse.json({ ok: false, error: 'Failed to process decay alerts' }, { status: 500 })
  }
}
