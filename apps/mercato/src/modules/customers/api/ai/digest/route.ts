
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { buildPersonaPrompt, getPersonaForOrg } from '../persona'
import { sendEmailByPurpose } from '@/modules/email/lib/email-router'

export const metadata = {
  POST: { requireAuth: false },
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function gatherDigestData(knex: ReturnType<EntityManager['getKnex']>, orgId: string, tenantId: string, days: number) {
  const now = new Date()
  const periodStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  const w = { tenant_id: tenantId, organization_id: orgId }

  // New contacts
  const newContacts = await knex('customer_entities')
    .where(w).whereNull('deleted_at')
    .where('created_at', '>=', periodStart)
    .select('display_name', 'primary_email', 'source')
    .orderBy('created_at', 'desc')
    .limit(20)

  // Deals won/lost
  const dealsWon = await knex('customer_deals')
    .where(w).whereNull('deleted_at')
    .where('status', 'win')
    .where('updated_at', '>=', periodStart)
    .select('title', 'value_amount')

  const dealsLost = await knex('customer_deals')
    .where(w).whereNull('deleted_at')
    .where('status', 'lost')
    .where('updated_at', '>=', periodStart)
    .select('title', 'value_amount')

  // Emails sent + open rate
  let emailsSent = 0
  let emailsOpened = 0
  try {
    const [emailStats] = await knex('email_messages')
      .where('organization_id', orgId)
      .where('direction', 'outbound')
      .where('created_at', '>=', periodStart)
      .select(
        knex.raw('count(*) as sent'),
        knex.raw("count(*) filter (where status = 'opened') as opened"),
      )
    emailsSent = Number(emailStats?.sent || 0)
    emailsOpened = Number(emailStats?.opened || 0)
  } catch {}

  // Landing page submissions
  let submissionCount = 0
  try {
    const [subStats] = await knex('form_submissions')
      .where('organization_id', orgId)
      .where('created_at', '>=', periodStart)
      .count('* as count')
    submissionCount = Number(subStats?.count || 0)
  } catch {}

  // Revenue (invoices paid)
  let revenue = 0
  try {
    const [revStats] = await knex('invoices')
      .where(w).whereNull('deleted_at')
      .where('status', 'paid')
      .where('paid_at', '>=', periodStart)
      .select(knex.raw('coalesce(sum(total), 0) as total_revenue'))
    revenue = Number(revStats?.total_revenue || 0)
  } catch {}

  // Contacts going cold (engagement score dropping — no activity in 14+ days)
  let coldContacts: Array<{ display_name: string; score: number }> = []
  try {
    coldContacts = await knex('contact_engagement_scores as ces')
      .join('customer_entities as ce', 'ce.id', 'ces.contact_id')
      .where('ces.organization_id', orgId)
      .whereNull('ce.deleted_at')
      .where('ce.status', 'active')
      .where('ces.last_activity_at', '<', new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000))
      .where('ces.score', '>', 0)
      .select('ce.display_name', 'ces.score')
      .orderBy('ces.score', 'desc')
      .limit(5)
  } catch {}

  const wonValue = dealsWon.reduce((sum, d) => sum + Number(d.value_amount || 0), 0)
  const lostValue = dealsLost.reduce((sum, d) => sum + Number(d.value_amount || 0), 0)
  const openRate = emailsSent > 0 ? Math.round((emailsOpened / emailsSent) * 100) : 0

  return {
    periodDays: days,
    newContacts,
    newContactCount: newContacts.length,
    dealsWon: dealsWon.map(d => ({ title: d.title, value: Number(d.value_amount || 0) })),
    dealsLost: dealsLost.map(d => ({ title: d.title, value: Number(d.value_amount || 0) })),
    wonValue,
    lostValue,
    emailsSent,
    openRate,
    submissionCount,
    revenue,
    coldContacts,
  }
}

async function generateDigestHtml(data: Awaited<ReturnType<typeof gatherDigestData>>, personaPrompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY
  if (!apiKey) {
    throw new Error('Gemini API key not configured')
  }

  const dataSection = `
PERIOD: Last ${data.periodDays} days

NEW CONTACTS (${data.newContactCount}):
${data.newContacts.length > 0 ? data.newContacts.map(c => `- ${c.display_name}${c.source ? ` (from ${c.source})` : ''}`).join('\n') : 'None'}

DEALS WON (${data.dealsWon.length}): Total $${data.wonValue.toLocaleString()}
${data.dealsWon.length > 0 ? data.dealsWon.map(d => `- "${d.title}" — $${d.value.toLocaleString()}`).join('\n') : 'None'}

DEALS LOST (${data.dealsLost.length}): Total $${data.lostValue.toLocaleString()}
${data.dealsLost.length > 0 ? data.dealsLost.map(d => `- "${d.title}" — $${d.value.toLocaleString()}`).join('\n') : 'None'}

EMAILS SENT: ${data.emailsSent} | Open Rate: ${data.openRate}%
LANDING PAGE SUBMISSIONS: ${data.submissionCount}
REVENUE (Invoices Paid): $${data.revenue.toLocaleString()}

CONTACTS GOING COLD:
${data.coldContacts.length > 0 ? data.coldContacts.map(c => `- ${c.display_name} (score: ${c.score})`).join('\n') : 'None — all contacts are engaged'}
`

  const prompt = `${personaPrompt}

Generate a weekly business review email in clean HTML format. Be specific with numbers and names from the data below. Include 3 actionable suggestions for next week based on the data.

Format as a well-styled HTML email body (no <html>/<head>/<body> tags — just the inner content). Use inline styles. Keep it scannable with headers and bullet points. Use a professional, clean design.

DATA:
${dataSection}`

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
      }),
    },
  )

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}))
    throw new Error(`Gemini API error (${res.status}): ${JSON.stringify(errorData)}`)
  }

  const result = await res.json()
  const text = result.candidates?.[0]?.content?.parts?.[0]?.text || ''

  // Strip markdown code fences if present
  return text.replace(/^```html?\n?/i, '').replace(/\n?```$/i, '').trim()
}

// ── POST — Cron-triggered digest send ────────────────────────────────────────

export async function POST(req: Request) {
  const secret = process.env.SEQUENCE_PROCESS_SECRET
  if (secret) {
    const authHeader = req.headers.get('authorization')
    if (authHeader !== `Bearer ${secret}`) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    }
  } else if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ ok: false, error: 'SEQUENCE_PROCESS_SECRET not configured' }, { status: 500 })
  }

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Find all orgs with a business profile
    const orgs = await knex('business_profiles')
      .select('organization_id', 'tenant_id', 'business_name', 'digest_frequency', 'digest_day')

    const now = new Date()
    const currentDay = now.getDay() // 0=Sunday, 1=Monday, ...

    const results: Array<{ orgId: string; status: string; error?: string }> = []

    for (const org of orgs) {
      const frequency = org.digest_frequency || 'weekly'

      // Skip disabled orgs
      if (frequency === 'off') {
        results.push({ orgId: org.organization_id, status: 'skipped', error: 'Digest disabled' })
        continue
      }

      // For weekly, only send on the configured day
      if (frequency === 'weekly') {
        const digestDay = org.digest_day ?? 1
        if (currentDay !== digestDay) {
          results.push({ orgId: org.organization_id, status: 'skipped', error: 'Not digest day' })
          continue
        }
      }

      try {
        const days = frequency === 'daily' ? 1 : 7

        // Find a user with an email to send the digest to
        const emailConnection = await knex('email_connections')
          .where('organization_id', org.organization_id)
          .where('is_active', true)
          .orderBy('is_primary', 'desc')
          .first()

        if (!emailConnection) {
          results.push({ orgId: org.organization_id, status: 'skipped', error: 'No email connection' })
          continue
        }

        const persona = await getPersonaForOrg(knex, org.organization_id)
        const personaPrompt = persona ? buildPersonaPrompt(persona) : 'You are Scout, a professional business assistant.'

        const data = await gatherDigestData(knex, org.organization_id, org.tenant_id, days)
        const digestHtml = await generateDigestHtml(data, personaPrompt)

        const businessName = org.business_name || 'Your Business'
        const periodLabel = frequency === 'daily' ? 'Daily' : 'Weekly'
        const subject = `${periodLabel} Business Review — ${businessName}`

        // Send digest email to the user
        const sendResult = await sendEmailByPurpose(
          knex,
          org.organization_id,
          org.tenant_id,
          'transactional',
          {
            to: emailConnection.email_address,
            subject,
            htmlBody: digestHtml,
          },
        )

        if (sendResult.ok) {
          results.push({ orgId: org.organization_id, status: 'sent' })
        } else {
          results.push({ orgId: org.organization_id, status: 'failed', error: sendResult.error })
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        console.error(`[ai.digest] Failed for org ${org.organization_id}:`, message)
        results.push({ orgId: org.organization_id, status: 'failed', error: message })
      }
    }

    const sent = results.filter(r => r.status === 'sent').length
    const skipped = results.filter(r => r.status === 'skipped').length
    const failed = results.filter(r => r.status === 'failed').length

    return NextResponse.json({ ok: true, data: { sent, skipped, failed, results } })
  } catch (error) {
    console.error('[ai.digest] POST error:', error)
    return NextResponse.json({ ok: false, error: 'Failed to process digests' }, { status: 500 })
  }
}

// ── GET — Preview digest for current user ────────────────────────────────────

export async function GET() {
  try {
    const auth = await getAuthFromCookies()
    if (!auth?.tenantId || !auth?.orgId) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    }

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const persona = await getPersonaForOrg(knex, auth.orgId)
    const personaPrompt = persona ? buildPersonaPrompt(persona) : 'You are Scout, a professional business assistant.'

    const data = await gatherDigestData(knex, auth.orgId, auth.tenantId, 7)
    const digestHtml = await generateDigestHtml(data, personaPrompt)

    return NextResponse.json({
      ok: true,
      data: {
        html: digestHtml,
        stats: data,
      },
    })
  } catch (error) {
    console.error('[ai.digest] GET error:', error)
    return NextResponse.json({ ok: false, error: 'Failed to generate digest preview' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'AI',
  summary: 'Smart Digest / Weekly AI Review',
  methods: {
    GET: { summary: 'Preview weekly digest for the current org', tags: ['AI'] },
    POST: { summary: 'Send digest emails for all eligible orgs (cron)', tags: ['AI'] },
  },
}
