// ORM-SKIP: raw CRUD over customer_service_knowledge (many rows per org)
export const metadata = {
  path: '/customer-service/knowledge',
  GET: { requireAuth: true, requireFeatures: ['email.view'] },
  POST: { requireAuth: true, requireFeatures: ['email.send'] },
}

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import crypto from 'crypto'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

const VALID_KINDS = new Set(['model_answer', 'document'])
// Per-entry content cap. Keeps a single paste/upload from being unbounded; the
// drafter also caps the TOTAL injected length separately.
const MAX_CONTENT_CHARS = 20000
// Allowed text upload types. PDF/DOCX extraction is deferred (see note below).
const ALLOWED_UPLOAD_EXT = ['.txt', '.md', '.markdown', '.csv']

function previewOf(content: string): string {
  const flat = (content || '').replace(/\s+/g, ' ').trim()
  return flat.length > 200 ? `${flat.substring(0, 200)}...` : flat
}

function serializeListRow(row: any) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    sourceFilename: row.source_filename ?? null,
    contentPreview: previewOf(row.content || ''),
    createdAt: row.created_at,
  }
}

// GET: list the org's active grounding entries (no full content, just a preview).
export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const rows = await knex('customer_service_knowledge')
      .where('organization_id', auth.orgId)
      .where('is_active', true)
      .orderBy('updated_at', 'desc')
      .limit(200)
    return NextResponse.json({ ok: true, data: rows.map(serializeListRow) })
  } catch (error) {
    console.error('[customer-service.knowledge.get]', error)
    return NextResponse.json({ ok: false, error: 'Failed to load knowledge' }, { status: 500 })
  }
}

// POST: create a model answer (JSON) or a document (JSON paste OR multipart upload).
// Self-scoped by auth.orgId/tenantId; client org is ignored.
export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    let kind = 'model_answer'
    let title = ''
    let content = ''
    let sourceFilename: string | null = null

    const contentType = req.headers.get('content-type') || ''

    if (contentType.includes('multipart/form-data')) {
      // Document upload path. Extract text server-side for .txt/.md/.csv only.
      const form = await req.formData()
      kind = (form.get('kind') as string) || 'document'
      title = ((form.get('title') as string) || '').trim()
      const file = form.get('file') as File | null
      const pasted = ((form.get('content') as string) || '').trim()

      if (file && typeof file.arrayBuffer === 'function') {
        const name = file.name || 'upload.txt'
        const lower = name.toLowerCase()
        const ext = lower.slice(lower.lastIndexOf('.'))
        if (!ALLOWED_UPLOAD_EXT.includes(ext)) {
          return NextResponse.json({
            ok: false,
            error: 'Only .txt, .md, and .csv files are supported. For PDF or Word, paste the text instead.',
          }, { status: 400 })
        }
        const buf = Buffer.from(await file.arrayBuffer())
        content = buf.toString('utf8')
        sourceFilename = name
        if (!title) title = name
      } else if (pasted) {
        content = pasted
      }
    } else {
      const body = await req.json().catch(() => ({}))
      kind = typeof body.kind === 'string' ? body.kind : 'model_answer'
      title = (body.title || '').toString().trim()
      content = (body.content || '').toString()
      sourceFilename = body.sourceFilename ? body.sourceFilename.toString() : null
    }

    if (!VALID_KINDS.has(kind)) {
      return NextResponse.json({ ok: false, error: 'Invalid kind' }, { status: 400 })
    }
    content = (content || '').trim()
    if (!content) {
      return NextResponse.json({ ok: false, error: 'Content is required' }, { status: 400 })
    }
    if (content.length > MAX_CONTENT_CHARS) content = content.substring(0, MAX_CONTENT_CHARS)
    if (!title) title = kind === 'model_answer' ? 'Model answer' : 'Reference document'
    title = title.substring(0, 200)

    const now = new Date()
    const id = crypto.randomUUID()
    await knex('customer_service_knowledge').insert({
      id,
      tenant_id: auth.tenantId,
      organization_id: auth.orgId,
      kind,
      title,
      content,
      source_filename: sourceFilename,
      is_active: true,
      created_at: now,
      updated_at: now,
    })

    const row = await knex('customer_service_knowledge').where('id', id).first()
    return NextResponse.json({ ok: true, data: serializeListRow(row) })
  } catch (error) {
    console.error('[customer-service.knowledge.post]', error)
    return NextResponse.json({ ok: false, error: 'Failed to save entry' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Customer Service',
  summary: 'Customer Service grounding library',
  methods: {
    GET: { summary: 'List active grounding entries for the current org', tags: ['Customer Service'] },
    POST: { summary: 'Add a model answer or reference document', tags: ['Customer Service'] },
  },
}
