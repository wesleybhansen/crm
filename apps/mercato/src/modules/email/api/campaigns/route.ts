/**
 * Email campaigns CRUD route.
 *
 * Replaces legacy /api/campaigns (list+create) and /api/campaigns/[id]
 * (get+update+delete). The send and test sub-routes remain on the legacy
 * paths for now (/api/campaigns/[id]/send, /api/campaigns/[id]/test)
 * because they involve complex Resend API calls and personalization.
 *
 * New URL: /api/email/campaigns
 */
import { z } from 'zod'
import { makeCrudRoute } from '@open-mercato/shared/lib/crud/factory'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { EmailCampaign } from '../../data/schema'
import { E } from '@/.mercato/generated/entities.ids.generated'
import { emailCampaignCreateSchema, emailCampaignUpdateSchema } from '../../data/validators'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { withScopedPayload } from '@open-mercato/shared/lib/api/scoped'
import { wrapCrudListForLegacyShape, withLegacyOk } from '../legacyShape'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

const rawBodySchema = z.object({}).passthrough()

const listSchema = z
  .object({
    page: z.coerce.number().min(1).default(1),
    pageSize: z.coerce.number().min(1).max(100).default(50),
    status: z.string().optional(),
    category: z.string().optional(),
    sortField: z.string().optional(),
    sortDir: z.enum(['asc', 'desc']).optional(),
  })
  .passthrough()

const routeMetadata = {
  GET: { requireAuth: true, requireFeatures: ['email.campaigns.view'] },
  POST: { requireAuth: true, requireFeatures: ['email.campaigns.manage'] },
  PUT: { requireAuth: true, requireFeatures: ['email.campaigns.manage'] },
  DELETE: { requireAuth: true, requireFeatures: ['email.campaigns.manage'] },
}

export const metadata = routeMetadata

const crud = makeCrudRoute({
  metadata: routeMetadata,
  orm: {
    entity: EmailCampaign,
    idField: 'id',
    orgField: 'organizationId',
    tenantField: 'tenantId',
    softDeleteField: 'deletedAt',
  },
  list: {
    schema: listSchema,
    entityId: E.email.email_campaign,
    fields: [
      'id',
      'tenant_id',
      'organization_id',
      'name',
      'template_id',
      'subject',
      'body_html',
      'status',
      'segment_filter',
      'category',
      'scheduled_at',
      'scheduled_for',
      'stats',
      'created_at',
      'updated_at',
      'sent_at',
    ],
    sortFieldMap: {
      name: 'name',
      status: 'status',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      sentAt: 'sent_at',
    },
    buildFilters: async (query: any) => {
      const filters: Record<string, any> = {}
      if (query.status) filters.status = { $eq: query.status }
      if (query.category) filters.category = { $eq: query.category }
      return filters
    },
  },
  actions: {
    create: {
      commandId: 'email.campaigns.create',
      schema: rawBodySchema,
      mapInput: async ({ raw, ctx }) => {
        const { translate } = await resolveTranslations()
        const scoped = withScopedPayload(raw ?? {}, ctx, translate)
        return emailCampaignCreateSchema.parse(scoped)
      },
      response: ({ result }) => ({ ok: true as const, data: { id: result?.campaignId ?? null } }),
      status: 201,
    },
    update: {
      commandId: 'email.campaigns.update',
      schema: rawBodySchema,
      mapInput: async ({ raw, ctx }) => {
        const { translate } = await resolveTranslations()
        const scoped = withScopedPayload(raw ?? {}, ctx, translate)
        return emailCampaignUpdateSchema.parse(scoped)
      },
      response: () => withLegacyOk({}),
    },
    delete: {
      commandId: 'email.campaigns.delete',
      schema: rawBodySchema,
      mapInput: async ({ parsed, ctx }) => {
        const { translate } = await resolveTranslations()
        const id =
          parsed?.body?.id ??
          parsed?.id ??
          parsed?.query?.id ??
          (ctx.request ? new URL(ctx.request.url).searchParams.get('id') : null)
        if (!id) throw new CrudHttpError(400, { error: translate('email.errors.campaign_id_required', 'Campaign id is required') })
        return { id, organizationId: ctx.organizationId, tenantId: ctx.tenantId }
      },
      response: () => withLegacyOk({}),
    },
  },
})

const { POST, PUT, DELETE } = crud
export { POST, PUT, DELETE }
export const GET = wrapCrudListForLegacyShape(crud.GET)

export const openApi: OpenApiRouteDoc = {
  summary: 'Email campaigns CRUD',
  description: 'Manage email campaigns. Send and test operations remain on legacy routes.',
  methods: {
    GET: {
      summary: 'List email campaigns',
      tags: ['Email'],
      responses: [{ status: 200, description: 'Paginated list', schema: z.object({ ok: z.literal(true), data: z.array(z.any()) }) }],
    },
    POST: {
      summary: 'Create an email campaign',
      tags: ['Email'],
      responses: [{ status: 201, description: 'Campaign created', schema: z.object({ ok: z.literal(true), data: z.object({ id: z.string().uuid() }) }) }],
    },
    PUT: {
      summary: 'Update an email campaign',
      tags: ['Email'],
      responses: [{ status: 200, description: 'Updated', schema: z.object({ ok: z.literal(true) }) }],
    },
    DELETE: {
      summary: 'Soft-delete an email campaign',
      tags: ['Email'],
      responses: [{ status: 200, description: 'Deleted', schema: z.object({ ok: z.literal(true) }) }],
    },
  },
}
