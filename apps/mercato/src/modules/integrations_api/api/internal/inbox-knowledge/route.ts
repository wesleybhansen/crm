import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import * as cheerio from 'cheerio'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { safeFetch, SsrfError } from '@/lib/safe-fetch'

/* Internal service endpoint (shared NOLI_INTERNAL_SERVICE_SECRET) that lets the
 * hub's Unified Inbox manage the PERSONAL Inbox grounding library (inbox_knowledge)
 * for a user without a CRM session: list, add (guidance/model answer, pasted
 * document, or a web page fetched SSRF-safely), and delete. This is the grounding
 * the personal drafter reads (draft-reply.ts knowledgeTable='inbox_knowledge').
 * Mirrors the session-authed /inbox/knowledge route but keyed by the noli user id,
 * the same way cs-queue is. Kept self-contained so it can't regress the CRM UI. */

export const metadata = {
  path: '/internal/inbox-knowledge',
  POST: { requireAuth: false },
}

const VALID_KINDS = new Set(['model_answer', 'document', 'web_page'])
const MAX_CONTENT_CHARS = 20000
const FETCH_TIMEOUT_MS = 15000
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const USER_AGENT = 'Mozilla/5.0 (compatible; NoliCRM/1.0; +https://noliai.com) inbox-grounding'

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}

type Auth = { userId: string; orgId: string; tenantId: string }

async function resolveAuth(noliUserId: string): Promise<Auth | null> {
  const { findNoliUserById } = await import('@open-mercato/shared/lib/noli/core-client')
  const noliUser = await findNoliUserById(noliUserId)
  if (!noliUser?.clerk_user_id) return null
  const { resolveClerkUserToAuthContext } = await import('@open-mercato/shared/lib/auth/clerk')
  const auth = await resolveClerkUserToAuthContext(noliUser.clerk_user_id)
  if (!auth?.userId || !auth?.orgId || !auth?.tenantId) return null
  return { userId: String(auth.userId), orgId: String(auth.orgId), tenantId: String(auth.tenantId) }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Knex = any

function previewOf(content: string): string {
  const flat = (content || '').replace(/\s+/g, ' ').trim()
  return flat.length > 200 ? `${flat.substring(0, 200)}...` : flat
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

function extractReadableText(html: string): { title: string; text: string } {
  const $ = cheerio.load(html)
  const title = ($('title').first().text() || '').replace(/\s+/g, ' ').trim()
  $('script, style, noscript, nav, footer, header, aside, form, svg, iframe, template').remove()
  const root = $('main').length ? $('main') : $('article').length ? $('article') : $('body')
  const rawText = root.text() || $.root().text() || ''
  const text = rawText
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { title, text }
}

async function listEntries(knex: Knex, auth: Auth) {
  const rows = await knex('inbox_knowledge')
    .where('organization_id', auth.orgId)
    .where('is_active', true)
    .orderBy('updated_at', 'desc')
    .limit(200)
  return rows.map(serializeListRow)
}

async function addEntry(
  knex: Knex,
  auth: Auth,
  input: { kind?: string; title?: string; content?: string; url?: string },
): Promise<{ ok: boolean; error?: string; status?: number; data?: unknown }> {
  let kind = typeof input.kind === 'string' ? input.kind : 'model_answer'
  let title = (input.title || '').toString().trim()
  let content = ''
  let sourceUrl: string | null = null

  if (kind === 'web_page') {
    const rawUrl = (input.url || '').toString().trim()
    if (!rawUrl) return { ok: false, error: 'Enter a web page URL.', status: 400 }
    let parsedUrl: URL
    try {
      parsedUrl = new URL(rawUrl)
    } catch {
      return { ok: false, error: 'Enter a valid URL that starts with http:// or https://.', status: 400 }
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return { ok: false, error: 'Only http and https URLs are supported.', status: 400 }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    let res: Response
    try {
      res = await safeFetch(
        parsedUrl.toString(),
        {
          method: 'GET',
          signal: controller.signal,
          headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8' },
        },
        3,
      )
    } catch (fetchErr) {
      clearTimeout(timer)
      const aborted = fetchErr instanceof Error && fetchErr.name === 'AbortError'
      if (fetchErr instanceof SsrfError) return { ok: false, error: 'That address is not allowed.', status: 400 }
      return {
        ok: false,
        error: aborted
          ? 'That page took too long to load. Try again or use a different URL.'
          : 'Could not load that page. Check the URL and try again.',
        status: 400,
      }
    }
    clearTimeout(timer)
    if (!res.ok) return { ok: false, error: `That page returned an error (${res.status}). Check the URL and try again.`, status: 400 }
    const ct = (res.headers.get('content-type') || '').toLowerCase()
    if (ct && !ct.includes('text/html') && !ct.includes('text/plain') && !ct.includes('application/xhtml')) {
      return { ok: false, error: 'That link is not a web page. Enter the URL of an FAQ or website page.', status: 400 }
    }
    const buf = Buffer.from(await res.arrayBuffer())
    const html = buf.subarray(0, MAX_RESPONSE_BYTES).toString('utf8')
    try {
      const extracted = extractReadableText(html)
      content = extracted.text
      if (!title) title = extracted.title || parsedUrl.toString()
    } catch {
      return { ok: false, error: 'Could not read the text on that page.', status: 400 }
    }
    if (!content) return { ok: false, error: 'No readable text found on that page. Try a different URL.', status: 400 }
    sourceUrl = parsedUrl.toString()
  } else {
    content = (input.content || '').toString()
  }

  if (!VALID_KINDS.has(kind)) return { ok: false, error: 'Invalid kind', status: 400 }
  content = (content || '').trim()
  if (!content) return { ok: false, error: 'Content is required', status: 400 }
  if (content.length > MAX_CONTENT_CHARS) {
    content = content.substring(0, MAX_CONTENT_CHARS).trimEnd() + '\n\n[Truncated: this entry was longer than the per-entry limit.]'
  }
  if (!title) title = kind === 'model_answer' ? 'Guidance' : kind === 'web_page' ? 'Web page' : 'Reference document'
  title = title.substring(0, 200)

  const now = new Date()

  if (kind === 'web_page' && sourceUrl) {
    const dupe = await knex('inbox_knowledge')
      .where('organization_id', auth.orgId)
      .where('tenant_id', auth.tenantId)
      .where('source_url', sourceUrl)
      .first()
    if (dupe) {
      await knex('inbox_knowledge').where('id', dupe.id).update({ title, content, kind: 'web_page', is_active: true, updated_at: now })
      const refreshed = await knex('inbox_knowledge').where('id', dupe.id).first()
      return { ok: true, data: serializeListRow(refreshed) }
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
  return { ok: true, data: serializeListRow(row) }
}

async function deleteEntry(knex: Knex, auth: Auth, id: string): Promise<{ ok: boolean; error?: string; status?: number }> {
  const updated = await knex('inbox_knowledge')
    .where('id', id)
    .where('organization_id', auth.orgId)
    .where('tenant_id', auth.tenantId)
    .update({ is_active: false, updated_at: new Date() })
  if (!updated) return { ok: false, error: 'Entry not found', status: 404 }
  return { ok: true }
}

export async function POST(req: Request) {
  const secret = process.env.NOLI_INTERNAL_SERVICE_SECRET
  const authHeader = (req.headers.get('authorization') || '').trim()
  if (!secret || !safeEq(authHeader, `Bearer ${secret}`)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const op = typeof body.op === 'string' ? body.op : ''
  const noliUserId = typeof body.noliUserId === 'string' ? body.noliUserId.trim() : ''
  if (!op || !noliUserId) {
    return NextResponse.json({ ok: false, error: 'op and noliUserId are required' }, { status: 400 })
  }

  try {
    const auth = await resolveAuth(noliUserId)
    if (!auth) return NextResponse.json({ ok: false, error: 'no CRM account for this user' }, { status: 404 })

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    if (op === 'list') {
      const data = await listEntries(knex, auth)
      return NextResponse.json({ ok: true, data })
    }
    if (op === 'add') {
      const r = await addEntry(knex, auth, {
        kind: typeof body.kind === 'string' ? body.kind : undefined,
        title: typeof body.title === 'string' ? body.title : undefined,
        content: typeof body.content === 'string' ? body.content : undefined,
        url: typeof body.url === 'string' ? body.url : undefined,
      })
      return NextResponse.json(r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error }, { status: r.status || (r.ok ? 200 : 500) })
    }
    if (op === 'delete') {
      const id = typeof body.id === 'string' ? body.id : ''
      if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })
      const r = await deleteEntry(knex, auth, id)
      return NextResponse.json(r.ok ? { ok: true } : { ok: false, error: r.error }, { status: r.status || (r.ok ? 200 : 500) })
    }
    return NextResponse.json({ ok: false, error: 'unknown op' }, { status: 400 })
  } catch (error) {
    console.error('[internal.inbox-knowledge]', op, error)
    return NextResponse.json({ ok: false, error: 'Server error' }, { status: 500 })
  }
}
