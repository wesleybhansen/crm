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
// Plain-text upload types. Read as UTF-8 directly.
const TEXT_UPLOAD_EXT = ['.txt', '.md', '.markdown', '.csv']

// Extract text from an uploaded document buffer based on filename/mime.
// Returns the raw extracted text. Throws on unsupported type or parse failure;
// the caller maps those to clear 400s.
async function extractDocumentText(buf: Buffer, name: string, mime: string): Promise<string> {
  const lower = (name || '').toLowerCase()
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.')) : ''
  const isPdf = mime === 'application/pdf' || ext === '.pdf'
  const isDocx =
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === '.docx'

  if (isPdf) {
    // Import the inner module directly so pdf-parse does not run its
    // debug-mode test-file read on package-root import.
    const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js')
    const parsed = await pdfParse(buf)
    return parsed.text || ''
  }
  if (isDocx) {
    const mammoth = await import('mammoth')
    const result = await mammoth.extractRawText({ buffer: buf })
    return result.value || ''
  }
  if (TEXT_UPLOAD_EXT.includes(ext) || (mime || '').startsWith('text/')) {
    return buf.toString('utf8')
  }
  // Legacy .doc and everything else.
  const err = new Error('unsupported_type') as Error & { code?: string }
  err.code = 'unsupported_type'
  throw err
}

function previewOf(content: string): string {
  const flat = (content || '').replace(/\s+/g, ' ').trim()
  return flat.length > 200 ? `${flat.substring(0, 200)}...` : flat
}

function serializeListRow(row: any) {
  // KB-imported docs store their origin as "kb:<id>" in source_filename for
  // dedupe. Surface a friendly label instead of the raw marker.
  const raw = row.source_filename ?? null
  const sourceFilename = typeof raw === 'string' && raw.startsWith('kb:') ? 'Knowledge Base' : raw
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    sourceFilename,
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
      // Document upload path. Extracts text server-side for PDF, DOCX, and plain text.
      const form = await req.formData()
      kind = (form.get('kind') as string) || 'document'
      title = ((form.get('title') as string) || '').trim()
      const file = form.get('file') as File | null
      const pasted = ((form.get('content') as string) || '').trim()

      if (file && typeof file.arrayBuffer === 'function') {
        const name = file.name || 'upload.txt'
        const mime = (file.type || '').toLowerCase()
        const lower = name.toLowerCase()
        const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.')) : ''
        const isKnownType =
          mime === 'application/pdf' || ext === '.pdf' ||
          mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || ext === '.docx' ||
          TEXT_UPLOAD_EXT.includes(ext) || mime.startsWith('text/')
        if (!isKnownType) {
          return NextResponse.json({
            ok: false,
            error: 'Unsupported file type. Upload a PDF, Word (.docx), or text (.txt, .md, .csv) file, or paste the text instead.',
          }, { status: 400 })
        }
        const buf = Buffer.from(await file.arrayBuffer())
        try {
          content = await extractDocumentText(buf, name, mime)
        } catch (extractErr) {
          console.error('[customer-service.knowledge.extract]', extractErr)
          return NextResponse.json({
            ok: false,
            error: 'Could not read that file, try pasting the text instead.',
          }, { status: 400 })
        }
        content = (content || '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
        if (!content) {
          return NextResponse.json({
            ok: false,
            error: 'No readable text found in that file, try pasting the text instead.',
          }, { status: 400 })
        }
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
    if (content.length > MAX_CONTENT_CHARS) {
      content = content.substring(0, MAX_CONTENT_CHARS).trimEnd() + '\n\n[Truncated: this document was longer than the per-entry limit.]'
    }
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
