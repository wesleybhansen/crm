import { z } from 'zod'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerMcpTool } from './tool-registry'
import type { McpToolDefinition } from './types'

/**
 * Locate AGENT_GUIDE.md at runtime. We try a few well-known spots so the
 * tool keeps working whether the server is run from source, the standalone
 * Next build, or the docker image (where the guide lives at /app/AGENT_GUIDE.md).
 */
function findGuidePath(): string | null {
  const candidates: string[] = []
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    // From compiled dist dir: packages/ai-assistant/dist/modules/ai_assistant/lib/agent-guide-tool.js
    candidates.push(resolve(here, '..', '..', '..', '..', '..', '..', 'AGENT_GUIDE.md'))
    candidates.push(resolve(here, '..', '..', '..', '..', '..', 'AGENT_GUIDE.md'))
  } catch { /* __dirname unavailable */ }
  // Process-relative fallbacks
  candidates.push(join(process.cwd(), 'AGENT_GUIDE.md'))
  candidates.push(join(process.cwd(), '..', '..', 'AGENT_GUIDE.md'))
  // Docker image
  candidates.push('/app/AGENT_GUIDE.md')
  for (const c of candidates) {
    try {
      readFileSync(c, 'utf-8')
      return c
    } catch { /* try next */ }
  }
  return null
}

const FALLBACK = `# LaunchCRM Agent Integration Guide

(The checked-in AGENT_GUIDE.md file was not found at runtime. The agent
should fetch the guide at: https://raw.githubusercontent.com/wesleybhansen/crm/main/AGENT_GUIDE.md)

Quick reference:
- **REST:** https://crm.thelaunchpadincubator.com/api — pass \`x-api-key\` header
- **MCP:** https://crm.thelaunchpadincubator.com/mcp — pass \`x-api-key\` + \`_sessionToken\` per tool call
- **Session token:** \`POST /api/ai_assistant/session-key\` with \`x-api-key\` → \`{ sessionToken, expiresAt }\`
- **OpenAPI spec:** \`GET /api/docs/openapi\` or MCP tool \`find_api\`
- **Webhooks:** \`POST /api/webhooks/subscriptions\` → HMAC-SHA256 signed POSTs on events
- **Rate-limit headers:** \`RateLimit-Limit\`, \`RateLimit-Remaining\`, \`RateLimit-Reset\`, \`Retry-After\` on 429
`

export const agentGuideTool: McpToolDefinition = {
  name: 'get_agent_guide',
  description:
    'Return the LaunchCRM agent integration guide — the single reference for how to authenticate, call the REST API, use MCP tools, subscribe to webhooks, and handle rate limits / scopes / tenant encryption. Call this first if you are a new agent talking to this CRM for the first time. The guide is plain markdown; you can render it or parse sections.',
  inputSchema: z.object({
    section: z
      .string()
      .optional()
      .describe(
        'Optional. Filter to a single H2 section by case-insensitive substring (e.g. "webhooks", "mcp quickstart", "common recipes"). Omit to get the full guide.',
      ),
  }),
  requiredFeatures: [], // Available to every authenticated agent
  handler: async ({ section }: { section?: string }) => {
    const guidePath = findGuidePath()
    const raw = guidePath ? readFileSync(guidePath, 'utf-8') : FALLBACK

    if (!section) {
      return { markdown: raw, source: guidePath ?? 'fallback-inline', bytes: raw.length }
    }

    // Return only the matching H2 (## ...) section and its body.
    const needle = section.trim().toLowerCase()
    const lines = raw.split('\n')
    let captureStart = -1
    let captureEnd = lines.length
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.startsWith('## ')) {
        const heading = line.slice(3).toLowerCase()
        if (captureStart === -1 && heading.includes(needle)) {
          captureStart = i
        } else if (captureStart !== -1 && i > captureStart) {
          captureEnd = i
          break
        }
      }
    }
    if (captureStart === -1) {
      return {
        markdown: `No section matching "${section}" found. Call get_agent_guide with no arguments to see the full guide.`,
        source: guidePath ?? 'fallback-inline',
        matched: false,
      }
    }
    const extract = lines.slice(captureStart, captureEnd).join('\n')
    return { markdown: extract, source: guidePath ?? 'fallback-inline', matched: true }
  },
}

export function registerAgentGuideTool(): void {
  registerMcpTool(agentGuideTool, { moduleId: 'ai_assistant' })
}

/**
 * Short bootstrap instructions injected into the MCP `initialize` response
 * (under the `instructions` field). Compliant clients — Claude Desktop,
 * Cursor, OpenCode — fold this into the agent's system prompt automatically,
 * so every agent sees it on first connection without having to call any
 * tool. Keep it terse: the full guide is behind `get_agent_guide`.
 */
export const MCP_BOOTSTRAP_INSTRUCTIONS = `You are connected to LaunchCRM's MCP server.

Every tool call must include \`_sessionToken\` in its arguments (omit only for read-only tools that explicitly allow it). If a call returns UNAUTHORIZED with code SESSION_EXPIRED, mint a new token: POST https://crm.thelaunchpadincubator.com/api/ai_assistant/session-key with the same x-api-key header.

Workflow for unfamiliar operations:
1. \`discover_schema\` — find which entities exist (e.g. "Company", "Deal")
2. \`find_api\` — find the right endpoint (e.g. "update company")
3. \`call_api\` — execute it. All values in \`query\` must be strings; \`body\` is an object.

For the full integration contract — auth, REST endpoints, webhooks, rate limits (60/min default tier, respect Retry-After on 429), scopes, tenant encryption, BC guarantees, common recipes — call \`get_agent_guide\` (pass \`section: "webhooks"\` etc. to filter by H2 heading). Call it once at the start of a new session; the answer is stable.

Multi-tenant: every tool runs under the caller's tenantId + organizationId. Data from other tenants is invisible to you. Respect this when explaining results.`
