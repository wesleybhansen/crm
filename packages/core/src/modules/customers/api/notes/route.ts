/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from 'zod'
import { makeCrudRoute } from '@open-mercato/shared/lib/crud/factory'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { CustomerContactNote } from '../../data/entities'
import { E } from '#generated/entities.ids.generated'
import { contactNoteCreateSchema, contactNoteUpdateSchema } from '../../data/validators'
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
    contactId: z.string().uuid().optional(),
    sortField: z.string().optional(),
    sortDir: z.enum(['asc', 'desc']).optional(),
  })
  .passthrough()

const routeMetadata = {
  GET: { requireAuth: true, requireFeatures: ['customers.notes.view'] },
  POST: { requireAuth: true, requireFeatures: ['customers.notes.manage'] },
  PUT: { requireAuth: true, requireFeatures: ['customers.notes.manage'] },
  DELETE: { requireAuth: true, requireFeatures: ['customers.notes.manage'] },
}

export const metadata = routeMetadata

const crud = makeCrudRoute({
  metadata: routeMetadata,
  orm: {
    entity: CustomerContactNote,
    idField: 'id',
    orgField: 'organizationId',
    tenantField: 'tenantId',
    softDeleteField: 'deletedAt',
  },
  list: {
    schema: listSchema,
    entityId: E.customers.customer_contact_note,
    fields: [
      'id',
      'tenant_id',
      'organization_id',
      'contact_id',
      'content',
      'author_user_id',
      'created_at',
      'updated_at',
    ],
    sortFieldMap: {
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
    buildFilters: async (query: any) => {
      const filters: Record<string, any> = {}
      if (query.contactId) filters.contact_id = { $eq: query.contactId }
      return filters
    },
  },
  actions: {
    create: {
      commandId: 'customers.notes.create',
      schema: rawBodySchema,
      mapInput: async ({ raw, ctx }) => {
        const { translate } = await resolveTranslations()
        const scoped = withScopedPayload(raw ?? {}, ctx, translate)
        return contactNoteCreateSchema.parse(scoped)
      },
      response: ({ result }) => withLegacyOk({ id: result?.noteId ?? null }),
      status: 201,
    },
    update: {
      commandId: 'customers.notes.update',
      schema: rawBodySchema,
      mapInput: async ({ raw, ctx }) => {
        const { translate } = await resolveTranslations()
        const scoped = withScopedPayload(raw ?? {}, ctx, translate)
        return contactNoteUpdateSchema.parse(scoped)
      },
      response: () => withLegacyOk({}),
    },
    delete: {
      commandId: 'customers.notes.delete',
      schema: rawBodySchema,
      mapInput: async ({ parsed, ctx }) => {
        const { translate } = await resolveTranslations()
        const id =
          parsed?.body?.id ??
          parsed?.id ??
          parsed?.query?.id ??
          (ctx.request ? new URL(ctx.request.url).searchParams.get('id') : null)
        if (!id) throw new CrudHttpError(400, { error: translate('customers.errors.note_id_required', 'Note id is required') })
        return { id }
      },
      response: () => withLegacyOk({}),
    },
  },
})

const { POST, PUT, DELETE } = crud
export { POST, PUT, DELETE }
export const GET = wrapCrudListForLegacyShape(crud.GET)

const noteListItemSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid().nullable().optional(),
  organization_id: z.string().uuid().nullable().optional(),
  contact_id: z.string().uuid(),
  content: z.string(),
  author_user_id: z.string().uuid().nullable().optional(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
})

export const openApi = createCustomersCrudOpenApi({
  resourceName: 'Contact note',
  pluralName: 'Contact notes',
  querySchema: listSchema,
  listResponseSchema: createPagedListResponseSchema(noteListItemSchema),
  create: {
    schema: contactNoteCreateSchema,
    responseSchema: z.object({ id: z.string().uuid().nullable() }),
    description: 'Creates a free-form note attached to a contact.',
  },
  update: {
    schema: contactNoteUpdateSchema,
    responseSchema: defaultOkResponseSchema,
    description: 'Updates the content of an existing contact note.',
  },
  del: {
    schema: z.object({ id: z.string().uuid() }),
    responseSchema: defaultOkResponseSchema,
    description: 'Soft-deletes a contact note by id.',
  },
})
