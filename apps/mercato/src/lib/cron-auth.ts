import crypto from 'crypto'
import { NextResponse } from 'next/server'

/* Fail-closed, constant-time Bearer auth for internal cron/process endpoints
 * (requireAuth:false routes triggered by the box crontab). Returns a Response to
 * send back when denied, or null when authorized.
 *
 * The previous inline pattern only refused when NODE_ENV==='production', so off
 * production (or if the container wasn't started with NODE_ENV set) these became
 * open, unauthenticated endpoints. This refuses unconditionally when the secret
 * is unset, and compares constant-time. */
export function requireProcessAuth(req: Request, secret: string | undefined): NextResponse | null {
  if (!secret) {
    return NextResponse.json({ ok: false, error: 'Not configured' }, { status: 500 })
  }
  // Compare byte Buffers, not JS string lengths: a multibyte header whose
  // UTF-16 length matched used to reach timingSafeEqual with mismatched byte
  // lengths and throw (500) instead of denying (401).
  const got = Buffer.from(req.headers.get('authorization') ?? '', 'utf8')
  const expected = Buffer.from(`Bearer ${secret}`, 'utf8')
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  return null
}
