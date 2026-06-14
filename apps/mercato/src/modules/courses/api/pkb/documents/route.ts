import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

const PKB_URL = process.env.NOLI_KB_BASE_URL ?? 'https://kb.noliai.com'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['courses.manage'] },
}

export async function GET(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Auto-connect: use the cached/pasted key if present, else mint one from KB.
    const { ensureKbApiKey } = await import('@/modules/courses/lib/kb-connect')
    const apiKey = await ensureKbApiKey(
      knex,
      auth.orgId as string,
      (auth.noliUserId as string | undefined) ?? null,
      (auth.tenantId as string | undefined) ?? null,
    )

    if (!apiKey) {
      return NextResponse.json({ ok: false, error: 'Could not connect to your Knowledge Base. Try again in a moment.' }, { status: 502 })
    }

    const url = new URL(req.url)
    const ids = url.searchParams.get('ids') // comma-separated IDs for full content fetch

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)

    // Fetch documents from PKB API
    const res = await fetch(`${PKB_URL}/api/documents/export`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!res.ok) {
      return NextResponse.json({ ok: false, error: 'Failed to fetch from PKB' }, { status: 500 })
    }

    const rawData = await res.json()
    const allDocs = Array.isArray(rawData) ? rawData : (rawData.data || [])

    if (ids) {
      // Return full content for specific documents
      const idList = ids.split(',').map(s => s.trim())
      const selected = allDocs
        .filter((d: any) => idList.includes(d.id))
        .map((d: any) => ({
          id: d.id,
          title: d.title || d.name || 'Untitled',
          content: d.extracted_text || d.content || '',
        }))
      return NextResponse.json({ ok: true, data: selected })
    }

    // Return lightweight list (no content/extracted_text)
    const docs = allDocs.map((d: any) => ({
      id: d.id,
      title: d.title || d.name || 'Untitled',
      tags: d.tags || [],
      fileType: d.file_type || null,
      status: d.status || 'processed',
      createdAt: d.created_at,
    }))

    return NextResponse.json({ ok: true, data: docs })
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      return NextResponse.json({ ok: false, error: 'Request timed out' }, { status: 408 })
    }
    console.error('[pkb.documents]', error)
    return NextResponse.json({ ok: false, error: 'Failed to fetch documents' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Courses', summary: 'PKB document access',
  methods: { GET: { summary: 'List or fetch PKB documents via API', tags: ['Courses'] } },
}
