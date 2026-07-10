// ORM-SKIP: analytics/aggregation — multi-table joins better served by raw SQL
export const metadata = { path: '/deals/[id]/summary', GET: { requireAuth: true }, POST: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { meterCustomersAi } from '@/lib/usage/meter'
import { checkCustomersAiAllowance } from '@/lib/usage/allowance'
import { TenantDataEncryptionService } from '@open-mercato/shared/lib/encryption/tenantDataEncryptionService'
import { isTenantDataEncryptionEnabled } from '@open-mercato/shared/lib/encryption/toggles'
import { createKmsService } from '@open-mercato/shared/lib/encryption/kms'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

// Per-deal AI summary, cached on customer_deals.ai_summary (mirrors the
// contacts/[id]/summary pattern). Consumed by meeting-prep briefs and Scout;
// requires the columns from scripts/sql/ai-summaries-deal-thread.sql.

// Deal titles/descriptions are encrypted when tenant encryption is on.
async function decryptDeal(em: EntityManager, deal: any, tenantId: string, orgId: string): Promise<any> {
  if (!deal || !isTenantDataEncryptionEnabled()) return deal
  try {
    const svc = new TenantDataEncryptionService(em as any, { kms: createKmsService() })
    const dec = await svc.decryptEntityPayload('customers:customer_deal', { title: deal.title, description: deal.description }, tenantId, orgId)
    return { ...deal, title: dec.title ?? deal.title, description: dec.description ?? deal.description }
  } catch {
    return deal
  }
}

// GET — load saved summary (no generation)
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const { id: dealId } = await params

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const deal = await knex('customer_deals')
      .where('id', dealId)
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .first()

    if (!deal) return NextResponse.json({ ok: false, error: 'Deal not found' }, { status: 404 })

    if (deal.ai_summary) {
      return NextResponse.json({
        ok: true,
        data: { summary: deal.ai_summary, generatedAt: deal.ai_summary_at || null, isAi: true },
      })
    }
    return NextResponse.json({ ok: true, data: null })
  } catch (error) {
    console.error('[deals.summary.GET]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

// POST — generate (or regenerate) and save the summary
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId || !auth?.tenantId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const gate = await checkCustomersAiAllowance(auth)
  if (!gate.allowed) {
    return NextResponse.json({ ok: false, error: gate.message }, { status: 402 })
  }

  const aiKey = gate.byoApiKey || process.env.GOOGLE_GENERATIVE_AI_API_KEY
  if (!aiKey) return NextResponse.json({ ok: false, error: 'AI not configured' }, { status: 400 })

  const { id: dealId } = await params

  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()

    const rawDeal = await knex('customer_deals')
      .where('id', dealId)
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .first()
    if (!rawDeal) return NextResponse.json({ ok: false, error: 'Deal not found' }, { status: 404 })

    const deal = await decryptDeal(em, rawDeal, auth.tenantId, auth.orgId)

    // Gather deal context in parallel: linked people, deal emails, deal
    // comments, deal activities.
    const [people, emails, comments, activities] = await Promise.all([
      knex('customer_deal_people as cdp')
        .join('customer_entities as ce', 'ce.id', 'cdp.person_entity_id')
        .where('cdp.deal_id', dealId)
        .where('ce.organization_id', auth.orgId)
        .select('ce.display_name', 'cdp.role')
        .limit(10)
        .catch(() => []),
      knex('email_messages')
        .where('deal_id', dealId)
        .where('organization_id', auth.orgId)
        .orderBy('created_at', 'desc')
        .limit(10)
        .select('subject', 'direction', 'body_text', 'created_at')
        .catch(() => []),
      knex('customer_comments')
        .where('deal_id', dealId)
        .where('organization_id', auth.orgId)
        .whereNull('deleted_at')
        .orderBy('created_at', 'desc')
        .limit(10)
        .select('body', 'created_at')
        .catch(() => []),
      knex('customer_activities')
        .where('deal_id', dealId)
        .where('organization_id', auth.orgId)
        .orderBy('created_at', 'desc')
        .limit(15)
        .select('activity_type', 'subject', 'body', 'occurred_at', 'created_at')
        .catch(() => []),
    ])

    const value = deal.value_amount ? `${deal.value_currency || 'USD'} ${Number(deal.value_amount).toFixed(0)}` : 'no value set'
    const ageDays = Math.floor((Date.now() - new Date(deal.created_at).getTime()) / 86400000)

    const promptSections = [
      `Deal: "${deal.title}" — status ${deal.status}${deal.pipeline_stage ? `, stage ${deal.pipeline_stage}` : ''}, ${value}, opened ${ageDays} days ago${deal.expected_close_at ? `, expected close ${new Date(deal.expected_close_at).toLocaleDateString()}` : ''}${deal.probability != null ? `, probability ${deal.probability}%` : ''}`,
      deal.description ? `Description: ${String(deal.description).slice(0, 500)}` : null,
      people.length ? `People: ${people.map((p: any) => `${p.display_name}${p.role ? ` (${p.role})` : ''}`).join(', ')}` : null,
      emails.length ? `Recent emails: ${emails.map((e: any) => `${e.direction === 'inbound' ? 'Received' : 'Sent'} "${(e.body_text || e.subject || '').slice(0, 120)}" (${new Date(e.created_at).toLocaleDateString()})`).join('; ')}` : null,
      comments.length ? `Notes: ${comments.map((c: any) => `"${(c.body || '').slice(0, 100)}" (${new Date(c.created_at).toLocaleDateString()})`).join('; ')}` : null,
      activities.length ? `Activity: ${activities.map((a: any) => `${a.activity_type}${a.subject ? ` "${a.subject}"` : ''} (${new Date(a.occurred_at || a.created_at).toLocaleDateString()})`).join('; ')}` : null,
    ].filter(Boolean).join('\n')

    const prompt = `Summarize where this sales deal stands based on the data below. Be concise (3-5 sentences). Cover: current stage and momentum (moving or stalled), what has happened recently, any risks or blockers you can infer, and the most sensible next step. Natural professional prose, no bullet points, no headings.

${promptSections}`

    const aiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': aiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 350 },
        }),
      },
    )
    const aiData = await aiRes.json()
    void meterCustomersAi(auth, {
      model: 'gemini-3.5-flash',
      tokensIn: aiData?.usageMetadata?.promptTokenCount || 0,
      tokensOut: aiData?.usageMetadata?.candidatesTokenCount || 0,
      feature: 'deal-summary',
      byoKey: !!gate.byoApiKey,
    })
    const summary: string | undefined = aiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
    if (!summary) return NextResponse.json({ ok: false, error: 'AI could not generate a summary' }, { status: 500 })

    const now = new Date()
    await knex('customer_deals')
      .where('id', dealId)
      .where('organization_id', auth.orgId)
      .update({ ai_summary: summary, ai_summary_at: now, updated_at: now })

    return NextResponse.json({ ok: true, data: { summary, generatedAt: now.toISOString(), isAi: true } })
  } catch (error) {
    console.error('[deals.summary.POST]', error)
    return NextResponse.json({ ok: false, error: 'Failed to generate summary' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Pipeline',
  summary: 'AI-generated deal status summary',
  methods: {
    GET: { summary: 'Load saved deal summary', tags: ['Pipeline'] },
    POST: { summary: 'Generate and save AI deal summary', tags: ['Pipeline'] },
  },
}
