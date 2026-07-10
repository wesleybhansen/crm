// ORM-SKIP: AI generation/analysis — complex prompt construction, not CRUD
export const metadata = { path: '/contacts/import/map', POST: { requireAuth: true } }
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { meterCustomersAi } from '@/lib/usage/meter'
import { checkCustomersAiAllowance } from '@/lib/usage/allowance'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

/* Migration assistant (T4): AI column mapping for spreadsheet imports.
 * The user uploads any CSV export (HubSpot, GHL, Sheets, whatever) — this maps
 * its columns onto the CRM's contact fields from the headers plus a few sample
 * rows, so nobody has to rename spreadsheet columns to import their business. */

// Only fields the import endpoint actually persists — claiming more (tags,
// notes, company) would silently drop the user's data after promising a map.
const TARGET_FIELDS = ['name', 'first_name', 'last_name', 'email', 'phone', 'source'] as const

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const gate = await checkCustomersAiAllowance(auth)
  if (!gate.allowed) {
    return NextResponse.json({ ok: false, error: gate.message }, { status: 402 })
  }

  try {
    const body = await req.json()
    const headers: unknown = body?.headers
    const sampleRows: unknown = body?.sampleRows

    if (!Array.isArray(headers) || headers.length === 0 || headers.length > 100) {
      return NextResponse.json({ ok: false, error: 'headers array required (max 100 columns)' }, { status: 400 })
    }
    const cleanHeaders = headers.map((h) => String(h ?? '').slice(0, 120))
    const cleanRows = (Array.isArray(sampleRows) ? sampleRows : [])
      .slice(0, 5)
      .map((row) => (Array.isArray(row) ? row.map((c) => String(c ?? '').slice(0, 120)) : []))

    const apiKey = gate.byoApiKey || process.env.GEMINI_API_KEY || process.env.AI_API_KEY
    if (!apiKey) {
      return NextResponse.json({ ok: false, error: 'AI not configured' }, { status: 500 })
    }

    const prompt = `You are mapping spreadsheet columns onto CRM contact fields for an import.

SPREADSHEET COLUMNS (0-indexed):
${cleanHeaders.map((h, i) => `${i}: "${h}"`).join('\n')}

SAMPLE ROWS:
${cleanRows.map((r) => r.map((c, i) => `[${i}]=${JSON.stringify(c)}`).join(' ')).join('\n') || '(none provided)'}

TARGET CRM FIELDS: ${TARGET_FIELDS.join(', ')}

Map each target field to the 0-indexed column that best contains it, or null when
no column fits. Rules:
- "name" is the full name; if the sheet splits names, use first_name/last_name
  instead and leave name null (never both).
- Prefer the sample-row CONTENT over the header wording when they disagree
  (e.g. a column headed "Contact" whose values are emails maps to email).
- Never map two target fields to the same column.
- "confidence" is 0-1 for the overall mapping quality.

Return ONLY valid JSON, no markdown:
{"mapping": {"name": <index|null>, "first_name": <index|null>, "last_name": <index|null>, "email": <index|null>, "phone": <index|null>, "source": <index|null>}, "confidence": 0.0}`

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 400, responseMimeType: 'application/json' },
        }),
      }
    )
    const data = await res.json()
    void meterCustomersAi(auth, {
      model: 'gemini-3.5-flash',
      tokensIn: data?.usageMetadata?.promptTokenCount || 0,
      tokensOut: data?.usageMetadata?.candidatesTokenCount || 0,
      feature: 'import-column-map',
      byoKey: !!gate.byoApiKey,
    })

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return NextResponse.json({ ok: false, error: 'AI could not map the columns' }, { status: 500 })
    }
    const parsed = JSON.parse(jsonMatch[0]) as { mapping?: Record<string, unknown>; confidence?: unknown }

    // Sanitize: only known fields, only valid in-range integer indexes, no
    // column claimed twice (first field wins in TARGET_FIELDS order).
    const mapping: Record<string, number | null> = {}
    const claimed = new Set<number>()
    for (const field of TARGET_FIELDS) {
      const v = parsed.mapping?.[field]
      const idx = Number.isInteger(v) ? (v as number) : null
      if (idx !== null && idx >= 0 && idx < cleanHeaders.length && !claimed.has(idx)) {
        mapping[field] = idx
        claimed.add(idx)
      } else {
        mapping[field] = null
      }
    }
    const c = Number(parsed.confidence)
    const confidence = Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0.5

    return NextResponse.json({ ok: true, data: { mapping, confidence } })
  } catch (error) {
    console.error('[contacts.import.map]', error)
    return NextResponse.json({ ok: false, error: 'Failed to map columns' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Contacts', summary: 'AI column mapping for imports',
  methods: { POST: { summary: 'Map spreadsheet columns onto CRM contact fields', tags: ['Contacts'] } },
}
