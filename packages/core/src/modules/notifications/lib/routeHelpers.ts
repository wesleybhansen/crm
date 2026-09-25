import { z } from 'zod'
import { resolveRequestContext } from '@open-mercato/shared/lib/api/context'
import type { EntityManager } from '@mikro-orm/postgresql'
import { resolveNotificationService, type NotificationService } from './notificationService'
import { resolveOrganizationScopeForRequest } from '../../directory/utils/organizationScope'
import { User } from '../../auth/data/entities'

/**
 * Every Noli customer shares one tenant. A caller that may create
 * notifications for others must stay inside its own organization scope:
 * every explicit recipient has to be a member of an organization the caller
 * manages. Super admins (unrestricted scope) are exempt.
 */
export async function assertRecipientsInActorScope(
  req: Request,
  ctx: NotificationRequestContext['ctx'],
  recipientUserIds: string[],
): Promise<void> {
  const ids = Array.from(new Set(recipientUserIds.filter(Boolean)))
  if (!ids.length || !ctx.auth) return
  const scope = await resolveOrganizationScopeForRequest({ container: ctx.container, auth: ctx.auth, request: req })
  if (scope.allowedIds === null) return
  const allowed = new Set(scope.allowedIds)
  const em = ctx.container.resolve('em') as EntityManager
  const users = await em.find(User, { id: { $in: ids }, tenantId: ctx.auth.tenantId ?? null, deletedAt: null })
  const inScope = users.filter((user) => user.organizationId && allowed.has(String(user.organizationId)))
  if (inScope.length !== ids.length) {
    throw new NotificationScopeError()
  }
}

export class NotificationScopeError extends Error {
  status = 403
  constructor() {
    super('Recipient belongs to another organization')
  }
}

function scopeErrorResponse(err: unknown): Response | null {
  if (err instanceof NotificationScopeError) {
    return Response.json({ error: err.message }, { status: 403 })
  }
  return null
}

/**
 * Notification scope context for service calls
 */
export interface NotificationScope {
  tenantId: string
  organizationId: string | null
  userId: string | null
}

/**
 * Resolved notification context from a request
 */
export interface NotificationRequestContext {
  service: NotificationService
  scope: NotificationScope
  ctx: Awaited<ReturnType<typeof resolveRequestContext>>['ctx']
}

/**
 * Resolve notification service and scope from a request.
 * Centralizes the common pattern used across all notification API routes.
 */
export async function resolveNotificationContext(req: Request): Promise<NotificationRequestContext> {
  const { ctx } = await resolveRequestContext(req)
  return {
    service: resolveNotificationService(ctx.container),
    scope: {
      tenantId: ctx.auth?.tenantId ?? '',
      organizationId: ctx.selectedOrganizationId ?? null,
      userId: ctx.auth?.sub ?? null,
    },
    ctx,
  }
}

/**
 * Create a POST handler for bulk notification creation routes.
 * Used by batch, role, and feature notification endpoints.
 */
export function createBulkNotificationRoute<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  serviceMethod: 'createBatch' | 'createForRole' | 'createForFeature'
) {
  return async function POST(req: Request) {
    const { service, scope, ctx } = await resolveNotificationContext(req)

    const body = await req.json().catch(() => ({}))
    const input = schema.parse(body)

    // Role and feature fan-out is confined to the caller's own organization;
    // an explicit batch may only name recipients inside the caller's scope.
    const effectiveScope = serviceMethod === 'createBatch'
      ? scope
      : { ...scope, organizationId: scope.organizationId ?? ctx.auth?.orgId ?? null }
    if (serviceMethod === 'createBatch') {
      const recipientUserIds = (input as { recipientUserIds?: unknown }).recipientUserIds
      try {
        await assertRecipientsInActorScope(req, ctx, Array.isArray(recipientUserIds) ? recipientUserIds.map(String) : [])
      } catch (err) {
        const res = scopeErrorResponse(err)
        if (res) return res
        throw err
      }
    }

    const notifications = await service[serviceMethod](input as never, effectiveScope)

    return Response.json({
      ok: true,
      count: notifications.length,
      ids: notifications.map((n) => n.id),
    }, { status: 201 })
  }
}

/**
 * Create OpenAPI spec for bulk notification creation routes.
 */
export function createBulkNotificationOpenApi<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  summary: string,
  description?: string
) {
  return {
    POST: {
      summary,
      description,
      tags: ['Notifications'],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema,
          },
        },
      },
      responses: {
        201: {
          description: 'Notifications created',
          content: {
            'application/json': {
              schema: z.object({
                ok: z.boolean(),
                count: z.number(),
                ids: z.array(z.string().uuid()),
              }),
            },
          },
        },
      },
    },
  }
}

/**
 * Create a PUT handler for single notification action routes.
 * Used by read and dismiss endpoints.
 */
export function createSingleNotificationActionRoute(
  serviceMethod: 'markAsRead' | 'dismiss'
) {
  return async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params
    const { service, scope } = await resolveNotificationContext(req)

    await service[serviceMethod](id, scope)

    return Response.json({ ok: true })
  }
}

/**
 * Create OpenAPI spec for single notification action routes.
 */
export function createSingleNotificationActionOpenApi(
  summary: string,
  description: string
) {
  return {
    PUT: {
      summary,
      tags: ['Notifications'],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        200: {
          description,
          content: {
            'application/json': {
              schema: z.object({ ok: z.boolean() }),
            },
          },
        },
      },
    },
  }
}
