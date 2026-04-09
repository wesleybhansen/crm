/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from 'zod'
import { makeCrudRoute } from '@open-mercato/shared/lib/crud/factory'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { CustomerReminder } from '../../data/entities'
import { E } from '#generated/entities.ids.generated'
import { reminderCreateSchema, reminderUpdateSchema } from '../../data/validators'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { withScopedPayload } from '../utils'
import { wrapCrudListForLegacyShape, withLegacyOk } from '../legacyShape'
import {
  createCustomersCrudOpenApi,
  createPagedListResponseSchema,
  defaultOkResponseSchema,
} from '../openapi'

const rawBodySchema = z.object({}).passthrough()

const listSchema = z
  .object({
    page: z.coerce.number().min(1).default(1),
    pageSize: z.coerce.number().min(1).max(100).default(50),
    userId: z.string().uuid().optional(),
    entityType: z.enum(['contact', 'deal', 'task']).optional(),
    entityId: z.string().uuid().optional(),
    sent: z.string().optional(),
    sortField: z.string().optional(),
    sortDir: z.enum(['asc', 'desc']).optional(),
  })
  .passthrough()

const routeMetadata = {
  GET: { requireAuth: true, requireFeatures: ['customers.reminders.view'] },
  POST: { requireAuth: true, requireFeatures: ['customers.reminders.manage'] },
  PUT: { requireAuth: true, requireFeatures: ['customers.reminders.manage'] },
  DELETE: { requireAuth: true, requireFeatures: ['customers.reminders.manage'] },
}

export const metadata = routeMetadata

const crud = makeCrudRoute({
  metadata: routeMetadata,
  orm: {
    entity: CustomerReminder,
    idField: 'id',
    orgField: 'organizationId',
    tenantField: 'tenantId',
    softDeleteField: 'deletedAt',
  },
  list: {
    schema: listSchema,
    entityId: E.customers.customer_reminder,
    fields: [
      'id',
      'tenant_id',
      'organization_id',
      'user_id',
      'entity_type',
      'entity_id',
      'message',
      'remind_at',
      'sent',
      'sent_at',
      'created_at',
      'updated_at',
    ],
    sortFieldMap: {
      remindAt: 'remind_at',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
    buildFilters: async (query: any) => {
      const filters: Record<string, any> = {}
      if (query.userId) filters.user_id = { $eq: query.userId }
      if (query.entityType) filters.entity_type = { $eq: query.entityType }
      if (query.entityId) filters.entity_id = { $eq: query.entityId }
      if (query.sent === 'true') filters.sent = { $eq: true }
      else if (query.sent === 'false') filters.sent = { $eq: false }
      return filters
    },
  },
  actions: {
    create: {
      commandId: 'customers.reminders.create',
      schema: rawBodySchema,
      mapInput: async ({ raw, ctx }) => {
        const { translate } = await resolveTranslations()
        const scoped = withScopedPayload(raw ?? {}, ctx, translate)
        return reminderCreateSchema.parse(scoped)
      },
      response: ({ result }) => withLegacyOk({ id: result?.reminderId ?? null }),
      status: 201,
    },
    update: {
      commandId: 'customers.reminders.update',
      schema: rawBodySchema,
      mapInput: async ({ raw, ctx }) => {
        const { translate } = await resolveTranslations()
        const scoped = withScopedPayload(raw ?? {}, ctx, translate)
        return reminderUpdateSchema.parse(scoped)
      },
      response: () => withLegacyOk({}),
    },
    delete: {
      commandId: 'customers.reminders.delete',
      schema: rawBodySchema,
      mapInput: async ({ parsed, ctx }) => {
        const { translate } = await resolveTranslations()
        const id =
          parsed?.body?.id ??
          parsed?.id ??
          parsed?.query?.id ??
          (ctx.request ? new URL(ctx.request.url).searchParams.get('id') : null)
        if (!id) throw new CrudHttpError(400, { error: translate('customers.errors.reminder_id_required', 'Reminder id is required') })
        return { id }
      },
      response: () => withLegacyOk({}),
    },
  },
})

const { POST, PUT, DELETE } = crud
export { POST, PUT, DELETE }
export const GET = wrapCrudListForLegacyShape(crud.GET)

const reminderListItemSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid().nullable().optional(),
  organization_id: z.string().uuid().nullable().optional(),
  user_id: z.string().uuid(),
  entity_type: z.string(),
  entity_id: z.string().uuid(),
  message: z.string(),
  remind_at: z.string().nullable().optional(),
  sent: z.boolean().optional(),
  sent_at: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
})

export const openApi = createCustomersCrudOpenApi({
  resourceName: 'Reminder',
  pluralName: 'Reminders',
  querySchema: listSchema,
  listResponseSchema: createPagedListResponseSchema(reminderListItemSchema),
  create: {
    schema: reminderCreateSchema,
    responseSchema: z.object({ id: z.string().uuid().nullable() }),
    description: 'Creates a polymorphic reminder against a contact, deal, or task. Processed by the reminders cron worker.',
  },
  update: {
    schema: reminderUpdateSchema,
    responseSchema: defaultOkResponseSchema,
    description: 'Updates an existing reminder.',
  },
  del: {
    schema: z.object({ id: z.string().uuid() }),
    responseSchema: defaultOkResponseSchema,
    description: 'Soft-deletes a reminder by id.',
  },
})
