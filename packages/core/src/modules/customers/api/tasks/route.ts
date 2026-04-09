/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from 'zod'
import { makeCrudRoute } from '@open-mercato/shared/lib/crud/factory'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { CustomerTask } from '../../data/entities'
import { E } from '#generated/entities.ids.generated'
import { taskCreateSchema, taskUpdateSchema } from '../../data/validators'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { withScopedPayload } from '../utils'
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
    contactId: z.string().uuid().optional(),
    dealId: z.string().uuid().optional(),
    done: z.string().optional(),
    sortField: z.string().optional(),
    sortDir: z.enum(['asc', 'desc']).optional(),
  })
  .passthrough()

const routeMetadata = {
  GET: { requireAuth: true, requireFeatures: ['customers.tasks.view'] },
  POST: { requireAuth: true, requireFeatures: ['customers.tasks.manage'] },
  PUT: { requireAuth: true, requireFeatures: ['customers.tasks.manage'] },
  DELETE: { requireAuth: true, requireFeatures: ['customers.tasks.manage'] },
}

export const metadata = routeMetadata

const crud = makeCrudRoute({
  metadata: routeMetadata,
  orm: {
    entity: CustomerTask,
    idField: 'id',
    orgField: 'organizationId',
    tenantField: 'tenantId',
    softDeleteField: 'deletedAt',
  },
  list: {
    schema: listSchema,
    entityId: E.customers.customer_task,
    fields: [
      'id',
      'tenant_id',
      'organization_id',
      'title',
      'description',
      'contact_id',
      'deal_id',
      'due_date',
      'is_done',
      'completed_at',
      'created_at',
      'updated_at',
    ],
    sortFieldMap: {
      title: 'title',
      dueDate: 'due_date',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
    buildFilters: async (query: any) => {
      const filters: Record<string, any> = {}
      if (query.contactId) filters.contact_id = { $eq: query.contactId }
      if (query.dealId) filters.deal_id = { $eq: query.dealId }
      const showDone = query.done === 'true' || query.done === true
      if (!showDone) filters.is_done = { $eq: false }
      return filters
    },
  },
  actions: {
    create: {
      commandId: 'customers.tasks.create',
      schema: rawBodySchema,
      mapInput: async ({ raw, ctx }) => {
        const { translate } = await resolveTranslations()
        const scoped = withScopedPayload(raw ?? {}, ctx, translate)
        return taskCreateSchema.parse(scoped)
      },
      response: ({ result }) => ({ id: result?.taskId ?? null }),
      status: 201,
    },
    update: {
      commandId: 'customers.tasks.update',
      schema: rawBodySchema,
      mapInput: async ({ raw, ctx }) => {
        const { translate } = await resolveTranslations()
        const scoped = withScopedPayload(raw ?? {}, ctx, translate)
        return taskUpdateSchema.parse(scoped)
      },
      response: () => ({ ok: true }),
    },
    delete: {
      commandId: 'customers.tasks.delete',
      schema: rawBodySchema,
      mapInput: async ({ parsed, ctx }) => {
        const { translate } = await resolveTranslations()
        const id =
          parsed?.body?.id ??
          parsed?.id ??
          parsed?.query?.id ??
          (ctx.request ? new URL(ctx.request.url).searchParams.get('id') : null)
        if (!id) throw new CrudHttpError(400, { error: translate('customers.errors.task_id_required', 'Task id is required') })
        return { id }
      },
      response: () => ({ ok: true }),
    },
  },
})

const { POST, PUT, DELETE } = crud
export { POST, PUT, DELETE }
export const GET = crud.GET

const taskListItemSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid().nullable().optional(),
  organization_id: z.string().uuid().nullable().optional(),
  title: z.string(),
  description: z.string().nullable().optional(),
  contact_id: z.string().uuid().nullable().optional(),
  deal_id: z.string().uuid().nullable().optional(),
  due_date: z.string().nullable().optional(),
  is_done: z.boolean().optional(),
  completed_at: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
})

export const openApi = createCustomersCrudOpenApi({
  resourceName: 'Task',
  pluralName: 'Tasks',
  querySchema: listSchema,
  listResponseSchema: createPagedListResponseSchema(taskListItemSchema),
  create: {
    schema: taskCreateSchema,
    responseSchema: z.object({ id: z.string().uuid().nullable() }),
    description: 'Creates a CRM task linked to a contact or deal.',
  },
  update: {
    schema: taskUpdateSchema,
    responseSchema: defaultOkResponseSchema,
    description: 'Updates a task. Setting is_done=true marks completed_at automatically.',
  },
  del: {
    schema: z.object({ id: z.string().uuid() }),
    responseSchema: defaultOkResponseSchema,
    description: 'Soft-deletes a task by id.',
  },
})
