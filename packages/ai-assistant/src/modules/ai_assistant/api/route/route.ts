import { NextResponse, type NextRequest } from 'next/server'
import { generateObject } from '../../lib/ai-sdk'
import {
  createOpenAI,
  createAnthropic,
  createGoogleGenerativeAI,
} from '../../lib/ai-sdk'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import {
  resolveFirstConfiguredOpenCodeProvider,
  resolveOpenCodeModel,
  resolveOpenCodeProviderApiKey,
} from '@open-mercato/shared/lib/ai/opencode-provider'
import {
  resolveChatConfig,
  isProviderConfigured,
  type ChatProviderId,
} from '../../lib/chat-config'
import { Organization } from '@open-mercato/core/modules/directory/data/entities'
import { logCrmAiUsage } from '@open-mercato/shared/lib/noli/ai-usage'
import { checkOrgAiAllowance } from '@open-mercato/shared/lib/noli/allowance'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['ai_assistant.view'] },
}

const RouteResultSchema = z.object({
  intent: z.enum(['tool', 'general_chat']),
  toolName: z.string().optional(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
})

function createRoutingModel(providerId: ChatProviderId, configuredModel?: string, apiKeyOverride?: string | null) {
  const { modelId, modelWithProvider } = resolveOpenCodeModel(providerId, {
    overrideModel: configuredModel,
  })
  const apiKey = apiKeyOverride || resolveOpenCodeProviderApiKey(providerId)
  if (!apiKey) {
    throw new Error(`${providerId.toUpperCase()} API key not configured`)
  }

  switch (providerId) {
    case 'openai': {
      const openai = createOpenAI({ apiKey })
      return {
        model: openai(modelId) as unknown as Parameters<typeof generateObject>[0]['model'],
        modelWithProvider,
      }
    }
    case 'anthropic': {
      const anthropic = createAnthropic({ apiKey })
      return {
        model: anthropic(modelId) as unknown as Parameters<typeof generateObject>[0]['model'],
        modelWithProvider,
      }
    }
    case 'google': {
      const google = createGoogleGenerativeAI({ apiKey })
      return {
        model: google(modelId) as unknown as Parameters<typeof generateObject>[0]['model'],
        modelWithProvider,
      }
    }
    case 'xai': {
      // xAI/Grok is OpenAI-compatible — OpenAI factory pointed at xAI's base URL.
      const xai = createOpenAI({ apiKey, baseURL: 'https://api.x.ai/v1' })
      return {
        model: xai(modelId) as unknown as Parameters<typeof generateObject>[0]['model'],
        modelWithProvider,
      }
    }
    default:
      throw new Error(`Unknown provider: ${providerId}`)
  }
}

export async function POST(req: NextRequest) {
  const auth = await getAuthFromRequest(req)

  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const { query, availableTools } = body as {
      query: string
      availableTools: Array<{ name: string; description: string }>
    }

    console.log('[AI Route] Routing query:', query)
    console.log('[AI Route] Available tools count:', availableTools?.length)

    if (!query || typeof query !== 'string') {
      return NextResponse.json({ error: 'query is required' }, { status: 400 })
    }

    if (!availableTools || !Array.isArray(availableTools)) {
      return NextResponse.json({ error: 'availableTools array is required' }, { status: 400 })
    }

    // Get user's configured provider
    const container = await createRequestContainer()
    let config = await resolveChatConfig(container)

    // Fallback to first configured provider
    if (!config) {
      const configuredProvider = resolveFirstConfiguredOpenCodeProvider()
      if (!configuredProvider) {
        return NextResponse.json(
          { error: 'No AI provider configured. Please set an API key for OpenAI, Anthropic, or Google.' },
          { status: 503 }
        )
      }
      config = { providerId: configuredProvider, model: '', updatedAt: '' }
    }

    console.log('[AI Route] Using provider:', config.providerId)

    // Verify the configured provider is still available
    if (!isProviderConfigured(config.providerId)) {
      return NextResponse.json(
        { error: `Configured provider ${config.providerId} is no longer available. Please update settings.` },
        { status: 503 }
      )
    }

    // P-3 allowance gate + unified BYOK fall-through (GAP-4). Resolve the noli
    // org, check the pooled allowance for the configured provider; over the pool
    // with no BYO key → 402; with a BYO key → route on it and meter byoKey: true.
    const meterEm = (container.resolve('em') as { fork: () => { findOne: (e: unknown, w: unknown) => Promise<{ noliOrgId?: string | null } | null> } }).fork()
    const meterOrg = auth.orgId ? await meterEm.findOne(Organization, { id: auth.orgId }) : null
    const gate = await checkOrgAiAllowance(meterOrg?.noliOrgId, config.providerId)
    if (!gate.allowed) {
      return NextResponse.json(
        { error: "You've used your team's monthly AI allowance. Add your own provider API key or upgrade your plan to keep using AI." },
        { status: 402 },
      )
    }

    // Use fast model for the configured provider
    const { model, modelWithProvider } = createRoutingModel(config.providerId, config.model, gate.byoApiKey)

    const toolList = availableTools
      .map((t) => `- ${t.name}: ${t.description}`)
      .join('\n')

    console.log('[AI Route] Calling generateObject with', modelWithProvider)

    const result = await generateObject({
      model,
      schema: RouteResultSchema,
      prompt: `You are a routing assistant. Given a user query, determine if they want to use a specific tool or have a general conversation.

Available tools:
${toolList}

User query: "${query}"

Respond with:
- intent: "tool" if user wants to perform an action with a specific tool, "general_chat" otherwise
- toolName: the exact tool name if intent is "tool"
- confidence: 0-1 how confident you are
- reasoning: brief explanation`,
    })

    console.log('[AI Route] Result:', result.object)

    // Cross-product usage metering (fire-and-forget; never blocks the response).
    try {
      if (meterOrg?.noliOrgId) {
        const bareModel = modelWithProvider.includes('/') ? modelWithProvider.split('/').pop()! : modelWithProvider
        void logCrmAiUsage({
          noliOrgId: meterOrg.noliOrgId,
          model: bareModel,
          tokensIn: Number(result.usage?.inputTokens ?? 0) || 0,
          tokensOut: Number(result.usage?.outputTokens ?? 0) || 0,
          feature: 'assistant-routing',
          byoKey: !!gate.byoApiKey,
        }).catch(() => {})
      }
    } catch {
      /* ignore — metering is best-effort */
    }

    return NextResponse.json(result.object)
  } catch (error) {
    console.error('[AI Route] Error routing query:', error)
    return NextResponse.json(
      { error: 'Routing request failed' },
      { status: 500 }
    )
  }
}
