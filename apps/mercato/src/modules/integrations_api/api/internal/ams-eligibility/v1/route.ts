import crypto, { randomBytes, randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { Organization } from '@open-mercato/core/modules/directory/data/entities'
import {
  IntegrationsApiConsentVersion,
  IntegrationsApiSuppressionVersion,
} from '../../../../data/entities'
import {
  CRM_AMS_ELIGIBILITY_LEASE_V1,
  CRM_AMS_EVENT_AUDIENCE_V1,
  CRM_AMS_EVENT_ISSUER_V1,
  parseEd25519PrivateKeyV1,
  parseEd25519PublicKeysV1,
  signCrmAmsEligibilityLeaseV1,
  verifyAmsCrmCommandV1,
} from '../../../../lib/ams-crm-contract-v1'
import { evaluateCrmAmsEligibilityV1 } from '../../../../lib/ams-crm-eligibility-v1'

export const metadata = {
  path: '/internal/ams-eligibility/v1',
  POST: { requireAuth: false },
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Internal Integrations',
  summary: 'Read current CRM consent and suppression authority',
  methods: {
    POST: {
      summary: 'Return a short-lived signed eligibility lease without provider dispatch',
      tags: ['Internal Integrations'],
    },
  },
}

function unavailable() {
  return NextResponse.json(
    { ok: false, code: 'capability_unavailable', error: 'Capability unavailable' },
    { status: 503, headers: { 'Cache-Control': 'no-store, max-age=0' } },
  )
}

function authorized(request: Request): boolean {
  const secret = process.env.NOLI_INTERNAL_SERVICE_SECRET
  const got = Buffer.from((request.headers.get('authorization') || '').trim())
  const expected = Buffer.from(secret ? `Bearer ${secret}` : '')
  return Boolean(secret) && got.length === expected.length && crypto.timingSafeEqual(got, expected)
}

export async function POST(request: Request) {
  if (process.env.NOLI_CRM_AMS_ELIGIBILITY_V1_ENABLED !== 'true') return unavailable()
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const publicKeys = parseEd25519PublicKeysV1(process.env.NOLI_AMS_CRM_COMMAND_PUBLIC_KEYS_V1)
  const signingKey = parseEd25519PrivateKeyV1(process.env.NOLI_CRM_AMS_SIGNING_PRIVATE_KEY_V1)
  const signingKeyVersion = process.env.NOLI_CRM_AMS_SIGNING_KEY_VERSION_V1
  if (Object.keys(publicKeys).length === 0 || !signingKey || !signingKeyVersion) return unavailable()

  const verification = verifyAmsCrmCommandV1(await readJsonSafe<unknown>(request, null), publicKeys)
  if (!verification.ok) {
    return NextResponse.json({ ok: false, code: 'invalid_envelope', error: 'Invalid command' }, { status: 400 })
  }
  const envelope = verification.value
  const payload = envelope.payload
  if (payload.commandType !== 'eligibility.evaluate') {
    return NextResponse.json({ ok: false, code: 'invalid_envelope', error: 'Invalid command' }, { status: 400 })
  }

  try {
    const { findNoliUserById, findPrimaryOrgIdForUser, isEntitled } = await import(
      '@open-mercato/shared/lib/noli/core-client'
    )
    const noliUser = await findNoliUserById(envelope.principalRef)
    if (!noliUser?.clerk_user_id || !(await isEntitled(noliUser.id, 'crm'))) return unavailable()
    const noliOrgId = await findPrimaryOrgIdForUser(noliUser.id)
    if (noliOrgId !== envelope.sourceOrganizationId) return unavailable()

    const { resolveClerkUserToAuthContext } = await import('@open-mercato/shared/lib/auth/clerk')
    const auth = await resolveClerkUserToAuthContext(noliUser.clerk_user_id)
    if (!auth?.userId || !auth.orgId || !auth.tenantId) return unavailable()
    if (typeof auth.noliUserId === 'string' && auth.noliUserId !== noliUser.id) return unavailable()

    const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const organizationId = String(auth.orgId)
    const tenantId = String(auth.tenantId)
    const localOrganization = await em.findOne(Organization, {
      id: organizationId,
      tenant: tenantId,
      noliOrgId,
      isActive: true,
      deletedAt: null,
    })
    if (!localOrganization) return unavailable()

    const nowMs = Date.now()
    let consent: IntegrationsApiConsentVersion | null = null
    let suppression: IntegrationsApiSuppressionVersion | null = null
    let dependencyAvailable = true
    try {
      ;[consent, suppression] = await Promise.all([
        em.findOne(
          IntegrationsApiConsentVersion,
          {
            organizationId,
            tenantId,
            crmContactRef: payload.crmContactRef,
            purpose: payload.purpose,
            deletedAt: null,
          },
          { orderBy: { version: 'DESC' } },
        ),
        em.findOne(
          IntegrationsApiSuppressionVersion,
          {
            organizationId,
            tenantId,
            crmContactRef: payload.crmContactRef,
            channel: 'email',
            deletedAt: null,
          },
          { orderBy: { version: 'DESC' } },
        ),
      ])
    } catch {
      dependencyAvailable = false
    }

    const result = evaluateCrmAmsEligibilityV1({
      dependencyAvailable,
      nowMs,
      expectedConsentVersion: payload.expectedConsentVersion,
      expectedSuppressionVersion: payload.expectedSuppressionVersion,
      consent: consent
        ? {
            version: consent.version,
            state: consent.state,
            effectiveAt: consent.effectiveAt.toISOString(),
            expiresAt: consent.expiresAt?.toISOString() ?? null,
          }
        : null,
      suppression: suppression
        ? {
            version: suppression.version,
            active: suppression.active,
            effectiveAt: suppression.effectiveAt.toISOString(),
          }
        : null,
    })
    const issuedAt = new Date(nowMs).toISOString()
    const lease = signCrmAmsEligibilityLeaseV1(
      {
        contractVersion: CRM_AMS_ELIGIBILITY_LEASE_V1,
        schemaVersion: 1,
        issuer: CRM_AMS_EVENT_ISSUER_V1,
        audience: CRM_AMS_EVENT_AUDIENCE_V1,
        keyVersion: signingKeyVersion,
        leaseId: randomUUID(),
        sourceOrganizationId: envelope.sourceOrganizationId,
        crmContactRef: payload.crmContactRef,
        purpose: payload.purpose,
        consentVersion: result.consentVersion,
        suppressionVersion: result.suppressionVersion,
        eligible: result.eligible,
        denialCode: result.denialCode,
        issuedAt,
        expiresAt: new Date(nowMs + 30_000).toISOString(),
        nonce: randomBytes(24).toString('base64url'),
      },
      signingKey,
    )
    return NextResponse.json(
      { ok: true, lease, providerDispatch: false },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    )
  } catch {
    console.error('[internal.ams-eligibility.v1] eligibility_unavailable')
    return unavailable()
  }
}
