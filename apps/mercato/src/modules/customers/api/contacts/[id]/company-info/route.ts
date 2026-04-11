export const metadata = { path: '/contacts/[id]/company-info', GET: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CustomerEntity, CustomerPersonProfile } from '@open-mercato/core/modules/customers/data/entities'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const { id: contactId } = await params
    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    const scope = { tenantId: auth.tenantId, organizationId: auth.orgId }

    // Get the person record (job_title, department, company link)
    const person = await em.findOne(CustomerPersonProfile, {
      entity: contactId, organizationId: auth.orgId, tenantId: auth.tenantId,
    })

    if (!person) {
      return NextResponse.json({ ok: true, data: { person: null, colleagues: [] } })
    }

    let companyName: string | null = null
    let companyId: string | null = null
    let colleagues: Array<{ id: string; display_name: string; primary_email: string | null }> = []

    // If person is linked to a company, get company info and colleagues
    if (person.companyEntityId) {
      companyId = person.companyEntityId

      // Get company name (with decryption)
      const company = await findWithDecryption(
        em, CustomerEntity,
        { id: person.companyEntityId, organizationId: auth.orgId },
        { fields: ['id', 'displayName'] },
        scope,
      )
      companyName = company[0]?.displayName || null

      // Get colleagues (other people at the same company, with decryption)
      const colleaguePeople = await em.find(CustomerPersonProfile, {
        companyEntityId: person.companyEntityId,
        organizationId: auth.orgId,
        tenantId: auth.tenantId,
      }, { limit: 20 })

      const colleagueIds = colleaguePeople
        .filter(p => p.entity?.toString() !== contactId)
        .map(p => typeof p.entity === 'string' ? p.entity : (p as any).entityId)
        .filter(Boolean)

      if (colleagueIds.length > 0) {
        const colleagueEntities = await findWithDecryption(
          em, CustomerEntity,
          { id: { $in: colleagueIds }, organizationId: auth.orgId, deletedAt: null },
          { fields: ['id', 'displayName', 'primaryEmail'] },
          scope,
        )
        colleagues = colleagueEntities.map(e => ({
          id: e.id,
          display_name: e.displayName,
          primary_email: e.primaryEmail || null,
        }))
      }
    }

    return NextResponse.json({
      ok: true,
      data: {
        person: {
          job_title: person.jobTitle || null,
          department: person.department || null,
          company_name: companyName,
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
