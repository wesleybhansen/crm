/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Email lists CRUD route — tier 1 pilot of the mercato route migration.
 *
 * This is the first email module route migrated from raw knex to mercato
 * with the legacyShape compat wrappers. New URL: /api/email/lists.
 * Old URL: /api/email-lists (still works during the cutover; can be deleted
 * once frontend has been updated to call the new URL).
 *
 * Pattern reference: packages/core/src/modules/customers/api/tasks/route.ts
 *
 * The route preserves the OLD response shape via wrapCrudListForLegacyShape
 * + withLegacyOk so the frontend doesn't need data extraction changes —
 * only URL substitution.
 */

import { z } from 'zod'
import { makeCrudRoute } from '@open-mercato/shared/lib/crud/factory'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { EmailList } from '../../data/schema'
import { E } from '#generated/entities.ids.generated'
import { emailListCreateSchema, emailListUpdateSchema } from '../../data/validators'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { withScopedPayload } from '@open-mercato/shared/lib/api/scoped'
import { wrapCrudListForLegacyShape, withLegacyOk } from '../legacyShape'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

const rawBodySchema = z.object({}).passthrough()

const listSchema = z
  .object({
    page: z.coerce.number().min(1).default(1),
    pageSize: z.coerce.number().min(1).max(100).default(50),
    sourceType: z.string().optional(),
    sortField: z.string().optional(),
    sortDir: z.enum(['asc', 'desc']).optional(),
  })
  .passthrough()

const routeMetadata = {
  GET: { requireAuth: true, requireFeatures: ['email.lists.view'] },
  POST: { requireAuth: true, requireFeatures: ['email.lists.manage'] },
  PUT: { requireAuth: true, requireFeatures: ['email.lists.manage'] },
  DELETE: { requireAuth: true, requireFeatures: ['email.lists.manage'] },
}

export const metadata = routeMetadata

const crud = makeCrudRoute({
  metadata: routeMetadata,
  orm: {
    entity: EmailList,
    idField: 'id',
    orgField: 'organizationId',
    tenantField: 'tenantId',
    softDeleteField: 'deletedAt',
  },
  list: {
    schema: listSchema,
    entityId: E.email.email_list,
    fields: [
      'id',
      'tenant_id',
      'organization_id',
      'name',
      'description',
      'source_type',
      'source_id',
      'member_count',
      'created_at',
      'updated_at',
    ],
    sortFieldMap: {
      name: 'name',
      memberCount: 'member_count',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
    buildFilters: async (query: any) => {
      const filters: Record<string, any> = {}
      if (query.sourceType) filters.source_type = { $eq: query.sourceType }
      return filters
    },
  },
  actions: {
    create: {
      commandId: 'email.lists.create',
      schema: rawBodySchema,
      mapInput: async ({ raw, ctx }) => {
        const { translate } = await resolveTranslations()
        const scoped = withScopedPayload(raw ?? {}, ctx, translate)
        return emailListCreateSchema.parse(scoped)
      },
      response: ({ result }) => withLegacyOk({ id: result?.listId ?? null }),
      status: 201,
    },
    update: {
      commandId: 'email.lists.update',
      schema: rawBodySchema,
      mapInput: async ({ raw, ctx }) => {
        const { translate } = await resolveTranslations()
        const scoped = withScopedPayload(raw ?? {}, ctx, translate)
        return emailListUpdateSchema.parse(scoped)
      },
      response: () => withLegacyOk({}),
    },
    delete: {
      commandId: 'email.lists.delete',
      schema: rawBodySchema,
      mapInput: async ({ parsed, ctx }) => {
        const { translate } = await resolveTranslations()
        const id =
          parsed?.body?.id ??
          parsed?.id ??
          parsed?.query?.id ??
          (ctx.request ? new URL(ctx.request.url).searchParams.get('id') : null)
        if (!id) throw new CrudHttpError(400, { error: translate('email.errors.list_id_required', 'Email list id is required') })
        return { id }
      },
      response: () => withLegacyOk({}),
    },
  },
})

const { POST, PUT, DELETE } = crud
export { POST, PUT, DELETE }
export const GET = wrapCrudListForLegacyShape(crud.GET)

const emailListItemSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid().nullable().optional(),
  organization_id: z.string().uuid().nullable().optional(),
  name: z.string(),
  description: z.string().nullable().optional(),
  source_type: z.string().optional(),
  source_id: z.string().uuid().nullable().optional(),
  member_count: z.number().int().optional(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
})

const legacyListResponseSchema = z.object({
  ok: z.literal(true),
  data: z.array(emailListItemSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  totalPages: z.number().int(),
})

const legacyOkResponseSchema = z.object({
  ok: z.literal(true),
  id: z.string().uuid().nullable().optional(),
})

const legacyErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
})

export const openApi: OpenApiRouteDoc = {
  summary: 'Email lists CRUD',
  description: 'Manage mailing lists / contact groups for email campaigns. Backwards-compatible legacy response shape.',
  methods: {
    GET: {
      summary: 'List email lists',
      tags: ['Email'],
      responses: [
        { status: 200, description: 'Paginated list', schema: legacyListResponseSchema },
      ],
      errors: [
        { status: 401, description: 'Unauthorized', schema: legacyErrorSchema },
      ],
    },
    POST: {
      summary: 'Create an email list',
      tags: ['Email'],
      requestBody: {
        contentType: 'application/json',
        schema: emailListCreateSchema.omit({ tenantId: true, organizationId: true }),
        description: 'Email list payload (tenant and organization derived from auth context).',
      },
      responses: [
        { status: 201, description: 'List created', schema: legacyOkResponseSchema },
      ],
      errors: [
        { status: 400, description: 'Validation failed', schema: legacyErrorSchema },
      ],
    },
    PUT: {
      summary: 'Update an email list',
      tags: ['Email'],
      requestBody: {
        contentType: 'application/json',
        schema: emailListUpdateSchema,
      },
      responses: [
        { status: 200, description: 'List updated', schema: z.object({ ok: z.literal(true) }) },
      ],
    },
    DELETE: {
      summary: 'Soft-delete an email list',
      tags: ['Email'],
      responses: [
        { status: 200, description: 'List deleted', schema: z.object({ ok: z.literal(true) }) },
      ],
    },
  },
}
