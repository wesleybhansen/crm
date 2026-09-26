import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { logCrudAccess } from '@open-mercato/shared/lib/crud/factory'
import { RoleAcl, Role } from '@open-mercato/core/modules/auth/data/entities'
import { Organization } from '@open-mercato/core/modules/directory/data/entities'
import type { EntityManager } from '@mikro-orm/postgresql'
import { resolveIsSuperAdmin } from '@open-mercato/core/modules/auth/lib/tenantAccess'
import { RbacService } from '@open-mercato/core/modules/auth/services/rbacService'

type TaggableCache = { deleteByTags?: (tags: string[]) => Promise<void> | void }

const getSchema = z.object({
  roleId: z.string().uuid(),
  tenantId: z.string().uuid().optional(),
})
const putSchema = z.object({
  roleId: z.string().uuid(),
  isSuperAdmin: z.boolean().optional(),
  features: z.array(z.string()).optional(),
  organizations: z.array(z.string()).nullable().optional(),
  tenantId: z.string().uuid().optional(),
})

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['auth.acl.manage'] },
  PUT: { requireAuth: true, requireFeatures: ['auth.acl.manage'] },
}

const roleAclResponseSchema = z.object({
  isSuperAdmin: z.boolean(),
  features: z.array(z.string()),
  organizations: z.array(z.string()).nullable(),
})

const roleAclUpdateResponseSchema = z.object({
  ok: z.literal(true),
  sanitized: z.boolean(),
})

const roleAclErrorSchema = z.object({ error: z.string() })

export async function GET(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const url = new URL(req.url)
  const parsed = getSchema.safeParse({
    roleId: url.searchParams.get('roleId'),
    tenantId: url.searchParams.get('tenantId') || undefined,
  })
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
  const container = await createRequestContainer()
  const isSuperAdmin = await resolveIsSuperAdmin({ auth, container })
  const em = container.resolve('em') as EntityManager
  const role = await em.findOne(Role, { id: parsed.data.roleId })
  if (!role) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const roleTenantId = role?.tenantId ? String(role.tenantId) : null
  const authTenantId = auth.tenantId ?? null

  let tenantScope: string | null
  if (isSuperAdmin) {
    tenantScope = parsed.data.tenantId ?? roleTenantId ?? authTenantId ?? null
  } else {
    // A customer admin reads role ACLs of its own tenant only. The role must
    // be the tenant's own (or global), and the ACL row read is always the one
    // scoped to the caller's tenant: a `tenantId` naming another tenant is
    // refused rather than read.
    if (!authTenantId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (roleTenantId && roleTenantId !== authTenantId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (parsed.data.tenantId && parsed.data.tenantId !== authTenantId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    tenantScope = authTenantId
  }

  const acl = tenantScope
    ? await em.findOne(RoleAcl, { role, tenantId: tenantScope })
    : null
  const response = acl
    ? {
        isSuperAdmin: !!acl.isSuperAdmin,
        features: Array.isArray(acl.featuresJson) ? acl.featuresJson : [],
        organizations: Array.isArray(acl.organizationsJson) ? acl.organizationsJson : null,
      }
    : { isSuperAdmin: false, features: [], organizations: null }

  await logCrudAccess({
    container,
    auth,
    request: req,
    items: [{ id: parsed.data.roleId, ...response }],
    idField: 'id',
    resourceKind: 'auth.role_acl',
    organizationId: auth.orgId ?? null,
    tenantId: tenantScope,
    query: { roleId: parsed.data.roleId, tenantId: tenantScope },
    accessType: 'read:item',
  })

  return NextResponse.json(response)
}

export async function PUT(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({}))
  const parsed = putSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
  const container = await createRequestContainer()
  const em = container.resolve('em') as EntityManager
  const rbacService = container.resolve('rbacService') as RbacService

  // One tenant per customer (CRM_TENANT_PER_CUSTOMER): a customer's admin
  // manages the role permissions of its own tenant, never another tenant's.
  // Inside its tenant it can hand out only what it holds itself: no super
  // admin flag, no feature its own ACL does not cover, no organisation from
  // another tenant. The actor's live ACL (not a token claim) decides.
  const actorAcl = auth.sub
    ? await rbacService.loadAcl(auth.sub, { tenantId: auth.tenantId ?? null, organizationId: auth.orgId ?? null })
    : null
  const actorIsSuperAdmin = !!actorAcl?.isSuperAdmin
  const authTenantId = auth.tenantId ?? null

  const role = await em.findOne(Role, { id: parsed.data.roleId })
  if (!role) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const roleTenantId = role?.tenantId ? String(role.tenantId) : null

  let targetTenantId: string | null
  if (actorIsSuperAdmin) {
    targetTenantId = parsed.data.tenantId ?? roleTenantId ?? authTenantId ?? null
  } else {
    if (!authTenantId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    // A role of another tenant is not this admin's, whatever tenant the
    // payload names. A global role's ACL row is per tenant, so the admin
    // may only write the one scoped to its own tenant.
    if (roleTenantId && roleTenantId !== authTenantId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (parsed.data.tenantId && parsed.data.tenantId !== authTenantId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    targetTenantId = authTenantId
  }
  if (!targetTenantId) return NextResponse.json({ error: 'Tenant required' }, { status: 400 })

  const requestedFeatures = normalizeFeatureList(parsed.data.features)
  let acl = await em.findOne(RoleAcl, { role, tenantId: targetTenantId })
  const existingIsSuperAdmin = !!acl?.isSuperAdmin
  const existingFeatures = normalizeFeatureList(acl?.featuresJson)
  const requestedIsSuperAdmin = parsed.data.isSuperAdmin ?? existingIsSuperAdmin

  let effectiveIsSuperAdmin = requestedIsSuperAdmin
  let effectiveFeatures = requestedFeatures
  if (!actorIsSuperAdmin) {
    // A super-admin role row grants everything to everyone holding it
    // (rbacService treats it as a platform-wide super admin), so a customer
    // admin neither creates one, keeps one switched on, nor edits one.
    if (existingIsSuperAdmin) {
      return NextResponse.json({ error: 'Only a super administrator can change a super admin role' }, { status: 403 })
    }
    if (parsed.data.isSuperAdmin === true) {
      return NextResponse.json({ error: 'Only a super administrator can mark a role as super admin' }, { status: 403 })
    }
    effectiveIsSuperAdmin = false
    effectiveFeatures = sanitizeTenantFeatures(requestedFeatures)
    // Every feature the role ends up with is either held by the actor
    // (exactly or through a wildcard such as `module.*`) or already on the
    // role: an admin can remove any permission and keep what is there, but
    // cannot grant beyond its own.
    const actorFeatures = Array.isArray(actorAcl?.features) ? actorAcl!.features : []
    const beyondActor = effectiveFeatures.filter((feature) =>
      !rbacService.hasAllFeatures([feature], actorFeatures)
      && !rbacService.hasAllFeatures([feature], existingFeatures),
    )
    if (beyondActor.length) {
      return NextResponse.json(
        { error: `You cannot grant permissions you do not have: ${beyondActor.join(', ')}` },
        { status: 403 },
      )
    }
    const organizations = parsed.data.organizations
    if (Array.isArray(organizations) && organizations.length) {
      const ids = Array.from(new Set(organizations))
      if (ids.some((id) => !UUID_PATTERN.test(id))) {
        return NextResponse.json({ error: 'Invalid organization id' }, { status: 400 })
      }
      const inTenant = await em.count(Organization, { id: { $in: ids }, tenant: targetTenantId, deletedAt: null })
      if (inTenant !== ids.length) {
        return NextResponse.json({ error: 'Organizations must belong to your own workspace' }, { status: 403 })
      }
    }
  }

  if (!acl) {
    acl = em.create(RoleAcl, {
      role,
      tenantId: targetTenantId,
      createdAt: new Date(),
      isSuperAdmin: false,
    })
  }
  if (parsed.data.organizations !== undefined) acl.organizationsJson = parsed.data.organizations
  acl.isSuperAdmin = effectiveIsSuperAdmin
  acl.featuresJson = effectiveFeatures
  await em.persistAndFlush(acl)

  // Invalidate cache for all users in this tenant since role ACL changed
  await rbacService.invalidateTenantCache(targetTenantId)
  // Sidebar nav caches depend on RBAC; invalidate tenant scope nav caches
  try {
    const cache = container.resolve('cache') as TaggableCache | undefined
    if (cache?.deleteByTags) await cache.deleteByTags([`rbac:tenant:${targetTenantId}`])
  } catch {}

  return NextResponse.json({
    ok: true,
    sanitized: !actorIsSuperAdmin && (effectiveFeatures.length !== requestedFeatures.length || effectiveIsSuperAdmin !== requestedIsSuperAdmin),
  })
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function normalizeFeatureList(features: unknown): string[] {
  if (!Array.isArray(features)) return []
  const dedup = new Set<string>()
  for (const value of features) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (!trimmed) continue
    dedup.add(trimmed)
  }
  return Array.from(dedup)
}

function sanitizeTenantFeatures(features: string[]): string[] {
  return features.filter((feature) => !isTenantRestrictedFeature(feature))
}

function isTenantRestrictedFeature(feature: string): boolean {
  if (feature === '*' || feature === 'directory.*') return true
  if (feature.startsWith('directory.tenants')) return true
  return false
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Authentication & Accounts',
  summary: 'Role ACL management',
  methods: {
    GET: {
      summary: 'Fetch role ACL',
      description: 'Returns the feature and organization assignments associated with a role within the current tenant.',
      query: getSchema,
      responses: [
        { status: 200, description: 'Role ACL entry', schema: roleAclResponseSchema },
        { status: 400, description: 'Invalid role id', schema: roleAclErrorSchema },
        { status: 401, description: 'Unauthorized', schema: roleAclErrorSchema },
        { status: 404, description: 'Role not found', schema: roleAclErrorSchema },
      ],
    },
    PUT: {
      summary: 'Update role ACL',
      description: 'Replaces the feature list, super admin flag, and optional organization assignments for a role. A non-super-admin may change only role ACLs of its own tenant, cannot set or keep the super admin flag, cannot grant a feature its own ACL does not cover (features already on the role may stay), and may only list organizations of its own tenant.',
      requestBody: {
        contentType: 'application/json',
        schema: putSchema,
      },
      responses: [
        { status: 200, description: 'Role ACL updated', schema: roleAclUpdateResponseSchema },
        { status: 400, description: 'Invalid payload', schema: roleAclErrorSchema },
        { status: 401, description: 'Unauthorized', schema: roleAclErrorSchema },
        { status: 403, description: 'Insufficient privileges to modify ACL', schema: roleAclErrorSchema },
        { status: 404, description: 'Role not found', schema: roleAclErrorSchema },
      ],
    },
  },
}
