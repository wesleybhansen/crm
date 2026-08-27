import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { gtmInternalOpenApi } from '../../openapi'

export const openApi = gtmInternalOpenApi('Apply a scoped GTM removal request')
import type { EntityManager } from '@mikro-orm/postgresql'
import type { ExecutionEm } from '../../../lib/execute/schedule'
import { normalizeRemovalEmail } from '../../../lib/removal-request'
import { normalizeConsumerProfileUrl } from '../../../lib/research/execute'

/*
 * Internal prospect-removal endpoint (privacy policy section 3.8).
 *
 * The Noli hub's public /api/public/prospect-removal route calls this
 * server-to-server with NOLI_INTERNAL_SERVICE_SECRET after it has done the
 * CORS / honeypot / rate-limit work. There is no session and no user: the
 * requester is a member of the public asking to be removed from Prospect
 * Data, so this route deliberately writes ACROSS every organization (a
 * platform-wide suppression plus a stop of anything already queued). That is
 * the one intentional exception to the module's self-scoping rule, and it is
 * only reachable behind the shared secret.
 *
 * Deliberately NOT gated on the GTM feature flag: like the unsubscribe
 * endpoint, removal is a compliance surface. Once any address exists in
 * Prospect Data the removal path must keep working even if the feature is
 * later switched off.
 *
 * Public at the dispatcher level (requireAuth: false) - we authenticate with
 * the shared secret instead, mirroring api/internal/import-audience-play.
 *
 * PRIVACY-CRITICAL: the response is identical whether or not we held
 * anything for that address. Telling an anonymous caller "yes, you were in
 * someone's prospect list" would itself be a disclosure, and would turn this
 * endpoint into an oracle for probing who is being prospected. Counts of
 * stopped enrollments are returned only because the hub never forwards them
 * to the browser; the public route collapses them. Nothing here logs the
 * address.
 */
export const metadata = {
  path: '/internal/gtm/removal-request',
  POST: { requireAuth: false },
}

export async function POST(req: Request) {
  // Shared-secret auth (length-guarded constant-time compare).
  const secret = process.env.NOLI_INTERNAL_SERVICE_SECRET
  const authHeader = (req.headers.get('authorization') || '').trim()
  const expected = secret ? `Bearer ${secret}` : ''
  if (
    !secret ||
    authHeader.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))
  ) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const raw = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const email = normalizeRemovalEmail(raw.email)
  const profileUrl = normalizeConsumerProfileUrl(raw.profileUrl)
  if (!email && !profileUrl) {
    return NextResponse.json({ ok: false, error: 'A valid email or LinkedIn profile URL is required' }, { status: 400 })
  }

  try {
    const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager as unknown as ExecutionEm
    const { applyRemovalRequest, applyProfileRemovalRequest } = await import('../../../lib/removal-request')
    const shared = {
      reason: typeof raw.reason === 'string' ? raw.reason : null,
      source: typeof raw.source === 'string' ? raw.source : null,
    }
    const results = []
    if (email) results.push(await applyRemovalRequest(em, { email, ...shared }))
    if (profileUrl) results.push(await applyProfileRemovalRequest(em, { profileUrl, ...shared }))
    const requestIds = results.map((result) => result.deletionRequestId)
    return NextResponse.json({
      ok: true,
      suppressed: true,
      enrollments_stopped: results.reduce((sum, result) => sum + result.enrollmentsStopped, 0),
      // Preserve the original scalar for compatibility and add the complete
      // set when a requester supplies both identifiers.
      deletion_request_id: requestIds[0],
      deletion_request_ids: requestIds,
      deletion_status: results.every((result) => result.deletionStatus === 'completed')
        ? 'completed'
        : 'partial',
    })
  } catch (err) {
    // Never interpolate the address into a log line.
    console.error('[internal.gtm.removal-request]', (err as Error)?.message ?? 'failed')
    return NextResponse.json({ ok: false, error: 'Removal failed' }, { status: 500 })
  }
}
