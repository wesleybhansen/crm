export const metadata = { path: '/contacts/[id]/company-info', GET: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { decryptRowFields, CONTACT_ENTITY_KEY, PERSON_ENTITY_KEY } from '@open-mercato/shared/lib/encryption/decryptRows'
import { isEncryptedEnvelope } from '@open-mercato/shared/lib/encryption/envelopeFormat'
import { UNDECRYPTABLE_DISPLAY_TEXT } from '@open-mercato/shared/lib/encryption/tenantDataEncryptionService'

// A value that is still unreadable after decryption: an envelope of any
// version (shared parser; the old private regex knew only v1) or the
// placeholder decryptRowFields leaves when a field would not open.
function isEncrypted(val: any): boolean {
  return isEncryptedEnvelope(val) || val === UNDECRYPTABLE_DISPLAY_TEXT
}

function clean(val: any): string | null {
  if (!val || isEncrypted(val)) return null
  return val
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const { id: contactId } = await params
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()

    // Get the person record (job_title, department, company link)
    const person = await knex('customer_people')
      .where({ entity_id: contactId, organization_id: auth.orgId })
      .first()

    if (!person) {
      return NextResponse.json({ ok: true, data: { person: null, colleagues: [] } })
    }
    await decryptRowFields(em, PERSON_ENTITY_KEY, [person], ['job_title', 'department'], auth.tenantId, auth.orgId)

    let companyName: string | null = null
    let companyId: string | null = null
    let colleagues: Array<{ id: string; display_name: string; primary_email: string | null }> = []

    // If person is linked to a company, get company info and colleagues
    if (person.company_entity_id) {
      companyId = person.company_entity_id

      // Get company name
      const company = await knex('customer_entities')
        .where({ id: person.company_entity_id, organization_id: auth.orgId })
        .first()
      if (company) {
        await decryptRowFields(em, CONTACT_ENTITY_KEY, [company], ['display_name', 'primary_email', 'primary_phone'], auth.tenantId, auth.orgId)
      }
      companyName = company?.display_name || null

      // Get colleagues (other people at the same company)
      const colleaguePeople = await knex('customer_people')
        .where({ company_entity_id: person.company_entity_id, organization_id: auth.orgId })
        .whereNot('entity_id', contactId)
        .limit(20)

      if (colleaguePeople.length > 0) {
        const colleagueIds = colleaguePeople.map((p: any) => p.entity_id)
        const colleagueEntities = await knex('customer_entities')
          .whereIn('id', colleagueIds)
          .where('organization_id', auth.orgId)
          .whereNull('deleted_at')
        await decryptRowFields(em, CONTACT_ENTITY_KEY, colleagueEntities, ['display_name', 'primary_email'], auth.tenantId, auth.orgId)

        colleagues = colleagueEntities
          .filter((e: any) => !isEncrypted(e.display_name))
          .map((e: any) => ({
            id: e.id,
            display_name: e.display_name,
            primary_email: isEncrypted(e.primary_email) ? null : e.primary_email,
          }))
      }
    }

    return NextResponse.json({
      ok: true,
      data: {
        person: {
          job_title: clean(person.job_title),
          department: clean(person.department),
          company_name: clean(companyName),
          company_id: companyId,
        },
        colleagues,
      },
    })
  } catch (error) {
    console.error('[contacts.company-info]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
