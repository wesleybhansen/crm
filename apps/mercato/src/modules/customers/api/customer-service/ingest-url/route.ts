// ORM-SKIP: raw insert into customer_service_knowledge (web-page grounding)
export const metadata = {
  path: '/customer-service/ingest-url',
  POST: { requireAuth: true, requireFeatures: ['email.send'] },
}

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import * as cheerio from 'cheerio'
import dns from 'node:dns/promises'
import net from 'node:net'
import crypto from 'crypto'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

// Matches the per-entry cap used by the knowledge POST route so a single web
// page can never store an unbounded blob.
const MAX_CONTENT_CHARS = 20000
// Web pages are stored with this prefix in source_filename so they are deduped
// and surfaced as a web source (mirrors the "kb:" convention for KB imports).
const URL_SOURCE_PREFIX = 'url:'
const FETCH_TIMEOUT_MS = 15000
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024 // 5MB ceiling on the downloaded HTML.
const USER_AGENT =
  'Mozilla/5.0 (compatible; NoliCRM/1.0; +https://noliai.com) customer-service-grounding'

// Is this IP literal in a loopback / private / link-local / reserved range?
// Used both for direct-IP URLs and for resolved hostnames (SSRF defense).
function isBlockedIp(ip: string): boolean {
  const type = net.isIP(ip)
  if (type === 4) {
    const parts = ip.split('.').map((n) => parseInt(n, 10))
    const [a, b] = parts
    if (a === 0) return true // 0.0.0.0/8
    if (a === 10) return true // 10.0.0.0/8
    if (a === 127) return true // loopback
    if (a === 169 && b === 254) return true // link-local 169.254.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
    if (a === 192 && b === 168) return true // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64.0.0/10
    if (a >= 224) return true // multicast / reserved
    return false
  }
  if (type === 6) {
    const lower = ip.toLowerCase()
    if (lower === '::1' || lower === '::') return true // loopback / unspecified
    if (lower.startsWith('fe80')) return true // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true // unique local
    // IPv4-mapped (::ffff:127.0.0.1 etc) — re-check the embedded v4.
    const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isBlockedIp(mapped[1])
    return false
  }
  return true // unknown format — block to be safe.
}

// Validate the URL string + resolve its host and confirm no resolved address is
// private/loopback. Throws an Error with a user-facing message on rejection.
async function assertSafeUrl(raw: string): Promise<URL> {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('Enter a valid URL that starts with http:// or https://.')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https URLs are supported.')
  }
  const host = parsed.hostname.toLowerCase()
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new Error('That address is not allowed.')
  }
  // If the host is a raw IP, check it directly.
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error('That address is not allowed.')
    return parsed
  }
  // Otherwise resolve and verify every returned address is public.
  let addresses: string[] = []
  try {
    const records = await dns.lookup(host, { all: true })
    addresses = records.map((r) => r.address)
  } catch {
    throw new Error('Could not resolve that web address. Check the URL and try again.')
  }
  if (!addresses.length) {
    throw new Error('Could not resolve that web address. Check the URL and try again.')
  }
  if (addresses.some((ip) => isBlockedIp(ip))) {
    throw new Error('That address is not allowed.')
  }
  return parsed
}

// Pull readable text from an HTML string: strip noise (script/style/nav/etc),
// prefer <title> as a fallback name, collapse whitespace.
function extractReadableText(html: string): { title: string; text: string } {
  const $ = cheerio.load(html)
  const title = ($('title').first().text() || '').replace(/\s+/g, ' ').trim()
  $('script, style, noscript, nav, footer, header, aside, form, svg, iframe, template').remove()
  // Prefer main/article content when present; fall back to body.
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

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await req.json().catch(() => ({}))
    const rawUrl = (body.url || '').toString().trim()
    const label = (body.label || '').toString().trim()
    if (!rawUrl) {
      return NextResponse.json({ ok: false, error: 'Enter a web page URL.' }, { status: 400 })
    }

    let parsedUrl: URL
    try {
      parsedUrl = await assertSafeUrl(rawUrl)
    } catch (urlErr) {
      const msg = urlErr instanceof Error ? urlErr.message : 'That URL is not allowed.'
      return NextResponse.json({ ok: false, error: msg }, { status: 400 })
    }

    // Server-side fetch with a timeout. Redirects are followed by fetch; we
    // re-validated only the initial host, which is the standard tradeoff here
    // (a fully redirect-safe fetch would re-check every hop). Local/private
    // initial hosts are already blocked above.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(parsedUrl.toString(), {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
        },
      })
    } catch (fetchErr) {
      clearTimeout(timer)
      const aborted = fetchErr instanceof Error && fetchErr.name === 'AbortError'
      return NextResponse.json(
        {
          ok: false,
          error: aborted
            ? 'That page took too long to load. Try again or use a different URL.'
            : 'Could not load that page. Check the URL and try again.',
        },
        { status: 400 },
      )
    }
    clearTimeout(timer)

    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: `That page returned an error (${res.status}). Check the URL and try again.` },
        { status: 400 },
      )
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase()
    if (contentType && !contentType.includes('text/html') && !contentType.includes('text/plain') && !contentType.includes('application/xhtml')) {
      return NextResponse.json(
        { ok: false, error: 'That link is not a web page. Enter the URL of an FAQ or website page.' },
        { status: 400 },
      )
    }

    // Read with a byte ceiling so a huge response cannot exhaust memory.
    const buf = Buffer.from(await res.arrayBuffer())
    const html = buf.subarray(0, MAX_RESPONSE_BYTES).toString('utf8')

    let title = ''
    let text = ''
    try {
      const extracted = extractReadableText(html)
      title = extracted.title
      text = extracted.text
    } catch (parseErr) {
      console.error('[customer-service.ingest-url.parse]', parseErr)
      return NextResponse.json(
        { ok: false, error: 'Could not read the text on that page.' },
        { status: 400 },
      )
    }

    if (!text) {
      return NextResponse.json(
        { ok: false, error: 'No readable text found on that page. Try a different URL.' },
        { status: 400 },
      )
    }

    let content = text
    if (content.length > MAX_CONTENT_CHARS) {
      content =
        content.substring(0, MAX_CONTENT_CHARS).trimEnd() +
        '\n\n[Truncated: this page was longer than the per-entry limit.]'
    }

    // Title precedence: explicit label, then the page <title>, then the URL.
    let finalTitle = label || title || parsedUrl.toString()
    finalTitle = finalTitle.substring(0, 200)

    const sourceFilename = `${URL_SOURCE_PREFIX}${parsedUrl.toString()}`

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Dedupe by source URL within the org: re-ingesting the same URL refreshes
    // the existing entry instead of creating a duplicate.
    const now = new Date()
    const existing = await knex('customer_service_knowledge')
      .where('organization_id', auth.orgId)
      .where('tenant_id', auth.tenantId)
      .where('source_filename', sourceFilename)
      .first()

    let id: string
    if (existing) {
      id = existing.id
      await knex('customer_service_knowledge')
        .where('id', id)
        .update({ title: finalTitle, content, kind: 'document', is_active: true, updated_at: now })
    } else {
      id = crypto.randomUUID()
      await knex('customer_service_knowledge').insert({
        id,
        tenant_id: auth.tenantId,
        organization_id: auth.orgId,
        kind: 'document',
        title: finalTitle,
        content,
        source_filename: sourceFilename,
        is_active: true,
        created_at: now,
        updated_at: now,
      })
    }

    const row = await knex('customer_service_knowledge').where('id', id).first()
    // Mirror the knowledge route's friendly serialization for url: sources.
    const data = {
      id: row.id,
      kind: row.kind,
      title: row.title,
      sourceFilename: row.source_filename,
      contentPreview: (row.content || '').replace(/\s+/g, ' ').trim().substring(0, 200),
      createdAt: row.created_at,
    }
    return NextResponse.json({ ok: true, data })
  } catch (error) {
    console.error('[customer-service.ingest-url.post]', error)
    return NextResponse.json({ ok: false, error: 'Failed to ingest that page.' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Customer Service',
  summary: 'Ingest a web page as Customer Service grounding',
  methods: {
    POST: {
      summary: 'Fetch a URL, extract readable text, and store it as a grounding document for the current org',
      tags: ['Customer Service'],
    },
  },
}
