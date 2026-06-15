// ORM-SKIP: raw CRUD over customer_service_knowledge (many rows per org)
//
// Bridges the Customer Service knowledge library to the user's Knowledge Base.
// GET lists the current user's KB documents (id + title only); POST imports a
// set of them as customer_service_knowledge 'document' rows. Reuses the proven
// CRM->KB auto-connect (ensureKbApiKey) + the KB /api/documents/export pattern
// from the courses module, so no KB connectivity is rebuilt here.
export const metadata = {
  path: '/customer-service/kb-documents',
  GET: { requireAuth: true, requireFeatures: ['email.view'] },
  POST: { requireAuth: true, requireFeatures: ['email.send'] },
}

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import crypto from 'crypto'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

const KB_BASE_URL = (process.env.NOLI_KB_BASE_URL ?? 'https://kb.noliai.com').replace(/\/$/, '')
// Mirrors the per-entry cap enforced by the knowledge POST handler.
const MAX_CONTENT_CHARS = 20000
// Marker prefix stored in source_filename so re-imports can be deduped and the
// origin of an entry stays recognizable in the list ("From kb:<id>").
const KB_SOURCE_PREFIX = 'kb:'

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

    // Which KB docs are already imported, so the UI can mark/skip them.
    const importedRows = await knex('customer_service_knowledge')
      .where('organization_id', auth.orgId)
      .where('is_active', true)
      .whereLike('source_filename', `${KB_SOURCE_PREFIX}%`)
      .select('source_filename')
    const importedIds = new Set(
      importedRows
        .map((r: any) => (typeof r.source_filename === 'string' ? r.source_filename.slice(KB_SOURCE_PREFIX.length) : ''))
        .filter(Boolean),
    )

    const docs = allDocs.map((d: any) => ({
      id: d.id,
      title: d.title || d.name || 'Untitled',
      alreadyImported: importedIds.has(d.id),
    }))
    return NextResponse.json({ ok: true, connected: true, data: docs })
  } catch (error) {
    console.error('[customer-service.kb-documents.get]', error)
    return NextResponse.json({ ok: false, error: 'Failed to load Knowledge Base documents' }, { status: 500 })
  }
}

// POST: import KB documents into the knowledge library. Input: { ids: string[] }.
// Each not-already-imported doc becomes a customer_service_knowledge 'document'
// row (title = KB title, content capped, source_filename = kb:<id> for dedupe).
export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
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

    // Pull full content for the requested ids (the ?ids= path returns content).
    let selected: { id: string; title: string; content: string }[]
    try {
      const allDocs = await fetchKbDocs(apiKey)
      const idSet = new Set(ids)
      selected = allDocs
        .filter((d: any) => idSet.has(d.id))
        .map((d: any) => ({
          id: d.id,
          title: d.title || d.name || 'Untitled',
          content: d.extracted_text || d.content || '',
        }))
    } catch {
      return NextResponse.json({ ok: false, connected: false, error: 'Could not read from your Knowledge Base. Try again in a moment.' }, { status: 502 })
    }

    // Dedupe against already-imported KB docs (by the kb:<id> marker).
    const existingRows = await knex('customer_service_knowledge')
      .where('organization_id', auth.orgId)
      .where('is_active', true)
      .whereIn('source_filename', ids.map((id) => `${KB_SOURCE_PREFIX}${id}`))
      .select('source_filename')
    const existing = new Set(
      existingRows
        .map((r: any) => (typeof r.source_filename === 'string' ? r.source_filename.slice(KB_SOURCE_PREFIX.length) : ''))
        .filter(Boolean),
    )

    let added = 0
    let skipped = 0
    const now = new Date()
    for (const doc of selected) {
      if (existing.has(doc.id)) { skipped++; continue }
      let content = (doc.content || '').toString().trim()
      if (!content) { skipped++; continue }
      if (content.length > MAX_CONTENT_CHARS) {
        content = content.substring(0, MAX_CONTENT_CHARS).trimEnd() + '\n\n[Truncated: this document was longer than the per-entry limit.]'
      }
      const title = (doc.title || 'Reference document').toString().trim().substring(0, 200) || 'Reference document'
      await knex('customer_service_knowledge').insert({
        id: crypto.randomUUID(),
        tenant_id: auth.tenantId,
        organization_id: auth.orgId,
        kind: 'document',
        title,
        content,
        source_filename: `${KB_SOURCE_PREFIX}${doc.id}`,
        is_active: true,
        created_at: now,
        updated_at: now,
      })
      added++
    }
    // Requested ids that KB returned no content / no match for.
    skipped += ids.filter((id) => !selected.some((s) => s.id === id) && !existing.has(id)).length

    return NextResponse.json({ ok: true, added, skipped })
  } catch (error) {
    console.error('[customer-service.kb-documents.post]', error)
    return NextResponse.json({ ok: false, error: 'Failed to import documents' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Customer Service',
  summary: 'Import Knowledge Base documents into the grounding library',
  methods: {
    GET: { summary: 'List the current user\'s Knowledge Base documents', tags: ['Customer Service'] },
    POST: { summary: 'Import selected Knowledge Base documents as reference documents', tags: ['Customer Service'] },
  },
}
