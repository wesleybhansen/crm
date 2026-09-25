import { lookup } from 'node:dns/promises'
import net from 'node:net'

/*
 * Reads a prospect's own public website for the Launch Pad shortlist check
 * (verify.ts): the home page plus up to two same-site pages whose links look
 * like "about", "team", "doctors" or "contact". No provider, no spend.
 *
 * The URL comes from provider data (a Google Maps or LinkedIn listing), so it
 * is untrusted and fetched from inside the CRM's network. Guards, all
 * fail-closed:
 *   - http(s) only, default ports only, no credentials in the URL;
 *   - the host must resolve ONLY to public unicast addresses (loopback,
 *     private, link-local, CGNAT, multicast, reserved and unique-local v6 are
 *     refused), checked again on every redirect hop, redirects followed by
 *     hand (at most 3);
 *   - per-request timeout, a hard body cap, text/html only.
 * The residual DNS-rebinding window between the check and the connect is
 * accepted: the fetch carries no credentials, reads a page and nothing else.
 */

export const SITE_FETCH_TIMEOUT_MS = 8_000
export const SITE_MAX_BYTES = 400_000
export const SITE_MAX_REDIRECTS = 3
export const SITE_MAX_SUBPAGES = 2
export const SITE_TEXT_CAP = 7_000

export type SitePage = { url: string; text: string }
export type SiteRead = {
  ok: boolean
  error: string | null
  pages: SitePage[]
  /** Lower-cased raw HTML of every page, for template/asset signatures. */
  rawHtml: string
  /** The untrimmed text of every page (footers included): ownership lines
   *  such as "Part of X Group" usually sit in the footer, which the model's
   *  trimmed view can drop. Used for signals and to verify quotes. */
  fullText: string
  /** Phone numbers on the site, digits only (10, US), tel: links first. */
  phones: string[]
}

type Resolver = (host: string) => Promise<Array<{ address: string; family: number }>>
type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export function isPublicAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number)
    if (a === 0 || a === 10 || a === 127) return false
    if (a === 100 && b >= 64 && b <= 127) return false
    if (a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 192 && b === 0) return false
    if (a === 198 && (b === 18 || b === 19)) return false
    if (a >= 224) return false
    return true
  }
  if (net.isIPv6(address)) {
    const v = address.toLowerCase()
    if (v === '::' || v === '::1') return false
    if (v.startsWith('::ffff:')) return isPublicAddress(v.slice(7))
    if (/^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff')) return false
    return true
  }
  return false
}

export function safeSiteUrl(value: string | null | undefined): URL | null {
  if (!value) return null
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.username || url.password) return null
  if (url.port && url.port !== '80' && url.port !== '443') return null
  if (!url.hostname.includes('.') || net.isIP(url.hostname)) return null
  // Tracking parameters from the listing are noise, never needed to load a page.
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|y_source|gclid|fbclid)/i.test(key)) url.searchParams.delete(key)
  }
  url.hash = ''
  return url
}

async function hostIsPublic(host: string, resolve: Resolver): Promise<boolean> {
  try {
    const addresses = await resolve(host)
    return addresses.length > 0 && addresses.every((row) => isPublicAddress(row.address))
  } catch {
    return false
  }
}

async function fetchPage(start: URL, deps: { fetchImpl: FetchLike; resolve: Resolver }): Promise<{ url: string; html: string } | { error: string }> {
  let url = start
  for (let hop = 0; hop <= SITE_MAX_REDIRECTS; hop += 1) {
    if (!(await hostIsPublic(url.hostname, deps.resolve))) return { error: 'host_not_public' }
    let res: Response
    try {
      res = await deps.fetchImpl(url.toString(), {
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NoliSiteCheck/1.0)', Accept: 'text/html' },
        signal: AbortSignal.timeout(SITE_FETCH_TIMEOUT_MS),
      })
    } catch {
      return { error: 'unreachable' }
    }
    if (res.status >= 300 && res.status < 400) {
      const next = safeSiteUrl(res.headers.get('location') ? new URL(res.headers.get('location') as string, url).toString() : null)
      if (!next) return { error: 'bad_redirect' }
      url = next
      continue
    }
    if (!res.ok) return { error: `http_${res.status}` }
    const type = res.headers.get('content-type') ?? ''
    if (type && !/text\/html|application\/xhtml/i.test(type)) return { error: 'not_html' }
    const reader = res.body?.getReader()
    if (!reader) return { error: 'empty' }
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done || !value) break
      chunks.push(value)
      size += value.byteLength
      if (size >= SITE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined)
        break
      }
    }
    return { url: url.toString(), html: Buffer.concat(chunks).toString('utf8') }
  }
  return { error: 'too_many_redirects' }
}

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©' }

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
        return Number.isFinite(code) ? String.fromCodePoint(code) : ' '
      }
      return ENTITY[e.toLowerCase()] ?? m
    })
    .replace(/\s+/g, ' ')
    .trim()
}

const SUBPAGE = /\b(about|team|staff|doctor|veterinarian|our-vets|meet|people|leadership|contact|who-we-are|owner)/i

export function subpageLinks(html: string, base: URL): URL[] {
  const out: URL[] = []
  const seen = new Set<string>([base.pathname])
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi)) {
    let url: URL
    try {
      url = new URL(m[1], base)
    } catch {
      continue
    }
    if (url.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue
    if (!SUBPAGE.test(url.pathname) && !SUBPAGE.test(m[2])) continue
    const safe = safeSiteUrl(url.toString())
    if (!safe || seen.has(safe.pathname)) continue
    seen.add(safe.pathname)
    out.push(safe)
  }
  // "about"/"team"/"doctors" beat "contact": ownership lives there.
  return out.sort((a, b) => Number(/contact/i.test(a.pathname)) - Number(/contact/i.test(b.pathname))).slice(0, SITE_MAX_SUBPAGES)
}

export function normalizeUsPhone(value: string): string | null {
  const digits = value.replace(/\D/g, '')
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? ten : null
}

export function sitePhones(html: string, text: string): string[] {
  const out: string[] = []
  const push = (raw: string) => {
    const n = normalizeUsPhone(raw)
    if (n && !out.includes(n)) out.push(n)
  }
  for (const m of html.matchAll(/href=["']tel:([^"']+)["']/gi)) push(decodeURIComponent(m[1]))
  for (const m of text.matchAll(/(?:\+?1[\s.-]?)?\(?\b[2-9]\d{2}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g)) push(m[0])
  return out.slice(0, 12)
}

export async function readSite(
  website: string | null | undefined,
  deps: { fetchImpl?: FetchLike; resolve?: Resolver } = {},
): Promise<SiteRead> {
  const empty: SiteRead = { ok: false, error: 'no_website', pages: [], rawHtml: '', fullText: '', phones: [] }
  const start = safeSiteUrl(website)
  if (!start) return empty
  const d = {
    fetchImpl: deps.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init)),
    resolve: deps.resolve ?? ((host: string) => lookup(host, { all: true, verbatim: true })),
  }
  const home = await fetchPage(start, d)
  if ('error' in home) return { ...empty, error: home.error }
  const homeUrl = new URL(home.url)
  const extra = await Promise.all(subpageLinks(home.html, homeUrl).map((url) => fetchPage(url, d)))
  const htmls = [home, ...extra.filter((p): p is { url: string; html: string } => !('error' in p))]
  const pages = htmls.map((p) => ({ url: p.url, text: htmlToText(p.html) }))
  // Share the text budget across pages so the about/team page is never cut
  // off by a long home page.
  const per = Math.floor(SITE_TEXT_CAP / pages.length)
  const trimmed = pages.map((p) => ({ url: p.url, text: p.text.length > per ? `${p.text.slice(0, Math.floor(per * 0.7))} … ${p.text.slice(-Math.floor(per * 0.3))}` : p.text }))
  const rawHtml = htmls.map((p) => p.html).join('\n').toLowerCase()
  const phones = htmls.flatMap((p, i) => sitePhones(p.html, pages[i].text))
  return { ok: true, error: null, pages: trimmed, rawHtml, fullText: pages.map((p) => p.text).join(' \n '), phones: [...new Set(phones)] }
}
