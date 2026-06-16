// ORM-SKIP: read-only bridge to the user's Knowledge Base (no CRM table writes)
//
// Bridges the Inbox AI reply assistant to the user's Knowledge Base. GET lists
// the current user's KB documents (id + title only) for the picker; POST returns
// the full text of the selected documents so the client can fold it into the
// assistant's knowledge base text (saved via /api/inbox/ai-settings). This
// mirrors the Customer Service kb-documents picker and reuses the same proven
// CRM->KB auto-connect (ensureKbApiKey) + the KB /api/documents/export pattern,
// so no KB connectivity is rebuilt here. Unlike the Customer Service route it
// does NOT write any rows: the Inbox assistant keeps its knowledge as one text
// field, so we only read content and hand it back to the client.
export const metadata = {
  path: '/inbox/kb-documents',
  GET: { requireAuth: true, requireFeatures: ['email.view'] },
  POST: { requireAuth: true, requireFeatures: ['email.send'] },
}

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

const KB_BASE_URL = (process.env.NOLI_KB_BASE_URL ?? 'https://kb.noliai.com').replace(/\/$/, '')
// Mirrors the per-entry cap the Customer Service knowledge POST handler uses.
const MAX_CONTENT_CHARS = 20000

// Resolve a working KB API key for the current user, or null if KB can't be
// reached / the user can't be identified.
async function resolveKbKey(
  knex: ReturnType<EntityManager['getKnex']>,
  orgId: string,
  noliUserId: string | null | undefined,
  tenantId: string | null | undefined,
): Promise<string | null> {
  const { ensureKbApiKey } = await import('@/modules/courses/lib/kb-connect')
  return ensureKbApiKey(knex, orgId, noliUserId ?? null, tenantId ?? null)
}

// Fetch the KB document export. Returns the raw array of docs or throws.
async function fetchKbDocs(apiKey: string): Promise<any[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)
  try {
    const res = await fetch(`${KB_BASE_URL}/api/documents/export`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`kb_export_${res.status}`)
    const rawData = await res.json()
    return Array.isArray(rawData) ? rawData : (rawData.data || [])
  } finally {
    clearTimeout(timeout)
  }
}

// GET: list the current user's KB documents (id + title), for the picker.
// Returns { connected: false } when KB can't be reached so the UI can show a
// graceful state instead of a hard error.
export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const apiKey = await resolveKbKey(
      knex,
      auth.orgId as string,
      auth.noliUserId as string | undefined,
      auth.tenantId as string | undefined,
    )
    if (!apiKey) {
      return NextResponse.json({ ok: true, connected: false, data: [] })
    }

    let allDocs: any[]
    try {
      allDocs = await fetchKbDocs(apiKey)
    } catch {
      return NextResponse.json({ ok: true, connected: false, data: [] })
    }

    const docs = allDocs.map((d: any) => ({
      id: d.id,
      title: d.title || d.name || 'Untitled',
    }))
    return NextResponse.json({ ok: true, connected: true, data: docs })
  } catch (error) {
    console.error('[inbox.kb-documents.get]', error)
    return NextResponse.json({ ok: false, error: 'Failed to load Knowledge Base documents' }, { status: 500 })
  }
}

// POST: return the full text of the selected KB documents. Input: { ids: string[] }.
// The client appends the returned text to the assistant's knowledge base field
// and saves it via /api/inbox/ai-settings. No rows are written here.
export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const body = await req.json().catch(() => ({}))
    const ids = Array.isArray(body?.ids)
      ? (body.ids as unknown[]).map((x) => String(x).trim()).filter(Boolean)
      : []
    if (ids.length === 0) {
      return NextResponse.json({ ok: false, error: 'Select at least one document.' }, { status: 400 })
    }

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const apiKey = await resolveKbKey(
      knex,
      auth.orgId as string,
      auth.noliUserId as string | undefined,
      auth.tenantId as string | undefined,
    )
    if (!apiKey) {
      return NextResponse.json({ ok: false, connected: false, error: 'Could not connect to your Knowledge Base. Try again in a moment.' }, { status: 502 })
    }

    let selected: { id: string; title: string; content: string }[]
    try {
      const allDocs = await fetchKbDocs(apiKey)
      const idSet = new Set(ids)
      selected = allDocs
        .filter((d: any) => idSet.has(d.id))
        .map((d: any) => {
          let content = (d.extracted_text || d.content || '').toString().trim()
          if (content.length > MAX_CONTENT_CHARS) {
            content = content.substring(0, MAX_CONTENT_CHARS).trimEnd() + '\n\n[Truncated: this document was longer than the per-entry limit.]'
          }
          return {
            id: d.id,
            title: (d.title || d.name || 'Reference document').toString().trim().substring(0, 200) || 'Reference document',
            content,
          }
        })
        .filter((d) => d.content)
    } catch {
      return NextResponse.json({ ok: false, connected: false, error: 'Could not read from your Knowledge Base. Try again in a moment.' }, { status: 502 })
    }

    const skipped = ids.length - selected.length
    return NextResponse.json({ ok: true, data: selected, added: selected.length, skipped })
  } catch (error) {
    console.error('[inbox.kb-documents.post]', error)
    return NextResponse.json({ ok: false, error: 'Failed to read documents' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Inbox',
  summary: 'Browse Knowledge Base documents for the Inbox AI reply assistant',
  methods: {
    GET: { summary: 'List the current user\'s Knowledge Base documents', tags: ['Inbox'] },
    POST: { summary: 'Return the text of selected Knowledge Base documents', tags: ['Inbox'] },
  },
}
