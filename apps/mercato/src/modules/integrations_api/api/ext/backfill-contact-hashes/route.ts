import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { hashForLookup } from '@open-mercato/shared/lib/encryption/aes'
import {
  decryptRowFields,
  CONTACT_ENTITY_KEY,
} from '@open-mercato/shared/lib/encryption/decryptRows'

export const metadata = {
  path: '/ext/backfill-contact-hashes',
  POST: { requireAuth: true, requireFeatures: ['integrations_api.access'] },
}

const CIPHERTEXT = /^[A-Za-z0-9+/=]{10,}:[A-Za-z0-9+/=]{8,}:[A-Za-z0-9+/=]{8,}:v1$/
const BATCH = 500

/* One-off, idempotent, org-scoped backfill of the contact lookup-hash columns.
 *
 * New and updated contacts get their hashes from the encryption subscriber;
 * this fills in rows written before the columns existed. Scoped to the calling
 * key's org on purpose — orgs that never run it still work, because the dedup
 * helpers keep their decrypt-scan fallback for hashless rows.
 *
 * Call repeatedly until `remaining` is 0. Each call handles up to 500 rows.
 */
export async function POST(_req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.tenantId || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()

    const rows = await knex('customer_entities')
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .where(function () {
        this.where(function () {
          this.whereNotNull('primary_email').whereNull('primary_email_hash')
        }).orWhere(function () {
          this.whereNotNull('primary_phone').whereNull('primary_phone_hash')
        })
      })
      .select('id', 'primary_email', 'primary_phone')
      .limit(BATCH)

    let updated = 0
    let unreadable = 0
    for (const row of rows) {
      const stored = { email: row.primary_email, phone: row.primary_phone }
      await decryptRowFields(
        em, CONTACT_ENTITY_KEY, [row], ['primary_email', 'primary_phone'], auth.tenantId, auth.orgId,
      )
      const patch: Record<string, string | null> = {}
      if (stored.email) {
        const email = String(row.primary_email || '')
        // A value that is still ciphertext after decryption is unreadable with
        // the current keys; hashing it would just poison the lookup column.
        if (email && !CIPHERTEXT.test(email)) patch.primary_email_hash = hashForLookup(email)
        else unreadable += 1
      }
      if (stored.phone) {
        const digits = String(row.primary_phone || '').replace(/\D/g, '')
        if (digits && !CIPHERTEXT.test(String(row.primary_phone))) {
          patch.primary_phone_hash = hashForLookup(digits)
        }
      }
      if (Object.keys(patch).length) {
        await knex('customer_entities').where('id', row.id).update(patch)
        updated += 1
      }
    }

    const [{ count }] = await knex('customer_entities')
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .where(function () {
        this.where(function () {
          this.whereNotNull('primary_email').whereNull('primary_email_hash')
        }).orWhere(function () {
          this.whereNotNull('primary_phone').whereNull('primary_phone_hash')
        })
      })
      .count({ count: '*' })

    return NextResponse.json({ ok: true, scanned: rows.length, updated, unreadable, remaining: Number(count) })
  } catch (error) {
    console.error('[ext.backfill-contact-hashes]', error)
    return NextResponse.json({ ok: false, error: 'Backfill failed' }, { status: 500 })
  }
}
