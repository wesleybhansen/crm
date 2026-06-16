// ORM-SKIP: raw CRUD over inbox_knowledge (many rows per org)
export const metadata = {
  path: '/inbox/knowledge',
  GET: { requireAuth: true },
  POST: { requireAuth: true },
  DELETE: { requireAuth: true },
}

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import * as cheerio from 'cheerio'
import crypto from 'crypto'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { safeFetch, SsrfError } from '@/lib/safe-fetch'

// Grounding library for the personal Inbox AI desk. Mirrors customer_service_knowledge
// but scoped to the personal Inbox. SETTINGS + STORAGE phase only: nothing reads
// these rows to draft replies yet (that engine is a later phase).
const VALID_KINDS = new Set(['model_answer', 'document', 'web_page'])
// Per-entry content cap. Keeps a single paste/upload/page from being unbounded.
const MAX_CONTENT_CHARS = 20000
// Plain-text upload types. Read as UTF-8 directly.
const TEXT_UPLOAD_EXT = ['.txt', '.md', '.markdown', '.csv']
const FETCH_TIMEOUT_MS = 15000
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024 // 5MB ceiling on downloaded HTML.
const USER_AGENT = 'Mozilla/5.0 (compatible; NoliCRM/1.0; +https://noliai.com) inbox-grounding'

// Extract text from an uploaded document buffer based on filename/mime. Throws on
// unsupported type or parse failure; the caller maps those to clear 400s.
async function extractDocumentText(buf: Buffer, name: string, mime: string): Promise<string> {
  const lower = (name || '').toLowerCase()
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.')) : ''
  const isPdf = mime === 'application/pdf' || ext === '.pdf'
  const isDocx =
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === '.docx'

  if (isPdf) {
    // Import the inner module directly so pdf-parse does not run its debug-mode
    // test-file read on package-root import. The package ships no types.
    // @ts-expect-error no declaration file for the inner pdf-parse module
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
  const err = new Error('unsupported_type') as Error & { code?: string }
  err.code = 'unsupported_type'
  throw err
}

function previewOf(content: string): string {
  const flat = (content || '').replace(/\s+/g, ' ').trim()
  return flat.length > 200 ? `${flat.substring(0, 200)}...` : flat
}

function serializeListRow(row: any) {
  let webLabel: string | null = null
  if (row.kind === 'web_page' && typeof row.source_url === 'string' && row.source_url) {
    webLabel = row.source_url
    try {
      const u = new URL(row.source_url)
      webLabel = u.hostname.replace(/^www\./, '') + (u.pathname !== '/' ? u.pathname : '')
    } catch {}
  }
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    sourceUrl: row.source_url ?? null,
    sourceLabel: webLabel,
    isWebSource: row.kind === 'web_page',
    contentPreview: previewOf(row.content || ''),
    createdAt: row.created_at,
  }
}

// Pull readable text from an HTML string: strip noise, prefer main/article, and
// collapse whitespace. Returns the page <title> as a fallback name.
function extractReadableText(html: string): { title: string; text: string } {
  const $ = cheerio.load(html)
  const title = ($('title').first().text() || '').replace(/\s+/g, ' ').trim()
  $('script, style, noscript, nav, footer, header, aside, form, svg, iframe, template').remove()
  const root = $('main').length ? $('main') : $('article').length ? $('article') : $('body')
  const rawText = (root.text() || $.root().text() || '')
  const text = rawText
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { title, text }
}

// GET: list the org's active grounding entries (preview only, no full content).
export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const rows = await knex('inbox_knowledge')
      .where('organization_id', auth.orgId)
      .where('is_active', true)
      .orderBy('updated_at', 'desc')
      .limit(200)
    return NextResponse.json({ ok: true, data: rows.map(serializeListRow) })
  } catch (error) {
    console.error('[inbox.knowledge.get]', error)
    return NextResponse.json({ ok: false, error: 'Failed to load knowledge' }, { status: 500 })
  }
}

// POST: add a model_answer (JSON), a document (JSON paste OR multipart upload),
// or a web_page (JSON { kind: 'web_page', url, title? } — fetched SSRF-safely and
// stored as extracted text). Self-scoped by auth.orgId/tenantId; client org is
// ignored.
export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    let kind = 'model_answer'
    let title = ''
    let content = ''
    let sourceUrl: string | null = null

    const contentType = req.headers.get('content-type') || ''

    if (contentType.includes('multipart/form-data')) {
      // Uploaded reference document. Extract text server-side for PDF/DOCX/text.
      const form = await req.formData()
      kind = 'document'
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
          console.error('[inbox.knowledge.extract]', extractErr)
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
        if (!title) title = name
      } else if (pasted) {
        content = pasted
      }
    } else {
      const body = await req.json().catch(() => ({}))
      kind = typeof body.kind === 'string' ? body.kind : 'model_answer'
      title = (body.title || '').toString().trim()

      if (kind === 'web_page') {
        // Fetch + extract a web page (FAQ / website URL). Reuse safeFetch so the
        // initial host AND every redirect hop are re-resolved and checked against
        // private/loopback/link-local/CGNAT ranges before any request goes out.
        const rawUrl = (body.url || '').toString().trim()
        if (!rawUrl) {
          return NextResponse.json({ ok: false, error: 'Enter a web page URL.' }, { status: 400 })
        }
        let parsedUrl: URL
        try {
          parsedUrl = new URL(rawUrl)
        } catch {
          return NextResponse.json({ ok: false, error: 'Enter a valid URL that starts with http:// or https://.' }, { status: 400 })
        }
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          return NextResponse.json({ ok: false, error: 'Only http and https URLs are supported.' }, { status: 400 })
        }

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
        let res: Response
        try {
          res = await safeFetch(parsedUrl.toString(), {
            method: 'GET',
            signal: controller.signal,
            headers: {
              'User-Agent': USER_AGENT,
              Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
            },
          }, 3)
        } catch (fetchErr) {
          clearTimeout(timer)
          const aborted = fetchErr instanceof Error && fetchErr.name === 'AbortError'
          if (fetchErr instanceof SsrfError) {
            return NextResponse.json({ ok: false, error: 'That address is not allowed.' }, { status: 400 })
          }
          return NextResponse.json({
            ok: false,
            error: aborted
              ? 'That page took too long to load. Try again or use a different URL.'
              : 'Could not load that page. Check the URL and try again.',
          }, { status: 400 })
        }
        clearTimeout(timer)

        if (!res.ok) {
          return NextResponse.json({ ok: false, error: `That page returned an error (${res.status}). Check the URL and try again.` }, { status: 400 })
        }
        const ct = (res.headers.get('content-type') || '').toLowerCase()
        if (ct && !ct.includes('text/html') && !ct.includes('text/plain') && !ct.includes('application/xhtml')) {
          return NextResponse.json({ ok: false, error: 'That link is not a web page. Enter the URL of an FAQ or website page.' }, { status: 400 })
        }
        const buf = Buffer.from(await res.arrayBuffer())
        const html = buf.subarray(0, MAX_RESPONSE_BYTES).toString('utf8')
        let pageTitle = ''
        try {
          const extracted = extractReadableText(html)
          pageTitle = extracted.title
          content = extracted.text
        } catch (parseErr) {
          console.error('[inbox.knowledge.parse]', parseErr)
          return NextResponse.json({ ok: false, error: 'Could not read the text on that page.' }, { status: 400 })
        }
        if (!content) {
          return NextResponse.json({ ok: false, error: 'No readable text found on that page. Try a different URL.' }, { status: 400 })
        }
        sourceUrl = parsedUrl.toString()
        if (!title) title = pageTitle || parsedUrl.toString()
      } else {
        content = (body.content || '').toString()
      }
    }

    if (!VALID_KINDS.has(kind)) {
      return NextResponse.json({ ok: false, error: 'Invalid kind' }, { status: 400 })
    }
    content = (content || '').trim()
    if (!content) {
      return NextResponse.json({ ok: false, error: 'Content is required' }, { status: 400 })
    }
    if (content.length > MAX_CONTENT_CHARS) {
      content = content.substring(0, MAX_CONTENT_CHARS).trimEnd() + '\n\n[Truncated: this entry was longer than the per-entry limit.]'
    }
    if (!title) title = kind === 'model_answer' ? 'Model answer' : kind === 'web_page' ? 'Web page' : 'Reference document'
    title = title.substring(0, 200)

    const now = new Date()

    // Web pages dedupe by source URL within the org: re-ingesting the same URL
    // refreshes the existing entry instead of creating a duplicate.
    if (kind === 'web_page' && sourceUrl) {
      const dupe = await knex('inbox_knowledge')
        .where('organization_id', auth.orgId)
        .where('tenant_id', auth.tenantId)
        .where('source_url', sourceUrl)
        .first()
      if (dupe) {
        await knex('inbox_knowledge')
          .where('id', dupe.id)
          .update({ title, content, kind: 'web_page', is_active: true, updated_at: now })
        const refreshed = await knex('inbox_knowledge').where('id', dupe.id).first()
        return NextResponse.json({ ok: true, data: serializeListRow(refreshed) })
      }
    }

    const id = crypto.randomUUID()
    await knex('inbox_knowledge').insert({
      id,
      tenant_id: auth.tenantId,
      organization_id: auth.orgId,
      kind,
      title,
      content,
      source_url: sourceUrl,
      is_active: true,
      created_at: now,
      updated_at: now,
    })

    const row = await knex('inbox_knowledge').where('id', id).first()
    return NextResponse.json({ ok: true, data: serializeListRow(row) })
  } catch (error) {
    console.error('[inbox.knowledge.post]', error)
    return NextResponse.json({ ok: false, error: 'Failed to save entry' }, { status: 500 })
  }
}

// DELETE: soft-delete (is_active = false) one entry by ?id=. Org-scoped.
export async function DELETE(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const id = new URL(req.url).searchParams.get('id')
    if (!id) return NextResponse.json({ ok: false, error: 'Missing id' }, { status: 400 })
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const updated = await knex('inbox_knowledge')
      .where('id', id)
      .where('organization_id', auth.orgId)
      .where('tenant_id', auth.tenantId)
      .update({ is_active: false, updated_at: new Date() })
    if (!updated) {
      return NextResponse.json({ ok: false, error: 'Entry not found' }, { status: 404 })
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[inbox.knowledge.delete]', error)
    return NextResponse.json({ ok: false, error: 'Failed to delete entry' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Inbox',
  summary: 'Personal Inbox grounding library',
  methods: {
    GET: { summary: 'List active grounding entries for the current org', tags: ['Inbox'] },
    POST: { summary: 'Add a model answer, reference document, or web page', tags: ['Inbox'] },
    DELETE: { summary: 'Soft-delete a grounding entry for the current org', tags: ['Inbox'] },
  },
}
