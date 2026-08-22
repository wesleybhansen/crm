import crypto from 'node:crypto'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AwilixContainer } from 'awilix'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import {
  runCrudMutationGuardAfterSuccess,
  validateCrudMutationGuard,
} from '@open-mercato/shared/lib/crud/mutation-guard'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { Organization } from '@open-mercato/core/modules/directory/data/entities'
import {
  AMS_CRM_SHADOW_ACCEPT_COMMAND_V1,
  AmsCrmShadowCommandConflict,
  type AmsCrmShadowCommandResultV1,
} from '../../../../commands/ams-crm'
import {
  commandCanonicalHashV1,
  parseEd25519PublicKeysV1,
  verifyAmsCrmCommandV1,
} from '../../../../lib/ams-crm-contract-v1'

export const metadata = {
  path: '/internal/ams-commands/v1',
  POST: { requireAuth: false },
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Internal Integrations',
  summary: 'Validate and persist a signed AMS CRM command in dark shadow mode',
  methods: {
    POST: {
      summary: 'Persist privacy-minimal replay metadata without contact mutation or provider dispatch',
      tags: ['Internal Integrations'],
    },
  },
}

function unavailable() {
  return NextResponse.json(
    { ok: false, code: 'capability_unavailable', error: 'Capability unavailable' },
    { status: 503, headers: { 'Cache-Control': 'no-store, max-age=0' } },
  )
}

function authorized(request: Request): boolean {
  const secret = process.env.NOLI_INTERNAL_SERVICE_SECRET
  const got = Buffer.from((request.headers.get('authorization') || '').trim())
  const expected = Buffer.from(secret ? `Bearer ${secret}` : '')
  return Boolean(secret) && got.length === expected.length && crypto.timingSafeEqual(got, expected)
}

export async function POST(request: Request) {
  if (process.env.NOLI_AMS_CRM_COMMAND_SHADOW_V1_ENABLED !== 'true') return unavailable()
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const publicKeys = parseEd25519PublicKeysV1(process.env.NOLI_AMS_CRM_COMMAND_PUBLIC_KEYS_V1)
  if (Object.keys(publicKeys).length === 0) return unavailable()
  const verification = verifyAmsCrmCommandV1(await readJsonSafe<unknown>(request, null), publicKeys)
  if (!verification.ok) {
    return NextResponse.json({ ok: false, code: verification.code, error: 'Invalid command' }, { status: 400 })
  }
  const envelope = verification.value

  try {
    const { findNoliUserById, findPrimaryOrgIdForUser, isEntitled } = await import(
      '@open-mercato/shared/lib/noli/core-client'
    )
    const noliUser = await findNoliUserById(envelope.principalRef)
    if (!noliUser?.clerk_user_id || !(await isEntitled(noliUser.id, 'crm'))) return unavailable()
    const noliOrgId = await findPrimaryOrgIdForUser(noliUser.id)
    if (noliOrgId !== envelope.sourceOrganizationId) return unavailable()

    const { resolveClerkUserToAuthContext } = await import('@open-mercato/shared/lib/auth/clerk')
    const auth = await resolveClerkUserToAuthContext(noliUser.clerk_user_id)
    if (!auth?.userId || !auth.orgId || !auth.tenantId) return unavailable()
    if (typeof auth.noliUserId === 'string' && auth.noliUserId !== noliUser.id) return unavailable()

    const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const localOrganization = await em.findOne(Organization, {
      id: String(auth.orgId),
      tenant: String(auth.tenantId),
      noliOrgId,
      isActive: true,
      deletedAt: null,
    })
    if (!localOrganization) return unavailable()

    const guardInput = {
      tenantId: String(auth.tenantId),
      organizationId: String(auth.orgId),
      userId: String(auth.userId),
      resourceKind: 'integrations_api.ams_command',
      resourceId: envelope.commandId,
      operation: 'custom' as const,
      requestMethod: request.method,
      requestHeaders: request.headers,
      mutationPayload: {
        commandType: envelope.payload.commandType,
        commandRef: envelope.payload.commandRef,
        canonicalHash: commandCanonicalHashV1(envelope),
      },
    }
    const guard = await validateCrudMutationGuard(container as AwilixContainer, guardInput)
    if (guard && !guard.ok) return NextResponse.json(guard.body, { status: guard.status })

    const commandBus = container.resolve('commandBus') as CommandBus
    const executed = await commandBus.execute<
      { organizationId: string; tenantId: string; envelope: typeof envelope },
      AmsCrmShadowCommandResultV1
    >(AMS_CRM_SHADOW_ACCEPT_COMMAND_V1, {
      input: {
        organizationId: String(auth.orgId),
        tenantId: String(auth.tenantId),
        envelope,
      },
      ctx: {
        container,
        auth,
        organizationScope: null,
        selectedOrganizationId: String(auth.orgId),
        organizationIds: [String(auth.orgId)],
        request,
      },
      metadata: {
        tenantId: String(auth.tenantId),
        organizationId: String(auth.orgId),
        actorUserId: String(auth.userId),
        resourceKind: 'integrations_api.ams_command',
        resourceId: envelope.commandId,
      },
    })

    if (guard?.ok && guard.shouldRunAfterSuccess && executed.result.action === 'inserted') {
      await runCrudMutationGuardAfterSuccess(container as AwilixContainer, {
        ...guardInput,
        metadata: guard.metadata,
      })
    }
    return NextResponse.json(
      { ok: true, ...executed.result, providerDispatch: false },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    )
  } catch (error) {
    if (error instanceof AmsCrmShadowCommandConflict) {
      return NextResponse.json({ ok: false, code: error.code, error: 'Command conflict' }, { status: 409 })
    }
    console.error('[internal.ams-commands.v1] command_unavailable')
    return unavailable()
  }
}
