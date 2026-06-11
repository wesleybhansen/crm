import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { checkCustomersAiAllowance } from '@/lib/usage/allowance'
import { meterCustomersAi } from '@/lib/usage/meter'

/*
 * Internal server-to-server endpoint (Noli U-53: CRM follow-up execution).
 * The hub's daily proactive pass calls this; it finds neglected contacts
 * (no outbound email recently), DRAFTS a follow-up in the business's voice,
 * and parks each as a ready-to-approve inbox proposal (draft_reply action) —
 * the CRM's native review surface, already watched by the dashboard bell.
 *
 * Guard rails: allowance-gated + metered like every CRM AI call; max 2
 * drafts per run; never more than 3 pending proactive proposals at once;
 * never drafts twice for the same contact while a proactive proposal for
 * them is pending or was created in the last 14 days.
 */
export const metadata = {
  path: '/internal/proactive-followups',
  POST: { requireAuth: false },
}

const MARKER = 'Proactive follow-up:'

type Draft = { subject: string; body: string }

async function generateDraft(
  apiKey: string,
  business: { name: string; description: string; voice: string },
  contact: { name: string; source: string; daysSince: number },
): Promise<{ draft: Draft | null; tokensIn: number; tokensOut: number }> {
  const prompt = `You write follow-up emails for ${business.name}. ${business.description}
Brand voice: ${business.voice || 'warm, plainspoken, professional'}.

Write a SHORT follow-up email to ${contact.name}, a lead${contact.source ? ` who came in via ${contact.source}` : ''} about ${contact.daysSince} days ago and has not been emailed since. Goal: re-open the conversation and invite one small next step. 60 to 90 words, 2 short paragraphs, no placeholders like [Name] (address them by first name if you have one, otherwise just open warmly), sign off with the business name. No em dashes.

Return STRICT JSON: {"subject": "...", "body": "..."}`

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 2048, responseMimeType: 'application/json' },
        }),
        signal: AbortSignal.timeout(30_000),
      },
    )
    if (!r.ok) return { draft: null, tokensIn: 0, tokensOut: 0 }
    const data = (await r.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
    }
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
    const parsed = JSON.parse(text) as { subject?: string; body?: string }
    const subject = (parsed.subject ?? '').trim().slice(0, 300)
    const body = (parsed.body ?? '').trim().slice(0, 6000)
    return {
      draft: subject && body ? { subject, body } : null,
      tokensIn: data.usageMetadata?.promptTokenCount ?? 0,
      tokensOut: data.usageMetadata?.candidatesTokenCount ?? 0,
    }
  } catch {
    return { draft: null, tokensIn: 0, tokensOut: 0 }
  }
}

export async function POST(req: Request) {
  const secret = process.env.NOLI_INTERNAL_SERVICE_SECRET
  const authHeader = (req.headers.get('authorization') || '').trim()
  const expected = secret ? `Bearer ${secret}` : ''
  if (
    !secret ||
    authHeader.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))
  ) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const body = (await req.json().catch(() => ({}))) as { noliUserId?: unknown }
  const noliUserId = typeof body.noliUserId === 'string' ? body.noliUserId.trim() : ''
  if (!noliUserId) {
    return NextResponse.json({ ok: false, error: 'noliUserId required' }, { status: 400 })
  }

  try {
    const { findNoliUserById } = await import('@open-mercato/shared/lib/noli/core-client')
    const noliUser = await findNoliUserById(noliUserId)
    if (!noliUser?.clerk_user_id) return NextResponse.json({ ok: true, drafted: 0 })
    const { resolveClerkUserToAuthContext } = await import('@open-mercato/shared/lib/auth/clerk')
    const auth = await resolveClerkUserToAuthContext(noliUser.clerk_user_id)
    if (!auth?.orgId || !auth?.tenantId) return NextResponse.json({ ok: true, drafted: 0 })
    const orgId = auth.orgId as string
    const tenantId = auth.tenantId as string

    const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Backpressure: never stack up unreviewed proactive proposals.
    const pendingProactive = await knex('inbox_proposals')
      .where('organization_id', orgId)
      .where('status', 'pending')
      .where('summary', 'like', `${MARKER}%`)
      .count({ n: '*' })
      .first()
    if (Number((pendingProactive as { n?: string | number } | undefined)?.n ?? 0) >= 3) {
      return NextResponse.json({ ok: true, drafted: 0, reason: 'pending proposals awaiting review' })
    }

    // Allowance gate + key resolution (BYO fall-through, platform otherwise).
    const gate = await checkCustomersAiAllowance({ orgId })
    if (!gate.allowed) return NextResponse.json({ ok: true, drafted: 0, reason: 'allowance' })
    const apiKey = gate.byoApiKey || process.env.GOOGLE_GENERATIVE_AI_API_KEY
    if (!apiKey) return NextResponse.json({ ok: true, drafted: 0, reason: 'no key' })

    // Neglected contacts: have an email, created 2-90 days ago, no outbound
    // email in 14 days, and no recent proactive proposal already covering them.
    const candidates = (await knex('customer_entities as ce')
      .where('ce.organization_id', orgId)
      .whereNull('ce.deleted_at')
      .whereNotNull('ce.primary_email')
      .where('ce.created_at', '<', new Date(Date.now() - 2 * 24 * 60 * 60 * 1000))
      .where('ce.created_at', '>', new Date(Date.now() - 90 * 24 * 60 * 60 * 1000))
      .whereNotExists(
        knex('email_messages as em')
          .whereRaw('em.contact_id = ce.id')
          .where('em.direction', 'outbound')
          .where('em.created_at', '>', new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)),
      )
      .whereNotExists(
        knex('inbox_proposals as ip')
          .whereRaw('ip.organization_id = ce.organization_id')
          .where('ip.summary', 'like', `${MARKER}%`)
          .whereRaw("ip.participants::text ilike '%' || ce.primary_email || '%'")
          .where('ip.created_at', '>', new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)),
      )
      .orderBy('ce.created_at', 'desc')
      .limit(2)
      .select('ce.id', 'ce.display_name', 'ce.primary_email', 'ce.source', 'ce.created_at')) as Array<{
      id: string
      display_name: string | null
      primary_email: string
      source: string | null
      created_at: Date | string
    }>
    if (candidates.length === 0) return NextResponse.json({ ok: true, drafted: 0 })

    // Voice material from the U-1 business profile.
    const bp = (await knex('business_profiles')
      .where('organization_id', orgId)
      .first()
      .catch(() => null)) as { business_name?: string; business_description?: string } | null
    const business = {
      name: bp?.business_name || 'our team',
      description: bp?.business_description || '',
      voice: '',
    }

    let drafted = 0
    const names: string[] = []
    for (const c of candidates) {
      const daysSince = Math.max(
        1,
        Math.round((Date.now() - new Date(c.created_at).getTime()) / (24 * 60 * 60 * 1000)),
      )
      const { draft, tokensIn, tokensOut } = await generateDraft(apiKey, business, {
        name: c.display_name || 'there',
        source: c.source || '',
        daysSince,
      })
      void meterCustomersAi({ orgId }, {
        model: 'gemini-2.5-flash',
        tokensIn,
        tokensOut,
        feature: 'proactive-followup',
        byoKey: Boolean(gate.byoApiKey),
      })
      if (!draft) continue

      const now = new Date()
      const emailId = crypto.randomUUID()
      // Synthetic inbox email: inbox_proposals.inbox_email_id is required and
      // the proposal UI renders the email's subject/sender.
      await knex('inbox_emails').insert({
        id: emailId,
        tenant_id: tenantId,
        organization_id: orgId,
        forwarded_by_address: 'scout@noliai.com',
        to_address: c.primary_email,
        subject: `${MARKER} ${c.display_name || c.primary_email}`,
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
        summary: `${MARKER} ${c.display_name || c.primary_email} has not heard from you in a while. Your team drafted a re-engagement email.`,
        participants: JSON.stringify([{ name: c.display_name || '', email: c.primary_email }]),
        confidence: 0.75,
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
        description: `Save a drafted follow-up email for ${c.display_name || c.primary_email} to the contact timeline`,
        payload: JSON.stringify({
          to: c.primary_email,
          toName: c.display_name || null,
          subject: draft.subject,
          body: draft.body,
          context: 'Drafted by your Noli team (proactive pass): this contact has had no outbound email recently.',
        }),
        status: 'pending',
        confidence: 0.75,
        created_at: now,
        updated_at: now,
      })
      drafted += 1
      names.push(c.display_name || c.primary_email)
    }

    return NextResponse.json({ ok: true, drafted, names })
  } catch (err) {
    console.error('[internal.proactive-followups]', err)
    return NextResponse.json({ ok: true, drafted: 0, reason: 'error' })
  }
}
