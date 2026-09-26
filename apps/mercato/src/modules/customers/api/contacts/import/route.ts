export const metadata = { path: '/contacts/import', POST: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { createPersonContact } from '@/modules/customers/lib/contact-write'
import { findOrMergeContact as findContactByEmail } from '@/modules/customers/lib/dedup'
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
    const { contacts, filename } = body

    if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
      return NextResponse.json({ ok: false, error: 'contacts array required' }, { status: 400 })
    }

    // Lazy-import the source tagger once for the whole batch
    const { tagContactSource } = await import('@open-mercato/core/modules/customers/lib/sourceTagging')
    const importDetail = typeof filename === 'string' && filename.trim() ? filename.trim() : undefined

    let imported = 0
    let skipped = 0
    const errors: string[] = []

    for (const contact of contacts) {
      const { name, email, phone, company, source, tags } = contact
      if (!name && !email) { skipped++; continue }

      // Check for duplicate by email
      if (email) {
        const existing = (await findContactByEmail(knex, auth.orgId, auth.tenantId, email, name, phone, em)).existing
        if (existing) { skipped++; continue }
      }

      try {
        // Entity + person profile through the ORM (encrypted at rest)
        const id = await createPersonContact(em, {
          organizationId: auth.orgId, tenantId: auth.tenantId,
          displayName: name || email, primaryEmail: email || null, primaryPhone: phone || null,
          source: source || 'import', lifecycleStage: 'prospect',
        })

        // Source attribution — tag with import:<filename> (or just 'import'
        // when no filename given) so bulk uploads are clearly attributed.
        try {
          await tagContactSource(knex, { tenantId: auth.tenantId, organizationId: auth.orgId }, id, 'import', importDetail)
        } catch {}

        // "Contact created" automations and sequences, once per contact
        try {
          const { dispatchContactCreated } = await import('@/modules/sequences/lib/automation-dispatch')
          dispatchContactCreated(knex, {
            organizationId: auth.orgId, tenantId: auth.tenantId, contactId: id, source: source || 'import',
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
