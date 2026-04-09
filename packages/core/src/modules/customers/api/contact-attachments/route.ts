/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from 'zod'
import { makeCrudRoute } from '@open-mercato/shared/lib/crud/factory'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { CustomerContactAttachment } from '../../data/entities'
import { E } from '#generated/entities.ids.generated'
import { contactAttachmentCreateSchema } from '../../data/validators'
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
    sortField: z.string().optional(),
    sortDir: z.enum(['asc', 'desc']).optional(),
  })
  .passthrough()

const routeMetadata = {
  GET: { requireAuth: true, requireFeatures: ['customers.attachments.view'] },
  POST: { requireAuth: true, requireFeatures: ['customers.attachments.manage'] },
  DELETE: { requireAuth: true, requireFeatures: ['customers.attachments.manage'] },
}

export const metadata = routeMetadata

const crud = makeCrudRoute({
  metadata: routeMetadata,
  orm: {
    entity: CustomerContactAttachment,
    idField: 'id',
    orgField: 'organizationId',
    tenantField: 'tenantId',
    softDeleteField: 'deletedAt',
  },
  list: {
    schema: listSchema,
    entityId: E.customers.customer_contact_attachment,
    fields: [
      'id',
      'tenant_id',
      'organization_id',
      'contact_id',
      'filename',
      'file_url',
      'file_size',
      'mime_type',
      'uploaded_by',
      'created_at',
      'updated_at',
    ],
    sortFieldMap: {
      filename: 'filename',
      createdAt: 'created_at',
    },
    buildFilters: async (query: any) => {
      const filters: Record<string, any> = {}
      if (query.contactId) filters.contact_id = { $eq: query.contactId }
      return filters
    },
  },
  actions: {
    create: {
      commandId: 'customers.attachments.create',
      schema: rawBodySchema,
      mapInput: async ({ raw, ctx }) => {
        const { translate } = await resolveTranslations()
        const scoped = withScopedPayload(raw ?? {}, ctx, translate)
        return contactAttachmentCreateSchema.parse(scoped)
      },
      response: ({ result }) => ({ id: result?.attachmentId ?? null }),
      status: 201,
    },
    delete: {
      commandId: 'customers.attachments.delete',
      schema: rawBodySchema,
      mapInput: async ({ parsed, ctx }) => {
        const { translate } = await resolveTranslations()
        const id =
          parsed?.body?.id ??
          parsed?.id ??
          parsed?.query?.id ??
          (ctx.request ? new URL(ctx.request.url).searchParams.get('id') : null)
        if (!id) throw new CrudHttpError(400, { error: translate('customers.errors.attachment_id_required', 'Attachment id is required') })
        return { id }
      },
      response: () => ({ ok: true }),
    },
  },
})

const { POST, DELETE } = crud
export { POST, DELETE }
export const GET = crud.GET

const attachmentListItemSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid().nullable().optional(),
  organization_id: z.string().uuid().nullable().optional(),
  contact_id: z.string().uuid(),
  filename: z.string(),
  file_url: z.string(),
  file_size: z.number().int().optional(),
  mime_type: z.string().nullable().optional(),
  uploaded_by: z.string().uuid().nullable().optional(),
  created_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
})

export const openApi = createCustomersCrudOpenApi({
  resourceName: 'Contact attachment',
  pluralName: 'Contact attachments',
  querySchema: listSchema,
  listResponseSchema: createPagedListResponseSchema(attachmentListItemSchema),
  create: {
    schema: contactAttachmentCreateSchema,
    responseSchema: z.object({ id: z.string().uuid().nullable() }),
    description: 'Creates a contact attachment record. Files themselves are uploaded out-of-band.',
  },
  del: {
    schema: z.object({ id: z.string().uuid() }),
    responseSchema: defaultOkResponseSchema,
    description: 'Soft-deletes a contact attachment by id. Filesystem cleanup is handled separately.',
  },
})
