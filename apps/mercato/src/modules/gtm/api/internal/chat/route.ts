import { NextResponse } from 'next/server'
import { internalServiceBearerAuthorized } from '../../../lib/authorize'
import { gtmInternalOpenApi } from '../../openapi'

export const openApi = gtmInternalOpenApi('Persist scoped GTM strategist chat state')
import type { EntityManager } from '@mikro-orm/postgresql'
import { gtmEnabled } from '../../../lib/flags'
import { gtmChatBodySchema } from '../../../data/validators'
import { isUuid } from '../../../lib/play-shape'
import { GtmChatError } from '../../../lib/chat/store'

/*
 * Internal GTM Strategist chat persistence (GTM-SPEC-04 section 2.3).
 *
 * Same server-to-server contract as the other internal GTM routes: the Noli
 * hub calls this with the shared NOLI_INTERNAL_SERVICE_SECRET, identity is
 * re-resolved (noliUserId -> Clerk -> Mercato auth context, gated on the 'crm'
 * entitlement), and every query self-scopes by organization_id + tenant_id.
 *
 * Ops (body.op):
 *   thread-list      workspace-scoped thread history (newest first, cap 50)
 *   thread-create    create a chat thread in a live workspace { title? }
 *   messages         thread-scoped message history (chronological)
 *   append-message   append one turn { threadId, role, content, toolRef? }
 *
 * This route stores durable state only. It never sources, drafts, sends, or
 * spends: the agent loop that calls it is read/prepare-only and every spend or
 * send stays a human action elsewhere.
 *
 * Public at the dispatcher level (requireAuth: false): authentication is the
 * shared secret, mirroring internal/gtm/strategy.
 */
export const metadata = {
  path: '/internal/gtm/chat',
  POST: { requireAuth: false },
}

function opaqueNotFound() {
  return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })
}

export async function POST(req: Request) {
  // 0. Feature gate: fail closed when the GTM Engineer flag is off.
  if (!gtmEnabled()) return opaqueNotFound()

  // 1. Shared-secret auth (length-guarded constant-time compare).
  // Byte-length guarded constant-time compare (lib/authorize.ts).
  if (!internalServiceBearerAuthorized(req)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  // 2. Body.
  const raw = await req.json().catch(() => ({}))
  const parsed = gtmChatBodySchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where = first?.path?.length ? `${first.path.join('.')}: ` : ''
    return NextResponse.json({ ok: false, error: `${where}${first?.message ?? 'Invalid body'}` }, { status: 400 })
  }
  const body = parsed.data

  try {
    // 3. noli-core user -> Clerk id.
    const { findNoliUserById } = await import('@open-mercato/shared/lib/noli/core-client')
    const noliUser = await findNoliUserById(body.noliUserId)
    if (!noliUser?.clerk_user_id) {
      return NextResponse.json({ ok: false, error: 'Noli user not found' }, { status: 404 })
    }

    // 4. Resolve to a Mercato auth context (gates on the 'crm' entitlement).
    const { resolveClerkUserToAuthContext } = await import('@open-mercato/shared/lib/auth/clerk')
    const auth = await resolveClerkUserToAuthContext(noliUser.clerk_user_id)
    if (!auth || !auth.userId || !auth.orgId || !auth.tenantId) {
      return NextResponse.json({ ok: false, error: 'User has no CRM access' }, { status: 403 })
    }
    const ctx = {
      organizationId: auth.orgId as string,
      tenantId: auth.tenantId as string,
      userId: auth.userId as string,
      requestId: req.headers.get('x-request-id') || null,
    }

    const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
    const container = await createRequestContainer()
    const { chatFeatureForOp, hasGtmFeature } = await import('../../../lib/authorize')
    if (!(await hasGtmFeature(container, ctx, chatFeatureForOp(body.op)))) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })
    }
    const em = container.resolve('em') as EntityManager as unknown as import('../../../lib/campaign/build').CampaignEm

    const store = await import('../../../lib/chat/store')

    if (body.op === 'thread-list') {
      // Malformed workspace id -> opaque 404 (same as a missing/foreign row).
      if (!isUuid(body.workspaceId)) return opaqueNotFound()
      const rows = await store.listThreads(em, ctx, body.workspaceId)
      return NextResponse.json({
        ok: true,
        threads: rows.map((row) => store.threadShape(row)),
        cap: store.GTM_CHAT_THREAD_LIST_CAP,
      })
    }

    if (body.op === 'thread-create') {
      if (!isUuid(body.workspaceId)) return opaqueNotFound()
      const thread = await store.createThread(em, ctx, { workspaceId: body.workspaceId, title: body.title ?? null })
      return NextResponse.json({ ok: true, thread: store.threadShape(thread) })
    }

    if (body.op === 'messages') {
      if (!isUuid(body.threadId)) return opaqueNotFound()
      const rows = await store.getMessages(em, ctx, body.threadId, { limit: body.limit })
      return NextResponse.json({
        ok: true,
        messages: rows.map((row) => store.messageShape(row)),
        cap: store.GTM_CHAT_MESSAGE_READ_CAP,
      })
    }

    // append-message
    if (!isUuid(body.threadId)) return opaqueNotFound()
    const message = await store.appendMessage(em, ctx, {
      threadId: body.threadId,
      role: body.role,
      content: body.content,
      toolRef: body.toolRef ?? null,
    })
    return NextResponse.json({ ok: true, message: store.messageShape(message) })
  } catch (err) {
    if (err instanceof GtmChatError) {
      if (err.code === 'workspace_not_found' || err.code === 'thread_not_found') return opaqueNotFound()
      return NextResponse.json({ ok: false, error: err.message, code: err.code }, { status: 422 })
    }
    console.error('[internal.gtm.chat]', err)
    return NextResponse.json({ ok: false, error: 'Chat operation failed' }, { status: 500 })
  }
}
