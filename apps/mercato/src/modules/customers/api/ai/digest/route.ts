// ORM-SKIP: AI generation/analysis — complex prompt construction, not CRUD

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { buildPersonaPrompt, getPersonaForOrg } from '../persona'
import { sendEmailByPurpose } from '@/modules/email/lib/email-router'
import { meterCustomersAi } from '@/lib/usage/meter'
import { checkCustomersAiAllowance } from '@/lib/usage/allowance'
import { requireProcessAuth } from '@/lib/cron-auth'
import { decryptRowFields, CONTACT_ENTITY_KEY, DEAL_ENTITY_KEY } from '@open-mercato/shared/lib/encryption/decryptRows'
import { renderDigestHtml, money, type DigestData, type DigestProse } from '../../../lib/digest-render'
import { geminiGenerationConfig, geminiText } from '@/lib/ai/gemini'

export const metadata = { path: '/ai/digest',
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

  // Raw knex skips the decrypting subscriber, so the digest handed the model
  // ciphertext for every name, address and deal title.
  await decryptRowFields(null, CONTACT_ENTITY_KEY, newContacts, ['display_name', 'primary_email'], tenantId, orgId)

  // Deals won/lost
  const dealsWon = await knex('customer_deals')
    .where(w).whereNull('deleted_at')
    .where('status', 'win')
    .where('updated_at', '>=', periodStart)
    .select('title', 'value_amount')
  await decryptRowFields(null, DEAL_ENTITY_KEY, dealsWon, ['title'], tenantId, orgId)

  const dealsLost = await knex('customer_deals')
    .where(w).whereNull('deleted_at')
    .where('status', 'lost')
    .where('updated_at', '>=', periodStart)
    .select('title', 'value_amount')
  await decryptRowFields(null, DEAL_ENTITY_KEY, dealsLost, ['title'], tenantId, orgId)

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
    // Same raw-knex trap as the lists above: decrypt before the model sees it.
    await decryptRowFields(null, CONTACT_ENTITY_KEY, coldContacts, ['display_name'], tenantId, orgId)
  } catch {}

  const wonValue = dealsWon.reduce((sum, d) => sum + Number(d.value_amount || 0), 0)
  const lostValue = dealsLost.reduce((sum, d) => sum + Number(d.value_amount || 0), 0)
  const openRate = emailsSent > 0 ? Math.round((emailsOpened / emailsSent) * 100) : 0

  // Weighted forecast for THIS month (T3): open deals expected to close before
  // month-end, value x probability (unset probability = 50%). Answers "will I
  // hit my month?" right inside the digest.
  let forecastThisMonth = { deals: 0, weighted: 0 }
  try {
    const [row] = await knex('customer_deals')
      .where('organization_id', orgId)
      .where('tenant_id', tenantId)
      .whereNull('deleted_at')
      .where('status', 'open')
      .whereNotNull('expected_close_at')
      // Only THIS month's window — without the lower bound, every stale
      // overdue deal from months past inflated the forecast.
      .whereRaw(`expected_close_at >= date_trunc('month', now())`)
      .whereRaw(`expected_close_at < (date_trunc('month', now()) + interval '1 month')`)
      .select(
        knex.raw('count(*)::int as deals'),
        knex.raw('coalesce(sum(value_amount * coalesce(probability, 50) / 100.0), 0)::numeric as weighted'),
      )
    if (row) forecastThisMonth = { deals: Number((row as Record<string, unknown>).deals || 0), weighted: Math.round(Number((row as Record<string, unknown>).weighted || 0)) }
  } catch {}

  return {
    forecastThisMonth,
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

/* The model writes the words, never the markup.
 *
 * It used to return the whole HTML email against a 2,048 token ceiling, and a
 * gemini-3.x model spends part of that budget thinking. A real digest hit the
 * cap mid-tag and shipped `<span style="font-size:` into a customer's inbox
 * with the rest of the report missing. Asking for a few short strings instead
 * means a cut-off answer can only cost us the prose, the numbers are ours and
 * always correct, and the layout cannot break. */
async function generateDigestProse(
  data: DigestData,
  personaPrompt: string,
  orgId?: string | null,
  byoApiKey?: string | null,
): Promise<DigestProse | null> {
  const apiKey = byoApiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY
  if (!apiKey) return null

  const dataSection = `
PERIOD: Last ${data.periodDays} days

NEW CONTACTS (${data.newContactCount}):
${data.newContacts.length > 0 ? data.newContacts.map(c => `- ${c.display_name}${c.source ? ` (from ${c.source})` : ''}`).join('\n') : 'None'}

DEALS WON (${data.dealsWon.length}): Total ${money(data.wonValue)}
${data.dealsWon.length > 0 ? data.dealsWon.map(d => `- "${d.title}" — ${money(d.value)}`).join('\n') : 'None'}

DEALS LOST (${data.dealsLost.length}): Total ${money(data.lostValue)}
${data.dealsLost.length > 0 ? data.dealsLost.map(d => `- "${d.title}" — ${money(d.value)}`).join('\n') : 'None'}

EMAILS SENT: ${data.emailsSent} | Open rate: ${data.openRate}%
LANDING PAGE SUBMISSIONS: ${data.submissionCount}
REVENUE (invoices paid): ${money(data.revenue)}
FORECAST THIS MONTH: ${data.forecastThisMonth.deals} open deal(s), weighted ${money(data.forecastThisMonth.weighted)}

CONTACTS GOING COLD:
${data.coldContacts.length > 0 ? data.coldContacts.map(c => `- ${c.display_name} (score: ${c.score})`).join('\n') : 'None, every contact is engaged'}
`

  const prompt = `${personaPrompt}

Write the words for this week's business review. Return JSON only.

- status: two to four words naming where the business stands this week, in plain language. Examples: "Quiet week", "Pipeline building", "Revenue up".
- summary: two or three sentences on what actually happened, using the real numbers and names below. If nothing happened, say so plainly and say what would change that. Never invent a number that is not in the data.
- suggestions: exactly three specific things to do next week, each one sentence, each tied to something in the data.

Write plain sentences. No markup, no markdown, no em dashes, no exclamation marks.

DATA:
${dataSection}`

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: geminiGenerationConfig({
            temperature: 0.7,
            // The answer budget; thinking gets its own reserve on top.
            maxOutputTokens: 4096,
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'OBJECT',
              properties: {
                status: { type: 'STRING' },
                summary: { type: 'STRING' },
                suggestions: { type: 'ARRAY', items: { type: 'STRING' } },
              },
              required: ['status', 'summary', 'suggestions'],
            },
          }),
        }),
      },
    )
    if (!res.ok) return null

    const result = await res.json()
    void meterCustomersAi({ orgId }, {
      model: 'gemini-3.8-flash',
      tokensIn: result?.usageMetadata?.promptTokenCount || 0,
      tokensOut: result?.usageMetadata?.candidatesTokenCount || 0,
      feature: 'digest',
      byoKey: !!byoApiKey,
    })

    // A cut-off answer is not partially usable, so it is dropped rather than
    // rendered. The report still sends with its numbers.
    if (result?.candidates?.[0]?.finishReason && result.candidates[0].finishReason !== 'STOP') return null

    const text = String(geminiText(result) || '')
      .replace(/^```json?\n?/i, '')
      .replace(/\n?```$/i, '')
      .trim()
    if (!text) return null

    const parsed = JSON.parse(text) as Partial<DigestProse>
    const suggestions = Array.isArray(parsed.suggestions)
      ? parsed.suggestions.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).slice(0, 3)
      : []
    if (!parsed.status || !parsed.summary) return null
    return { status: String(parsed.status), summary: String(parsed.summary), suggestions }
  } catch {
    return null
  }
}

async function generateDigestHtml(
  data: DigestData,
  personaPrompt: string,
  orgId?: string | null,
  byoApiKey?: string | null,
  businessName = 'Noli AI',
): Promise<string> {
  const prose = await generateDigestProse(data, personaPrompt, orgId, byoApiKey)
  return renderDigestHtml(data, prose, businessName)
}

// ── POST — Cron-triggered digest send ────────────────────────────────────────

export async function POST(req: Request) {
  const denied = requireProcessAuth(req, process.env.SEQUENCE_PROCESS_SECRET)
  if (denied) return denied

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

      // Skip orgs over their AI allowance — the digest body is AI-generated.
      const capGate = await checkCustomersAiAllowance({ orgId: org.organization_id })
      if (!capGate.allowed) {
        results.push({ orgId: org.organization_id, status: 'skipped', error: 'Over AI allowance' })
        continue
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

        const businessName = org.business_name || 'Your Business'
        const data = await gatherDigestData(knex, org.organization_id, org.tenant_id, days)
        const digestHtml = await generateDigestHtml(data, personaPrompt, org.organization_id, capGate.byoApiKey, businessName)

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

    // Gate before generating (interactive preview path was ungated).
    const gate = await checkCustomersAiAllowance(auth)
    if (!gate.allowed) return NextResponse.json({ ok: false, error: gate.message }, { status: 402 })

    const persona = await getPersonaForOrg(knex, auth.orgId)
    const personaPrompt = persona ? buildPersonaPrompt(persona) : 'You are Scout, a professional business assistant.'

    const data = await gatherDigestData(knex, auth.orgId, auth.tenantId, 7)
    // The name lives on business_profiles, keyed by organization_id, which is
    // where the scheduled path reads it from too.
    const previewProfile = await knex('business_profiles')
      .where({ organization_id: auth.orgId, tenant_id: auth.tenantId })
      .select('business_name')
      .first()
    const digestHtml = await generateDigestHtml(
      data,
      personaPrompt,
      auth.orgId,
      gate.byoApiKey,
      (previewProfile as { business_name?: string } | undefined)?.business_name || 'Your Business',
    )

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
