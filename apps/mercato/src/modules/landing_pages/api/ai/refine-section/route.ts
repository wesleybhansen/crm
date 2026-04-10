export const metadata = { POST: { requireAuth: true } }
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { callAI, parseAIJsonResponse } from '@/lib/landing-page-wizard/ai-client'
import type {
  GeneratedSection,
  BusinessContext,
} from '@/lib/landing-page-wizard/types'

interface RefineSectionRequestBody {
  section: GeneratedSection
  instruction: string
  businessContext: BusinessContext
}

export async function POST(req: Request) {
  try {
    const auth = await getAuthFromCookies()
    if (!auth) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    }

    const body: RefineSectionRequestBody = await req.json()
    const { section, instruction, businessContext } = body

    if (!section || !instruction || !businessContext) {
      return NextResponse.json(
        { ok: false, error: 'section, instruction, and businessContext are required' },
        { status: 400 }
      )
    }

    const toneLabel = businessContext.tone === 'custom' && businessContext.customTone
      ? businessContext.customTone
      : businessContext.tone

    const systemPrompt = `You are refining a single section of a landing page. The business is ${businessContext.businessName} targeting ${businessContext.targetAudience}. The tone should be ${toneLabel}.`

    const userPrompt = `Here is the current section:

${JSON.stringify(section, null, 2)}

The user wants you to: ${instruction}

Return the updated section as JSON with the same field structure. Only change what the instruction asks for. Keep the "type" field unchanged. No markdown, no explanation, just valid JSON.`

    const raw = await callAI(systemPrompt, userPrompt, { jsonMode: true, maxTokens: 4096 })
    const refined = parseAIJsonResponse<GeneratedSection>(raw)

    // Preserve the section type
    refined.type = section.type

    return NextResponse.json({
      ok: true,
      data: { section: refined },
    })
  } catch (error) {
    console.error('[landing-page-ai.refine-section]', error)
    const message = error instanceof Error ? error.message : 'Section refinement failed'
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Landing Pages',
  summary: 'AI section refinement',
  methods: {
    POST: {
      summary: 'Refine a single landing page section with AI',
      tags: ['Landing Pages'],
    },
  },
}
