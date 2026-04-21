// ORM-SKIP: complex multi-table logic or public/webhook endpoint
export const metadata = { path: '/pipeline/contact-detail', GET: { requireAuth: true } }
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { TenantDataEncryptionService } from '@open-mercato/shared/lib/encryption/tenantDataEncryptionService'
import { isTenantDataEncryptionEnabled } from '@open-mercato/shared/lib/encryption/toggles'
import { createKmsService } from '@open-mercato/shared/lib/encryption/kms'

export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const url = new URL(req.url)
  const contactId = url.searchParams.get('id')
  if (!contactId) return NextResponse.json({ ok: false, error: 'Missing id' }, { status: 400 })

  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()

    // Get contact entity
    const entity = await knex('customer_entities')
      .where({ id: contactId, organization_id: auth.orgId })
      .whereNull('deleted_at')
      .first()

    if (!entity) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })

    // Decrypt display_name / primary_email / primary_phone when tenant
    // encryption is on — raw knex skips the subscriber path.
    if (isTenantDataEncryptionEnabled() && auth.tenantId) {
      try {
        const svc = new TenantDataEncryptionService(em as any, { kms: createKmsService() })
        const dec = await svc.decryptEntityPayload(
          'customers:customer_entity',
          { display_name: entity.display_name, primary_email: entity.primary_email, primary_phone: entity.primary_phone },
          auth.tenantId,
          auth.orgId,
        )
        entity.display_name = dec.display_name ?? entity.display_name
        entity.primary_email = dec.primary_email ?? entity.primary_email
        entity.primary_phone = dec.primary_phone ?? entity.primary_phone
      } catch {}
    }

    // Get person details (job title, etc.)
    const person = await knex('customer_people')
      .where({ entity_id: contactId, organization_id: auth.orgId })
      .first()

    // Get notes
    const notes = await knex('contact_notes')
      .where({ contact_id: contactId, organization_id: auth.orgId })
      .orderBy('created_at', 'desc')
      .limit(5)

    // Get engagement score
    const engagement = await knex('contact_engagement_scores')
      .where({ contact_id: contactId, organization_id: auth.orgId })
      .first()

    return NextResponse.json({
      ok: true,
      data: {
        id: entity.id,
        displayName: entity.display_name,
        primaryEmail: entity.primary_email,
        primaryPhone: entity.primary_phone,
        lifecycleStage: entity.lifecycle_stage,
        source: entity.source,
        createdAt: entity.created_at,
        jobTitle: person?.job_title || null,
        notes: notes.map((n: any) => ({ id: n.id, content: n.content, created_at: n.created_at })),
        engagementScore: engagement?.score ?? null,
      },
    })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
