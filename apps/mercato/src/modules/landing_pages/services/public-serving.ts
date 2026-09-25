import { NextResponse } from 'next/server'
import type { Knex } from 'knex'
import { normalizeLegacyLandingPageImageUrls } from './landing-page-image-urls'

/**
 * Shared serving logic for published landing pages, used by both public
 * routes (slug lookup and custom-domain lookup). Handles:
 *  - A/B arm selection (sticky via `lp_ab_{pageId}` cookie, weight-based on
 *    first visit) when the page has ab_enabled and at least one active variant
 *  - per-arm view counters (control = landing_pages.view_count, variants =
 *    landing_page_variants.view_count)
 *  - daily per-arm view stats + referrer host counts (best effort: serving
 *    never fails if the analytics tables have not been created yet)
 *  - UTM capture script injection (populates hidden form fields)
 *  - form action URL normalization (legacy hyphen paths, and origin stripping
 *    for custom-domain serving so form posts stay same-origin)
 */

// Control arm sentinel used in landing_page_daily_stats.variant_id so a plain
// unique index works with ON CONFLICT (matches scripts/sql/landing-ab-analytics.sql).
export const CONTROL_VARIANT_UUID = '00000000-0000-0000-0000-000000000000'

export function abCookieName(pageId: string): string {
  return `lp_ab_${pageId}`
}

/** Parse the sticky A/B arm cookie for a page from a request. */
export function readAbArmFromRequest(req: Request, pageId: string): string | null {
  const header = req.headers.get('cookie')
  if (!header) return null
  const name = abCookieName(pageId)
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    if (part.slice(0, idx).trim() === name) {
      const value = decodeURIComponent(part.slice(idx + 1).trim())
      return value || null
    }
  }
  return null
}

/** Weight-based random pick between control and active variants. */
function pickArm(variants: Array<{ id: string; weight: number }>): string {
  const weights = variants.map((v) => Math.max(0, Math.min(100, Number(v.weight) || 0)))
  const variantSum = weights.reduce((a, b) => a + b, 0)
  const controlWeight = Math.max(0, 100 - variantSum)
  const total = controlWeight + variantSum
  if (total <= 0) return 'control'
  let r = Math.random() * total
  if (r < controlWeight) return 'control'
  r -= controlWeight
  for (let i = 0; i < variants.length; i++) {
    if (r < weights[i]) return variants[i].id
    r -= weights[i]
  }
  return 'control'
}

/**
 * Best-effort upsert of the per-day per-arm counters. Never throws (the
 * analytics tables may not exist until the DDL file has been applied).
 */
export async function bumpDailyStats(
  knex: Knex,
  page: { id: string; organization_id: string },
  armVariantId: string | null,
  kind: 'view' | 'submission',
): Promise<void> {
  try {
    const variantId = armVariantId && armVariantId !== 'control' ? armVariantId : CONTROL_VARIANT_UUID
    const viewsInc = kind === 'view' ? 1 : 0
    const submissionsInc = kind === 'submission' ? 1 : 0
    await knex.raw(
      `insert into landing_page_daily_stats (id, organization_id, landing_page_id, variant_id, day, views, submissions)
       values (?, ?, ?, ?, current_date, ?, ?)
       on conflict (landing_page_id, variant_id, day)
       do update set views = landing_page_daily_stats.views + excluded.views,
                     submissions = landing_page_daily_stats.submissions + excluded.submissions`,
      [require('crypto').randomUUID(), page.organization_id, page.id, variantId, viewsInc, submissionsInc],
    )
  } catch {
    // Analytics tables not provisioned yet; never break public serving.
  }
}

/** Best-effort referrer host counter. Skips empty/self referrers. Never throws. */
async function bumpReferrer(
  knex: Knex,
  page: { id: string; organization_id: string; custom_domain?: string | null },
  req: Request,
): Promise<void> {
  try {
    const referer = req.headers.get('referer')
    if (!referer) return
    let host = ''
    try {
      host = new URL(referer).hostname.toLowerCase()
    } catch {
      return
    }
    if (!host) return
    const selfHosts = new Set<string>()
    try {
      selfHosts.add(new URL(req.url).hostname.toLowerCase())
    } catch {}
    const appUrl = process.env.APP_URL
    if (appUrl) {
      try {
        selfHosts.add(new URL(appUrl).hostname.toLowerCase())
      } catch {}
    }
    if (page.custom_domain) selfHosts.add(String(page.custom_domain).toLowerCase())
    if (selfHosts.has(host)) return
    await knex.raw(
      `insert into landing_page_referrers (id, organization_id, landing_page_id, host, count)
       values (?, ?, ?, ?, 1)
       on conflict (landing_page_id, host)
       do update set count = landing_page_referrers.count + 1`,
      [require('crypto').randomUUID(), page.organization_id, page.id, host],
    )
  } catch {
    // Analytics tables not provisioned yet; never break public serving.
  }
}

/** Affiliate codes are short slugs; anything else in the cookie is ignored. */
const AFFILIATE_CODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export function readAffiliateRefFromRequest(req: Request): string | null {
  const header = req.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    if (part.slice(0, idx).trim() !== 'affiliate_ref') continue
    let value = part.slice(idx + 1).trim()
    try {
      value = decodeURIComponent(value)
    } catch {
      return null
    }
    return AFFILIATE_CODE_PATTERN.test(value) ? value : null
  }
  return null
}

export function isValidAffiliateCode(value: unknown): value is string {
  return typeof value === 'string' && AFFILIATE_CODE_PATTERN.test(value)
}

/**
 * Published pages are served in a CSP sandbox (opaque origin, see
 * src/lib/public-surface.ts), so their form posts are cross-origin and carry
 * no cookies. The serve request still sees the visitor's cookies, so the A/B
 * arm and affiliate referral code the submit handler used to read from
 * cookies are handed to the page's forms as hidden fields instead.
 */
export function visitorContextScript(fields: Record<string, string | null | undefined>): string {
  const entries = Object.entries(fields).filter(([, v]) => typeof v === 'string' && v.length > 0)
  if (entries.length === 0) return ''
  const json = JSON.stringify(Object.fromEntries(entries))
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
  return `<script>(function(){try{var v=${json};document.querySelectorAll('form').forEach(function(f){Object.keys(v).forEach(function(k){if(f.querySelector('input[name="'+k+'"]'))return;var h=document.createElement('input');h.type='hidden';h.name=k;h.value=v[k];f.appendChild(h)})})}catch(e){}})()</script>`
}

const UTM_CAPTURE_SCRIPT = `<script>(function(){try{var p=new URLSearchParams(window.location.search);var u=['utm_source','utm_medium','utm_campaign','utm_content','utm_term'];var r=document.referrer||'';document.querySelectorAll('form').forEach(function(f){u.forEach(function(k){var v=p.get(k);if(v){var h=document.createElement('input');h.type='hidden';h.name='_'+k;h.value=v;f.appendChild(h)}});if(r){var rh=document.createElement('input');rh.type='hidden';rh.name='_referrer';rh.value=r;f.appendChild(rh)}})}catch(e){}})()</script>`

const LEGACY_CHECKOUT_URL = /(?:https?:\/\/[a-zA-Z0-9.:\-]+)?\/api\/landing-page-checkout\b/g

export function normalizeHtml(html: string, opts: { makeApiUrlsRelative: boolean; slug?: string | null }): string {
  // Older publishes baked "/api/landing-pages/..." (hyphen) form actions; the
  // module dispatcher only serves "/api/landing_pages/..." (underscore).
  let out = html
    .split('/api/landing-pages/public/').join('/api/landing_pages/public/')
  // Wizard pages published before 2026-09-25 call "/api/landing-page-checkout",
  // which never existed. Point them at this page's public checkout (relative,
  // so it works on custom domains too); the server prices the page's own
  // configured product whatever the old body says.
  if (opts.slug) {
    out = out.replace(LEGACY_CHECKOUT_URL, `/api/landing_pages/public/${encodeURIComponent(opts.slug)}/checkout`)
  }
  out = normalizeLegacyLandingPageImageUrls(out)
  if (opts.makeApiUrlsRelative) {
    // On custom domains, absolute form actions pointing at the CRM host would
    // be cross-origin (CORS preflight fails). Relative URLs keep the post
    // same-origin; the proxy forwards /api/* to the app on every host.
    out = out.replace(/https?:\/\/[a-zA-Z0-9.:\-]+\/api\/landing_pages\/public\//g, '/api/landing_pages/public/')
  }
  return out
}

export type ServeOptions = {
  /** Set when serving on a custom domain so baked form actions become relative. */
  makeApiUrlsRelative?: boolean
}

/**
 * Render the response for a published landing page row (already looked up and
 * access-scoped by the caller: by slug or by custom domain).
 */
export async function servePublishedLandingPage(
  knex: Knex,
  page: Record<string, any>,
  req: Request,
  opts: ServeOptions = {},
): Promise<NextResponse> {
  if (!page || !page.published_html) {
    return new NextResponse('<html><body><h1>Page not found</h1></body></html>', {
      status: 404,
      headers: { 'Content-Type': 'text/html' },
    })
  }

  let html: string = page.published_html
  let arm: string = 'control'
  let abActive = false

  if (page.ab_enabled) {
    try {
      const variants = await knex('landing_page_variants')
        .where('landing_page_id', page.id)
        .where('status', 'active')
        .select('id', 'weight', 'published_html')
      if (variants.length > 0) {
        abActive = true
        const cookieArm = readAbArmFromRequest(req, page.id)
        const validArm =
          cookieArm === 'control' || variants.some((v: any) => v.id === cookieArm) ? cookieArm : null
        arm = validArm ?? pickArm(variants)
        if (arm !== 'control') {
          const chosen = variants.find((v: any) => v.id === arm)
          if (chosen?.published_html) html = chosen.published_html
        }
      }
    } catch {
      // Variant table not provisioned yet; serve control.
      abActive = false
      arm = 'control'
    }
  }

  // Per-arm total view counters (control = the landing_pages row, as before)
  try {
    if (abActive && arm !== 'control') {
      await knex('landing_page_variants').where('id', arm).increment('view_count', 1)
    } else {
      await knex('landing_pages').where('id', page.id).increment('view_count', 1)
    }
  } catch {
    // Counter failures must never take the page down.
  }

  await bumpDailyStats(knex, page as any, abActive ? arm : null, 'view')
  await bumpReferrer(knex, page as any, req)

  const affiliateRef = readAffiliateRefFromRequest(req)
  const injected = UTM_CAPTURE_SCRIPT + visitorContextScript({
    _ab_arm: abActive ? arm : null,
    _aff_ref: affiliateRef,
  })
  html = normalizeHtml(html, { makeApiUrlsRelative: !!opts.makeApiUrlsRelative, slug: page.slug })
  // Split on the LAST </body> via lastIndexOf: String.replace would also
  // interpret `$` patterns in the injected script.
  const bodyClose = html.lastIndexOf('</body>')
  html = bodyClose === -1 ? html + injected : html.slice(0, bodyClose) + injected + html.slice(bodyClose)

  const headers: Record<string, string> = {
    'Content-Type': 'text/html; charset=utf-8',
    // A/B responses and pages carrying a visitor's referral code vary per
    // visitor, so they must not be shared-cached; other pages keep the
    // original short public cache.
    'Cache-Control': abActive || affiliateRef ? 'private, no-store' : 'public, max-age=60',
  }
  const res = new NextResponse(html, { status: 200, headers })
  if (abActive) {
    res.headers.append(
      'Set-Cookie',
      `${abCookieName(page.id)}=${encodeURIComponent(arm)}; Path=/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax`,
    )
  }
  return res
}
