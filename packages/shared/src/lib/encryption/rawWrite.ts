import { hashForLookup } from './aes'
import { createKmsService } from './kms'
import { LOOKUP_HASH_RULES } from './lookupHashRules'
import { TenantDataEncryptionService } from './tenantDataEncryptionService'
import { isTenantDataEncryptionEnabled } from './toggles'

/**
 * Encrypt a row that is about to be written with raw knex / SQL.
 *
 * Raw writes bypass the ORM subscriber, so without this every mapped column
 * (activity subject/body, contact phone, person job title ...) lands in
 * plaintext. The row goes through the same TenantDataEncryptionService call the
 * subscriber makes, with the row's own tenant and organization, and the contact
 * lookup hashes are filled exactly as the subscriber fills them.
 *
 * Keys are database column names (snake_case), as a raw insert/update uses.
 * Columns the map does not list pass through untouched; envelopes are never
 * encrypted twice.
 *
 * Fails closed: with encryption on, a missing tenant or an unresolvable
 * EntityManager throws instead of handing back plaintext for the caller to
 * write. Every current call site already treats its raw write as best-effort
 * and catches, so the failure mode is "not logged", never "logged in clear".
 *
 * Relative imports only: reachable from worker bundles.
 */
export async function encryptRowForRawWrite<T extends Record<string, unknown>>(
  entityId: string,
  row: T,
  tenantId: string | null | undefined,
  organizationId: string | null | undefined,
  em?: unknown,
): Promise<T> {
  if (!isTenantDataEncryptionEnabled()) return row
  if (!tenantId) {
    throw new Error(`[encryption] raw write to ${entityId} without a tenant id; refusing to write plaintext`)
  }
  let manager = em
  if (!manager) {
    const { createRequestContainer } = await import('../di/container')
    manager = (await createRequestContainer()).resolve('em')
  }
  const service = new TenantDataEncryptionService(manager as any, { kms: createKmsService() })
  if (!service.isEnabled()) {
    throw new Error(`[encryption] raw write to ${entityId} while the key service is unavailable; refusing to write plaintext`)
  }

  const out: Record<string, unknown> = { ...row }
  for (const rule of LOOKUP_HASH_RULES[entityId] ?? []) {
    if (!Object.prototype.hasOwnProperty.call(out, rule.sourceColumn)) continue
    const raw = out[rule.sourceColumn]
    const normalized = typeof raw === 'string' ? rule.normalize(raw) : ''
    out[rule.targetColumn] = normalized ? hashForLookup(normalized) : null
  }
  const encrypted = await service.encryptEntityPayload(entityId, out, tenantId, organizationId ?? null)
  return encrypted as T
}
