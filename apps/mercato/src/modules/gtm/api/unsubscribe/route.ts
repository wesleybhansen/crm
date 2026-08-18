import { NextResponse } from 'next/server'
import { gtmUnsubscribeOpenApi } from '../openapi'

export const openApi = gtmUnsubscribeOpenApi
import type { EntityManager } from '@mikro-orm/postgresql'
import type { ExecutionEm } from '../../lib/execute/schedule'
import { verifyUnsubscribeToken } from '../../lib/unsubscribe'

/*
 * Public GTM unsubscribe endpoint (SPEC-066 section 8; RFC 8058).
 *
 * The URL carried in every GTM send's List-Unsubscribe header is
 *   {GTM_PUBLIC_BASE_URL}/api/gtm/unsubscribe?token=...
 * where the token is the HMAC-signed `{enrollmentId}.{addressHash}.{sig}`
 * from lib/unsubscribe.ts.
 *
 * GET  renders a minimal confirmation page with a POST form (for humans who
 *      click the unsubscribe link in a mail client).
 * POST is the RFC 8058 one-click target (mail providers POST
 *      `List-Unsubscribe=One-Click` with no user interaction) and the form
 *      target. Verifies the token, then IN ONE TRANSACTION writes the
 *      gtm_suppressions row (reason 'unsubscribe', channel email,
 *      org-scoped), stops the enrollment (stop_reason 'unsubscribe'),
 *      cancels the remaining pre-claim attempts, and audits. Idempotent.
 *
 * Deliberately NOT gated on the GTM feature flag: unsubscribe is a
 * compliance surface - once any mail carried this URL it must keep working
 * even if the feature is later switched off. A bad or missing token gets an
 * opaque 400/404; verification is length-guarded timingSafeEqual.
 */
export const metadata = {
  path: '/gtm/unsubscribe',
  GET: { requireAuth: false },
  POST: { requireAuth: false },
}

function tokenFrom(req: Request): string | null {
  try {
    const url = new URL(req.url)
    return url.searchParams.get('token')
  } catch {
    return null
  }
}

const PAGE_STYLE =
  'font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; color: #222;'

export async function GET(req: Request) {
  const token = tokenFrom(req)
  const payload = verifyUnsubscribeToken(token)
  if (!payload) {
    return new NextResponse('Not found', { status: 404 })
  }
  const action = `?token=${encodeURIComponent(token as string)}`
  const html =
    `<!doctype html><html><head><meta charset="utf-8"><title>Unsubscribe</title></head>` +
    `<body><div style="${PAGE_STYLE}">` +
    `<h1 style="font-size:1.25rem">Unsubscribe</h1>` +
    `<p>Click the button below to stop receiving these emails.</p>` +
    `<form method="post" action="${action}">` +
    `<input type="hidden" name="List-Unsubscribe" value="One-Click">` +
    `<button type="submit" style="padding:0.5rem 1.25rem">Unsubscribe</button>` +
    `</form></div></body></html>`
  return new NextResponse(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

export async function POST(req: Request) {
  const token = tokenFrom(req)
  const payload = verifyUnsubscribeToken(token)
  if (!payload) {
    return NextResponse.json({ ok: false, error: 'Invalid token' }, { status: 400 })
  }
  try {
    const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager as unknown as ExecutionEm
    const { applyUnsubscribe } = await import('../../lib/unsubscribe')
    const result = await applyUnsubscribe(em, payload)
    if (!result.enrollmentFound) {
      // Opaque: a forged-but-signed token for a purged enrollment gets the
      // same shape as success (nothing to learn from the response).
      return new NextResponse('You have been unsubscribed.', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    }
    return new NextResponse('You have been unsubscribed.', {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  } catch (err) {
    console.error('[gtm.unsubscribe]', err)
    return NextResponse.json({ ok: false, error: 'Unsubscribe failed' }, { status: 500 })
  }
}
