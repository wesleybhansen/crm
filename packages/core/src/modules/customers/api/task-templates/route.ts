/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from 'zod'
import { makeCrudRoute } from '@open-mercato/shared/lib/crud/factory'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { CustomerTaskTemplate } from '../../data/entities'
import { E } from '#generated/entities.ids.generated'
import { taskTemplateCreateSchema, taskTemplateUpdateSchema } from '../../data/validators'
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
    triggerType: z.string().optional(),
    sortField: z.string().optional(),
    sortDir: z.enum(['asc', 'desc']).optional(),
  })
  .passthrough()

const routeMetadata = {
  GET: { requireAuth: true, requireFeatures: ['customers.task_templates.view'] },
  POST: { requireAuth: true, requireFeatures: ['customers.task_templates.manage'] },
  PUT: { requireAuth: true, requireFeatures: ['customers.task_templates.manage'] },
  DELETE: { requireAuth: true, requireFeatures: ['customers.task_templates.manage'] },
}

export const metadata = routeMetadata

const crud = makeCrudRoute({
  metadata: routeMetadata,
  orm: {
    entity: CustomerTaskTemplate,
    idField: 'id',
    orgField: 'organizationId',
    tenantField: 'tenantId',
    softDeleteField: 'deletedAt',
  },
  list: {
    schema: listSchema,
    entityId: E.customers.customer_task_template,
    fields: [
      'id',
      'tenant_id',
      'organization_id',
      'name',
      'description',
      'trigger_type',
      'trigger_config',
      'tasks',
      'created_at',
      'updated_at',
    ],
    sortFieldMap: {
      name: 'name',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
    buildFilters: async (query: any) => {
      const filters: Record<string, any> = {}
      if (query.triggerType) filters.trigger_type = { $eq: query.triggerType }
      return filters
    },
  },
  actions: {
    create: {
      commandId: 'customers.task_templates.create',
      schema: rawBodySchema,
      mapInput: async ({ raw, ctx }) => {
        const { translate } = await resolveTranslations()
        const scoped = withScopedPayload(raw ?? {}, ctx, translate)
        return taskTemplateCreateSchema.parse(scoped)
      },
      response: ({ result }) => withLegacyOk({ id: result?.taskTemplateId ?? null }),
      status: 201,
    },
    update: {
      commandId: 'customers.task_templates.update',
      schema: rawBodySchema,
      mapInput: async ({ raw, ctx }) => {
        const { translate } = await resolveTranslations()
        const scoped = withScopedPayload(raw ?? {}, ctx, translate)
        return taskTemplateUpdateSchema.parse(scoped)
      },
      response: () => withLegacyOk({}),
    },
    delete: {
      commandId: 'customers.task_templates.delete',
      schema: rawBodySchema,
      mapInput: async ({ parsed, ctx }) => {
        const { translate } = await resolveTranslations()
        const id =
          parsed?.body?.id ??
          parsed?.id ??
          parsed?.query?.id ??
          (ctx.request ? new URL(ctx.request.url).searchParams.get('id') : null)
        if (!id) throw new CrudHttpError(400, { error: translate('customers.errors.task_template_id_required', 'Task template id is required') })
        return { id }
      },
      response: () => withLegacyOk({}),
    },
  },
})

const { POST, PUT, DELETE } = crud
export { POST, PUT, DELETE }
export const GET = wrapCrudListForLegacyShape(crud.GET)

const taskTemplateListItemSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid().nullable().optional(),
  organization_id: z.string().uuid().nullable().optional(),
  name: z.string(),
  description: z.string().nullable().optional(),
  trigger_type: z.string().optional(),
  trigger_config: z.unknown().nullable().optional(),
  tasks: z.unknown().optional(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
})

export const openApi = createCustomersCrudOpenApi({
  resourceName: 'Task template',
  pluralName: 'Task templates',
  querySchema: listSchema,
  listResponseSchema: createPagedListResponseSchema(taskTemplateListItemSchema),
  create: {
    schema: taskTemplateCreateSchema,
    responseSchema: z.object({ id: z.string().uuid().nullable() }),
    description: 'Creates a task template that can be applied to spawn one or more tasks at once.',
  },
  update: {
    schema: taskTemplateUpdateSchema,
    responseSchema: defaultOkResponseSchema,
    description: 'Updates a task template.',
  },
  del: {
    schema: z.object({ id: z.string().uuid() }),
    responseSchema: defaultOkResponseSchema,
    description: 'Soft-deletes a task template by id.',
  },
})
