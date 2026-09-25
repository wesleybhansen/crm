import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import type { EntityManager } from '@mikro-orm/postgresql'
import { CustomerEntity } from '../../../data/entities'
import { hashForLookup } from '@open-mercato/shared/lib/encryption/aes'
import { decryptRowFields, CONTACT_ENTITY_KEY } from '@open-mercato/shared/lib/encryption/decryptRows'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

const querySchema = z.object({
  digits: z
    .string()
    .regex(/^\d{4,}$/)
    .transform((value) => value.trim()),
})

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['customers.people.view'] },
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const rawQuery: Record<string, string | null> = { digits: url.searchParams.get('digits') }
  const parse = querySchema.safeParse(rawQuery)

  if (!parse.success) {
    return NextResponse.json({ match: null })
  }

  const auth = await getAuthFromRequest(req)
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const container = await createRequestContainer()
  const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
  const em = (container.resolve('em') as EntityManager)

  const allowedOrgIds = new Set<string>()
  if (scope?.selectedId) allowedOrgIds.add(scope.selectedId)
  if (scope?.filterIds?.length) scope.filterIds.forEach((id) => allowedOrgIds.add(id))
  if (!allowedOrgIds.size && auth.orgId) allowedOrgIds.add(auth.orgId)

  if (allowedOrgIds.size === 0) {
    return NextResponse.json({ match: null })
  }

  const qb = em.createQueryBuilder(CustomerEntity, 'person')
  qb.select(['person.id', 'person.displayName', 'person.tenantId', 'person.organizationId'])
  qb.where({ kind: 'person', deletedAt: null })
  // primary_phone is encrypted at rest, so a regexp over the stored value
  // never matched an encrypted contact. Match the digits lookup hash; the
  // plaintext arm only covers legacy rows that have no hash yet.
  qb.andWhere(
    "(person.primary_phone_hash = ? or (person.primary_phone_hash is null and person.primary_phone is not null and regexp_replace(person.primary_phone, '\\D', '', 'g') = ?))",
    [hashForLookup(parse.data.digits), parse.data.digits],
  )
  if (auth.tenantId) {
    qb.andWhere({ tenantId: auth.tenantId })
  }
  qb.andWhere({ organizationId: { $in: Array.from(allowedOrgIds) } })
  qb.limit(1)

  const match = await qb.getSingleResult()
  if (!match) {
    return NextResponse.json({ match: null })
  }

  // Decrypt the name if the entity came back with its stored value (a no-op
  // when the ORM subscriber already opened it).
  const row = { display_name: match.displayName as string | null }
  await decryptRowFields(em, CONTACT_ENTITY_KEY, [row], ['display_name'], match.tenantId ?? auth.tenantId ?? null, match.organizationId ?? null)

  return NextResponse.json({
    match: {
      id: match.id,
      displayName: row.display_name,
    },
  })
}

const phoneCheckSuccessSchema = z.object({
  match: z
    .object({
      id: z.string().uuid(),
      displayName: z.string().nullable(),
    })
    .nullable(),
})

const phoneCheckErrorSchema = z.object({
  error: z.string(),
})

export const openApi: OpenApiRouteDoc = {
  tag: 'Customers',
  summary: 'Check customer phone number',
  methods: {
    GET: {
      summary: 'Find person by phone digits',
      description: 'Performs an exact digits comparison (stripping non-numeric characters) to determine whether a customer contact matches the provided phone fragment.',
      query: querySchema,
      responses: [
        { status: 200, description: 'Matching contact (if any)', schema: phoneCheckSuccessSchema },
        { status: 401, description: 'Unauthorized', schema: phoneCheckErrorSchema },
      ],
    },
  },
}
