export const metadata = { path: '/crm-company-links', GET: { requireAuth: true }, PUT: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  decryptAliasedRowFields,
  CONTACT_ENTITY_KEY,
  PERSON_ENTITY_KEY,
} from '@open-mercato/shared/lib/encryption/decryptRows'
import { isEncryptedEnvelope } from '@open-mercato/shared/lib/encryption/envelopeFormat'
import { UNDECRYPTABLE_DISPLAY_TEXT } from '@open-mercato/shared/lib/encryption/tenantDataEncryptionService'


// GET: Get people linked to a company, or get company for a person
export async function GET(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const url = new URL(req.url)
    const companyEntityId = url.searchParams.get('companyEntityId')
    const personEntityId = url.searchParams.get('personEntityId')

    if (companyEntityId) {
      // Get all people linked to this company
      // Unreadable after decryption: an envelope of any version (shared
      // parser; the old private regex knew only v1) or the failure placeholder.
      const isEncrypted = (val: any) => isEncryptedEnvelope(val) || val === UNDECRYPTABLE_DISPLAY_TEXT
      const people = await knex('customer_people as cp')
        .join('customer_entities as ce', 'ce.id', 'cp.entity_id')
        .where('cp.company_entity_id', companyEntityId)
        .where('cp.organization_id', auth.orgId)
        .whereNull('ce.deleted_at')
        .select('ce.id as entityId', 'ce.display_name', 'ce.primary_email', 'ce.primary_phone', 'cp.job_title')

      // Raw join: every one of these columns is encrypted at rest. Decrypt,
      // then sort by name in memory (ORDER BY on ciphertext is random).
      await decryptAliasedRowFields(
        em, CONTACT_ENTITY_KEY, people,
        { display_name: 'display_name', primary_email: 'primary_email', primary_phone: 'primary_phone' },
        auth.tenantId, auth.orgId,
      )
      await decryptAliasedRowFields(em, PERSON_ENTITY_KEY, people, { job_title: 'job_title' }, auth.tenantId, auth.orgId)

      const cleaned = people.map((p: any) => ({
        ...p,
        display_name: isEncrypted(p.display_name) ? 'Contact' : p.display_name,
        primary_email: isEncrypted(p.primary_email) ? null : p.primary_email,
        primary_phone: isEncrypted(p.primary_phone) ? null : p.primary_phone,
        job_title: isEncrypted(p.job_title) ? null : p.job_title,
      }))
      cleaned.sort((a: any, b: any) => String(a.display_name ?? '').localeCompare(String(b.display_name ?? ''), undefined, { sensitivity: 'base' }))

      return NextResponse.json({ ok: true, data: cleaned })
    }

    if (personEntityId) {
      // Get which company this person is linked to
      const person = await knex('customer_people')
        .where('entity_id', personEntityId)
        .where('organization_id', auth.orgId)
        .first()

      if (!person?.company_entity_id) {
        return NextResponse.json({ ok: true, data: null })
      }

      const company = await knex('customer_entities')
        .where('id', person.company_entity_id)
        .where('organization_id', auth.orgId)
        .whereNull('deleted_at')
        .first()

      // Use ORM decryption to get the real company name
      let displayName = company.display_name
      let primaryEmail = company.primary_email
      try {
        const { findOneWithDecryption } = await import('@open-mercato/shared/lib/encryption/find')
        const decrypted = await findOneWithDecryption(em, 'CustomerEntity' as any, { id: company.id })
        if (decrypted) {
          displayName = (decrypted as any).displayName || (decrypted as any).display_name || company.display_name
          primaryEmail = (decrypted as any).primaryEmail || (decrypted as any).primary_email || company.primary_email
        }
      } catch {}
      return NextResponse.json({ ok: true, data: { entityId: company.id, displayName, primaryEmail } })
    }

    return NextResponse.json({ ok: false, error: 'companyEntityId or personEntityId required' }, { status: 400 })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

// PUT: Link a person to a company (or unlink)
export async function PUT(req: Request) {
  const auth = await getAuthFromRequest(req)
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { personEntityId, companyEntityId } = body // companyEntityId can be null to unlink

    if (!personEntityId) return NextResponse.json({ ok: false, error: 'personEntityId required' }, { status: 400 })

    // Update the person's company link
    await knex('customer_people')
      .where('entity_id', personEntityId)
      .where('organization_id', auth.orgId)
      .update({ company_entity_id: companyEntityId || null, updated_at: new Date() })

    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
