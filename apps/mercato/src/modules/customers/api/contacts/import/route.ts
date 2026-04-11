export const metadata = { path: '/contacts/import', POST: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { CustomerEntity, CustomerPersonProfile } from '@open-mercato/core/modules/customers/data/entities'

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    const body = await req.json()
    const { contacts } = body

    if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
      return NextResponse.json({ ok: false, error: 'contacts array required' }, { status: 400 })
    }

    let imported = 0
    let skipped = 0
    const errors: string[] = []

    for (const contact of contacts) {
      const { name, email, phone, company, source, tags } = contact
      if (!name && !email) { skipped++; continue }

      // Check for duplicate by email (ORM)
      if (email) {
        const existing = await em.findOne(CustomerEntity, {
          primaryEmail: email, organizationId: auth.orgId, tenantId: auth.tenantId, deletedAt: null,
        })
        if (existing) { skipped++; continue }
      }

      try {
        // Create entity via ORM
        const entity = em.create(CustomerEntity, {
          tenantId: auth.tenantId,
          organizationId: auth.orgId,
          kind: 'person' as const,
          displayName: name || email,
          primaryEmail: email || null,
          primaryPhone: phone || null,
          source: source || 'import',
          status: 'active',
          lifecycleStage: 'prospect',
        })
        em.persist(entity)
        await em.flush()

        // Create person profile via ORM
        if (name) {
          const parts = name.split(' ')
          const person = em.create(CustomerPersonProfile, {
            tenantId: auth.tenantId,
            organizationId: auth.orgId,
            entity: entity.id,
            firstName: parts[0] || '',
            lastName: parts.slice(1).join(' ') || '',
          })
          em.persist(person)
          await em.flush()
        }

        // Fire automation triggers (stays on knex — cross-module orchestration)
        try {
          const { executeAutomationRules } = await import('@/modules/sequences/lib/automation-execute')
          const knex = em.getKnex()
          executeAutomationRules(knex, auth.orgId, auth.tenantId, 'contact_created', {
            contactId: entity.id, contactEmail: email, contactName: name,
          }).catch(() => {})
        } catch {}

        imported++
      } catch (err) {
        errors.push(`Failed to import ${name || email}: ${err instanceof Error ? err.message : 'unknown'}`)
      }
    }

    return NextResponse.json({
      ok: true,
      data: { imported, skipped, total: contacts.length, errors: errors.slice(0, 5) },
    })
  } catch (error) {
    console.error('[contacts.import]', error)
    return NextResponse.json({ ok: false, error: 'Import failed' }, { status: 500 })
  }
}
