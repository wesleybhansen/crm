import { NextResponse } from 'next/server'
import { AIPageBuilder } from '../../../services/ai-page-builder'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { meterCustomersAi } from '@/lib/usage/meter'
import { checkCustomersAiAllowance } from '@/lib/usage/allowance'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['landing_pages.create'] },
}

export async function POST(req: Request) {
  try {
    const auth = await getAuthFromCookies()
    if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

    // AIPageBuilder runs the AI_PROVIDER provider (Gemini by default). Gate on
    // google; over the pool, thread the org's google BYO key into the builder.
    const gate = await checkCustomersAiAllowance(auth, 'google')
    if (!gate.allowed) {
      return NextResponse.json({ ok: false, error: gate.message }, { status: 402 })
    }

    const body = await req.json()
    const { messages } = body

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json({ ok: false, error: 'messages array required' }, { status: 400 })
    }

    const builder = new AIPageBuilder(gate.byoApiKey)
    const response = await builder.chat(messages)

    void meterCustomersAi(auth, {
      model: builder.getModel(),
      tokensIn: builder.lastUsage.tokensIn,
      tokensOut: builder.lastUsage.tokensOut,
      feature: 'lp-chat',
      byoKey: builder.byoKey,
    })

    const isReady = response.includes('---READY---')

    return NextResponse.json({
      ok: true,
      message: response.replace('---READY---', '').trim(),
      ready: isReady,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[landing_pages.ai.chat]', msg, error)
    return NextResponse.json({ ok: false, error: `AI chat failed: ${msg}` }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Landing Pages', summary: 'AI chat for page building',
  methods: { POST: { summary: 'Chat with AI to gather page context', tags: ['Landing Pages'] } },
}
