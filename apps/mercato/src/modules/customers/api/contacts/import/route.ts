export const metadata = { path: '/contacts/import', POST: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
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

      // Check for duplicate by email
      if (email) {
        const existing = await knex('customer_entities')
          .where('primary_email', email)
          .where('organization_id', auth.orgId)
          .whereNull('deleted_at')
          .first()
        if (existing) { skipped++; continue }
      }

      try {
        const id = require('crypto').randomUUID()
        await knex('customer_entities').insert({
          id,
          tenant_id: auth.tenantId,
          organization_id: auth.orgId,
          kind: 'person',
          display_name: name || email,
          primary_email: email || null,
          primary_phone: phone || null,
          source: source || 'import',
          status: 'active',
          lifecycle_stage: 'prospect',
          created_at: new Date(),
          updated_at: new Date(),
        })

        // Create person profile
        if (name) {
          const parts = name.split(' ')
          await knex('customer_people').insert({
            id: require('crypto').randomUUID(),
            tenant_id: auth.tenantId,
            organization_id: auth.orgId,
            entity_id: id,
            first_name: parts[0] || '',
            last_name: parts.slice(1).join(' ') || '',
            created_at: new Date(),
            updated_at: new Date(),
          }).catch(() => {})
        }

        // Fire automation triggers
        try {
          const { executeAutomationRules } = await import('@/app/api/automation-rules/execute')
          executeAutomationRules(knex, auth.orgId, auth.tenantId, 'contact_created', {
            contactId: id, contactEmail: email, contactName: name,
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
