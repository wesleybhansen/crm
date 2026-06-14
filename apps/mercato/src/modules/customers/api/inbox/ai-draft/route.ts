// ORM-SKIP: complex multi-table logic or writes to non-existent columns
export const metadata = { path: '/inbox/ai-draft', POST: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { meterCustomersAi } from '@/lib/usage/meter'
import { checkCustomersAiAllowance } from '@/lib/usage/allowance'
import { generateReplyDraft } from '@/modules/customers/lib/draft-reply'

// POST: Generate an AI draft reply for a conversation
export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const gate = await checkCustomersAiAllowance(auth)
  if (!gate.allowed) return NextResponse.json({ ok: false, error: gate.message }, { status: 402 })

  const aiKey = gate.byoApiKey || process.env.GOOGLE_GENERATIVE_AI_API_KEY
  if (!aiKey) return NextResponse.json({ ok: false, error: 'AI not configured' }, { status: 400 })

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { conversationId, channel, recentMessages } = body

    if (!conversationId) return NextResponse.json({ ok: false, error: 'conversationId required' }, { status: 400 })

    // Load conversation context
    const conv = await knex('inbox_conversations').where('id', conversationId).where('organization_id', auth.orgId).first()
    if (!conv) return NextResponse.json({ ok: false, error: 'Conversation not found' }, { status: 404 })

    // Drafting prompt + provider call are shared with the Customer Service engine.
    const result = await generateReplyDraft(knex, aiKey, {
      orgId: auth.orgId,
      channel,
      recentMessages: recentMessages || [],
      contactId: conv.contact_id || null,
    })

    if (!result.ok || !result.draft) {
      return NextResponse.json({ ok: false, error: result.error || 'AI could not generate a draft' }, { status: 500 })
    }

    void meterCustomersAi(auth, {
      model: result.model,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      feature: 'inbox-ai-draft',
      byoKey: !!gate.byoApiKey,
    })

    return NextResponse.json({ ok: true, data: { draft: result.draft } })
  } catch (error) {
    console.error('[inbox.ai-draft]', error)
    return NextResponse.json({ ok: false, error: 'Failed to generate draft' }, { status: 500 })
  }
}
