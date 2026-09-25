import type { EntityManager } from '@mikro-orm/postgresql'
import type { CacheStrategy } from '@open-mercato/cache'
import {
  TenantDataEncryptionError,
  TenantDataEncryptionErrorCode,
  decryptWithAesGcmStrict,
  encryptWithAesGcm,
  hashForLookup,
  isEncryptedEnvelope,
  keyIdForDek,
  keyIdFromEnvelope,
} from './aes'
import { createKmsService, type KmsService, type TenantDek } from './kms'
import { isTenantDataEncryptionEnabled, isEncryptionDebugEnabled } from './toggles'
import { EncryptionMap } from '@open-mercato/core/modules/entities/data/entities'
import { DEFAULT_ENCRYPTION_MAPS } from '@open-mercato/core/modules/entities/lib/encryptionDefaults'

/**
 * Entities every tenant must encrypt (the maps provisioning writes for every
 * tenant/org). A write of one of these with no resolvable map is refused
 * instead of stored in clear: that is how six of nine production user emails
 * ended up plaintext (a map lookup outside the provisioning transaction).
 */
export const REQUIRED_ENCRYPTION_ENTITY_IDS: ReadonlySet<string> = new Set(
  DEFAULT_ENCRYPTION_MAPS.map((spec) => spec.entityId),
)

export class TenantDataEncryptionMapMissingError extends Error {
  readonly name = 'TenantDataEncryptionMapMissingError'
  constructor(
    readonly entityId: string,
    readonly tenantId: string | null,
    readonly organizationId: string | null,
    readonly reason: 'no-map' | 'no-dek',
  ) {
    super(
      `[encryption] refusing to write ${entityId} in clear: ${reason === 'no-map' ? 'no encryption map' : 'no data key'}`
        + ` for tenant ${tenantId ?? 'null'} / organization ${organizationId ?? 'null'}`,
    )
  }
}

/** Options for the write path. */
export type EncryptWriteOptions = {
  /**
   * The EntityManager doing the write. Its transaction (if any) is used for
   * the map lookup, so maps flushed earlier in the same, still uncommitted
   * transaction are found (tenant provisioning creates them right before the
   * first user row).
   */
  em?: unknown
  /**
   * Throw instead of returning plaintext when no map / no key resolves for an
   * org-scoped row (organizationId set). Org-less rows pass through as before.
   */
  requireMap?: boolean
}

type MapLookupSource = { conn: any; trx: unknown | null }

export type EncryptedFieldRule = {
  field: string
  hashField?: string | null
}

export type EncryptionMapRecord = {
  entityId: string
  fields: EncryptedFieldRule[]
}

type MapCacheKey = {
  entityId: string
  tenantId: string | null
  /** SIBLING_ORG: any active map of another organization in the same tenant. */
  organizationId: string | null
}

/**
 * Last-resort candidate for an org-scoped row: a map of another organization
 * in the same tenant. Maps are written per organization at provisioning, so a
 * sub-organization (or one created by a path that wrote no maps) had none and
 * its rows were stored in clear. With one tenant per customer the sibling map
 * is that customer's own, and the key is per tenant either way.
 */
const SIBLING_ORG = '*'

const MAP_MISS_TTL_MS = 5 * 60 * 1000

/** Lookup order: the row's org map, the tenant map, the global map, then (org rows only) a sibling org's map. */
function mapCandidates(key: MapCacheKey): MapCacheKey[] {
  const out: MapCacheKey[] = [
    key,
    { entityId: key.entityId, tenantId: key.tenantId ?? null, organizationId: null },
    { entityId: key.entityId, tenantId: null, organizationId: null },
  ]
  if (key.tenantId && key.organizationId) {
    out.push({ entityId: key.entityId, tenantId: key.tenantId, organizationId: SIBLING_ORG })
  }
  return out
}

function cacheKey(key: MapCacheKey): string {
  return [
    'encmap',
    key.entityId.toLowerCase(),
    key.tenantId ?? 'null',
    key.organizationId ?? 'null',
  ].join(':')
}

function debug(event: string, payload: Record<string, unknown>) {
  if (!isEncryptionDebugEnabled()) return
  try {
    // eslint-disable-next-line no-console
    console.debug(`${event} [tenant-encryption]`, payload)
  } catch {
    // ignore
  }
}

const toSnakeCase = (value: string): string =>
  value.replace(/([A-Z])/g, '_$1').replace(/__/g, '_').toLowerCase()

const toCamelCase = (value: string): string =>
  value.replace(/_([a-z])/g, (_, c) => c.toUpperCase())

function findKey(obj: Record<string, unknown>, key: string): string | null {
  const candidates = [key, toSnakeCase(key), toCamelCase(key)]
  for (const candidate of candidates) {
    if (Object.prototype.hasOwnProperty.call(obj, candidate)) return candidate
  }
  return null
}

function isEncryptedPayload(value: unknown): boolean {
  return isEncryptedEnvelope(value)
}

/**
 * What a list renders in place of a field it could not decrypt. Never the
 * ciphertext: a customer looking at their own contact list must be told the
 * record is broken, not shown base64 and left to guess.
 */
export const UNDECRYPTABLE_DISPLAY_TEXT = 'This record could not be decrypted. Contact support.'

/**
 * A field that is an envelope but would not open: wrong key, or a corrupt row.
 *
 * This used to be a `continue`, which put raw ciphertext on the screen and left
 * no trace anywhere. It raises now. Names only — entity, field, tenant, the two
 * key ids — never a value and never key material.
 */
export class TenantDataDecryptError extends Error {
  readonly name = 'TenantDataDecryptError'
  readonly entityId: string
  readonly fields: string[]
  readonly tenantId: string | null
  readonly code: TenantDataEncryptionErrorCode
  readonly stampedKeyId: string | null
  readonly activeKeyId: string | null
  /**
   * The row as far as it could be decrypted, with every failed field replaced
   * by UNDECRYPTABLE_DISPLAY_TEXT. A list boundary renders this instead of
   * dropping the whole page.
   */
  readonly partial: Record<string, unknown>

  constructor(args: {
    entityId: string
    fields: string[]
    tenantId: string | null
    code: TenantDataEncryptionErrorCode
    stampedKeyId?: string | null
    activeKeyId?: string | null
    partial: Record<string, unknown>
  }) {
    super(
      `Could not decrypt ${args.entityId} field(s) ${args.fields.join(', ')}`
        + (args.stampedKeyId ? ` (envelope key id ${args.stampedKeyId}, active key id ${args.activeKeyId})` : ''),
    )
    this.entityId = args.entityId
    this.fields = args.fields
    this.tenantId = args.tenantId
    this.code = args.code
    this.stampedKeyId = args.stampedKeyId ?? null
    this.activeKeyId = args.activeKeyId ?? null
    this.partial = args.partial
  }
}

export function isTenantDataDecryptError(err: unknown): err is TenantDataDecryptError {
  return err instanceof TenantDataDecryptError || (err as { name?: string })?.name === 'TenantDataDecryptError'
}

export class TenantDataEncryptionService {
  private static globalMemoryCache = new Map<string, EncryptionMapRecord>()
  private static globalInflightMaps = new Map<string, Promise<EncryptionMapRecord | null>>()
  private static globalDekCache = new Map<string, TenantDek>()
  private static globalMissCache = new Map<string, number>()
  private readonly kms: KmsService
  private readonly cache?: CacheStrategy
  private readonly memoryCache = TenantDataEncryptionService.globalMemoryCache
  private readonly dekCache = TenantDataEncryptionService.globalDekCache
  private readonly inflightMaps = TenantDataEncryptionService.globalInflightMaps
  private readonly missCache = TenantDataEncryptionService.globalMissCache

  constructor(
    private em: EntityManager,
    opts?: { cache?: CacheStrategy; kms?: KmsService }
  ) {
    this.cache = opts?.cache
    this.kms = opts?.kms ?? createKmsService()
  }

  isEnabled(): boolean {
    return isTenantDataEncryptionEnabled() && this.kms.isHealthy()
  }

  async getDek(tenantId: string | null | undefined): Promise<TenantDek | null> {
    if (!tenantId) return null
    const cached = this.dekCache.get(tenantId)
    if (cached) return cached
    const dek = await this.kms.getTenantDek(tenantId)
    if (!dek) {
      debug('🔎 dek.miss', { tenantId })
    } else {
      debug('✅ dek.hit', { tenantId })
    }
    if (dek) this.dekCache.set(tenantId, dek)
    return dek
  }

  private async resolveDekForEncrypt(tenantId: string | null): Promise<TenantDek | null> {
    const existing = await this.getDek(tenantId)
    if (existing || !tenantId) return existing ?? null
    if (typeof this.kms.createTenantDek !== 'function') return existing ?? null
    const created = await this.kms.createTenantDek(tenantId)
    if (created) this.dekCache.set(tenantId, created)
    return created ?? null
  }

  async createDek(tenantId: string): Promise<TenantDek | null> {
    const dek = await this.kms.createTenantDek(tenantId)
    if (dek) this.dekCache.set(tenantId, dek)
    return dek
  }

  private lookupSource(em?: unknown): MapLookupSource | null {
    const source: any = em ?? this.em
    const conn: any = source?.getConnection?.()
    if (!conn || typeof conn.execute !== 'function') return null
    let trx: unknown | null = null
    try {
      trx = typeof source?.getTransactionContext === 'function' ? source.getTransactionContext() ?? null : null
    } catch {
      trx = null
    }
    return { conn, trx }
  }

  private async fetchMap(key: MapCacheKey, lookup: MapLookupSource | null): Promise<EncryptionMapRecord | null> {
    // Bypass ORM lifecycle hooks to avoid recursive decrypt loops by querying directly.
    if (!lookup) return null
    const sql = `
      select entity_id, fields_json
      from encryption_maps
      where entity_id = ?
        and tenant_id is not distinct from ?
        and organization_id is not distinct from ?
        and is_active = true
        and deleted_at is null
      limit 1
    `
    const siblingSql = `
      select entity_id, fields_json
      from encryption_maps
      where entity_id = ?
        and tenant_id = ?
        and organization_id is not null
        and is_active = true
        and deleted_at is null
      order by created_at asc
      limit 1
    `
    const sibling = key.organizationId === SIBLING_ORG
    if (sibling && !key.tenantId) return null
    const query = sibling ? siblingSql : sql
    const params = sibling
      ? [key.entityId, key.tenantId]
      : [key.entityId, key.tenantId ?? null, key.organizationId ?? null]
    // Inside a transaction the lookup must run on the transaction's own
    // connection: a map flushed earlier in it is invisible to any other.
    const rows = lookup.trx
      ? await lookup.conn.execute(query, params, 'all', lookup.trx)
      : await lookup.conn.execute(query, params)
    const row = Array.isArray(rows) && rows.length ? rows[0] : null
    if (!row) return null
    return {
      entityId: row.entity_id || row.entityId || key.entityId,
      fields: Array.isArray(row.fields_json)
        ? (row.fields_json as EncryptedFieldRule[])
        : Array.isArray(row.fieldsJson)
          ? (row.fieldsJson as EncryptedFieldRule[])
          : [],
    }
  }

  private async getMap(key: MapCacheKey, em?: unknown): Promise<EncryptionMapRecord | null> {
    const lookup = this.lookupSource(em)
    if (lookup?.trx) return this.getMapInTransaction(key, lookup)
    const shouldSkipLookup = (tag: string) => {
      const expiresAt = this.missCache.get(tag)
      if (!expiresAt) return false
      if (expiresAt > Date.now()) return true
      this.missCache.delete(tag)
      return false
    }
    const recordMiss = (tag: string) => {
      this.missCache.set(tag, Date.now() + MAP_MISS_TTL_MS)
    }

    const candidates = mapCandidates(key)
    for (const candidate of candidates) {
      const tag = cacheKey(candidate)
      if (shouldSkipLookup(tag)) continue
      if (this.inflightMaps.has(tag)) {
        const pending = this.inflightMaps.get(tag)!
        const resolved = await pending
        if (resolved) return resolved
      }
      const mem = this.memoryCache.get(tag)
      if (mem) return mem
      if (this.cache && typeof this.cache.get === 'function') {
        const cached = await this.cache.get(tag)
        if (cached) return cached as EncryptionMapRecord
      }
      const pending = this.fetchMap(candidate, lookup)
      this.inflightMaps.set(tag, pending)
      const loaded = await pending
      this.inflightMaps.delete(tag)
      if (!loaded) {
        recordMiss(tag)
        debug('🔍 encmap.miss', {
          entityId: candidate.entityId,
          tenantId: candidate.tenantId,
          organizationId: candidate.organizationId,
        })
        continue
      }
      this.missCache.delete(tag)
      this.memoryCache.set(tag, loaded)
      if (this.cache && typeof this.cache.set === 'function') {
        await this.cache.set(tag, loaded, { ttl: 300 })
      }
      return loaded
    }
    return null
  }

  /**
   * Map lookup inside a transaction. Rows read here may be uncommitted (and
   * may roll back), so nothing is cached from it: no recorded miss (a miss
   * cached process-wide for five minutes left every user created in that
   * window in plaintext) and no cached hit. A committed hit already in the
   * memory cache is used as is.
   */
  private async getMapInTransaction(key: MapCacheKey, lookup: MapLookupSource): Promise<EncryptionMapRecord | null> {
    const candidates = mapCandidates(key)
    for (const candidate of candidates) {
      const mem = this.memoryCache.get(cacheKey(candidate))
      if (mem) return mem
      const loaded = await this.fetchMap(candidate, lookup)
      if (loaded) return loaded
    }
    return null
  }

  /** Insert the missing DEFAULT_ENCRYPTION_MAPS rows for one organization (idempotent per entity). */
  private async ensureDefaultMaps(tenantId: string, organizationId: string, em?: unknown): Promise<void> {
    const lookup = this.lookupSource(em)
    if (!lookup) throw new TenantDataEncryptionMapMissingError('*', tenantId, organizationId, 'no-map')
    for (const spec of DEFAULT_ENCRYPTION_MAPS) {
      const sql = `
        insert into encryption_maps (id, entity_id, tenant_id, organization_id, fields_json, is_active, created_at, updated_at)
        select gen_random_uuid(), ?, ?, ?, ?::jsonb, true, now(), now()
         where not exists (
           select 1 from encryption_maps
            where entity_id = ? and tenant_id = ? and organization_id = ? and deleted_at is null
         )`
      const params = [spec.entityId, tenantId, organizationId, JSON.stringify(spec.fields), spec.entityId, tenantId, organizationId]
      if (lookup.trx) await lookup.conn.execute(sql, params, 'run', lookup.trx)
      else await lookup.conn.execute(sql, params, 'run')
    }
    console.warn('[encryption] created missing default maps', { tenantId, organizationId })
  }

  /** Query every candidate again, ignoring cached misses; a hit replaces them. */
  private async refreshMap(key: MapCacheKey, em?: unknown): Promise<EncryptionMapRecord | null> {
    const lookup = this.lookupSource(em)
    if (!lookup) return null
    for (const candidate of mapCandidates(key)) {
      const loaded = await this.fetchMap(candidate, lookup)
      if (!loaded) continue
      if (!lookup.trx) {
        const tag = cacheKey(candidate)
        this.missCache.delete(tag)
        this.memoryCache.set(tag, loaded)
        for (const other of mapCandidates(key)) this.missCache.delete(cacheKey(other))
      }
      return loaded
    }
    return null
  }

  /**
   * The encrypted-by-design fields for an entity in a tenant/org scope, resolved
   * exactly as encryptEntityPayload resolves them (same precedence: org map,
   * then tenant map, then global map; same caches). Empty when the scope has no
   * active map, which means the runtime would not encrypt that entity either.
   */
  async resolveEncryptedFields(
    entityId: string,
    tenantId: string | null | undefined,
    organizationId?: string | null,
  ): Promise<EncryptedFieldRule[]> {
    const map = await this.getMap({ entityId, tenantId: tenantId ?? null, organizationId: organizationId ?? null })
    return map?.fields?.length ? map.fields.map((rule) => ({ ...rule })) : []
  }

  async invalidateMap(entityId: string, tenantId: string | null, organizationId: string | null): Promise<void> {
    const tag = cacheKey({ entityId, tenantId, organizationId })
    this.memoryCache.delete(tag)
    this.inflightMaps.delete(tag)
    this.missCache.delete(tag)
    if (this.cache && typeof (this.cache as any).delete === 'function') {
      await (this.cache as any).delete(tag)
    }
  }

  private encryptFields(
    obj: Record<string, unknown>,
    fields: EncryptedFieldRule[],
    dek: TenantDek
  ): Record<string, unknown> {
    const clone: Record<string, unknown> = { ...obj }
    for (const rule of fields) {
      const key = findKey(clone, rule.field)
      if (!key) continue
      const value = clone[key]
      if (value === null || value === undefined) continue
       // Avoid double-encrypting already encrypted payloads
      if (isEncryptedPayload(value)) continue
      // A row whose field we could not open was handed to the UI carrying the
      // placeholder. If that entity is saved again, encrypting the placeholder
      // would overwrite the only copy of the ciphertext and destroy any chance
      // of recovering it once the right key is back. Leave the column alone.
      if (value === UNDECRYPTABLE_DISPLAY_TEXT) {
        console.error('[encryption] refused_to_overwrite_undecryptable', { field: rule.field, tenantId: dek.tenantId })
        delete clone[key]
        continue
      }
      const serialized = typeof value === 'string' ? value : JSON.stringify(value)
      const payload = encryptWithAesGcm(serialized, dek.key)
      clone[key] = payload.value
      if (rule.hashField) {
        const hashKey = findKey(clone, rule.hashField) ?? rule.hashField
        clone[hashKey] = hashForLookup(serialized)
      }
    }
    return clone
  }

  private decryptFields(
    entityId: string,
    obj: Record<string, unknown>,
    fields: EncryptedFieldRule[],
    dek: TenantDek
  ): Record<string, unknown> {
    const clone: Record<string, unknown> = { ...obj }
    const failedFields: string[] = []
    let firstError: TenantDataEncryptionError | null = null
    let firstStampedKeyId: string | null = null

    // Handle accidental double-encryption: if the first pass still looks like
    // an envelope, open it once more.
    const openOnce = (payload: string): string => {
      const first = decryptWithAesGcmStrict(payload, dek.key)
      if (!isEncryptedPayload(first)) return first
      try {
        return decryptWithAesGcmStrict(first, dek.key)
      } catch {
        return first
      }
    }

    for (const rule of fields) {
      const key = findKey(clone, rule.field)
      if (!key) continue
      const value = clone[key]
      if (typeof value !== 'string') continue
      // A value that is not one of our envelopes is legacy plaintext written
      // before this field was mapped. It is not a fault and must not raise.
      if (!isEncryptedPayload(value)) continue
      let decrypted: string
      try {
        decrypted = openOnce(value)
      } catch (err) {
        const typed = err as TenantDataEncryptionError
        failedFields.push(rule.field)
        if (!firstError) {
          firstError = typed
          firstStampedKeyId = typed?.stampedKeyId ?? keyIdFromEnvelope(value)
        }
        // Never the ciphertext, never the value. A list boundary renders this.
        clone[key] = UNDECRYPTABLE_DISPLAY_TEXT
        continue
      }
      try {
        clone[key] = JSON.parse(decrypted)
      } catch {
        clone[key] = decrypted
      }
    }

    if (failedFields.length) {
      console.error('[encryption] decrypt_failed', {
        entityId,
        fields: failedFields,
        tenantId: dek.tenantId,
        code: firstError?.code,
        stampedKeyId: firstStampedKeyId,
        activeKeyId: keyIdForDek(dek.key),
      })
      throw new TenantDataDecryptError({
        entityId,
        fields: failedFields,
        tenantId: dek.tenantId ?? null,
        code: firstError?.code ?? TenantDataEncryptionErrorCode.DECRYPT_INTERNAL,
        stampedKeyId: firstStampedKeyId,
        activeKeyId: keyIdForDek(dek.key),
        partial: clone,
      })
    }
    return clone
  }

  async encryptEntityPayload(
    entityId: string,
    payload: Record<string, unknown>,
    tenantId: string | null | undefined,
    organizationId?: string | null,
    options?: EncryptWriteOptions,
  ): Promise<Record<string, unknown>> {
    if (!this.isEnabled()) {
      debug('⚪️ encrypt.skip.disabled', { entityId, tenantId })
      return payload
    }
    const dek = await this.resolveDekForEncrypt(tenantId ?? null)
    if (!dek) {
      debug('⚠️ encrypt.skip.no-dek', { entityId, tenantId })
      if (options?.requireMap && tenantId && organizationId) {
        throw new TenantDataEncryptionMapMissingError(entityId, tenantId ?? null, organizationId ?? null, 'no-dek')
      }
      return payload
    }
    const mapKey = { entityId, tenantId: tenantId ?? null, organizationId: organizationId ?? null }
    let map = await this.getMap(mapKey, options?.em)
    if ((!map || !map.fields?.length) && options?.requireMap && organizationId) {
      // Before refusing the write, look again past the process-wide miss
      // cache: a miss recorded before this tenant's maps were committed must
      // not turn into five minutes of refused writes.
      map = await this.refreshMap(mapKey, options?.em)
      if ((!map || !map.fields?.length) && tenantId && REQUIRED_ENCRYPTION_ENTITY_IDS.has(entityId)) {
        // Self-heal: an organization created by a path that wrote no maps gets
        // the default maps now (in the caller's transaction), and the row is
        // encrypted with them. Never a plaintext write; if this fails, the
        // write fails.
        await this.ensureDefaultMaps(tenantId, organizationId, options?.em)
        map = await this.refreshMap(mapKey, options?.em)
      }
    }
    if (!map || !map.fields?.length) {
      debug('⚪️ encrypt.skip.no-map', { entityId, tenantId })
      // Only org-scoped rows fail closed: an org-less (tenant-level) row has
      // never had a map to be read back with, and refusing it would break
      // tenant-level writes (audit log entries of role changes and the like).
      if (options?.requireMap && organizationId) {
        console.error('[encryption] encrypt_refused_no_map', { entityId, tenantId, organizationId })
        throw new TenantDataEncryptionMapMissingError(entityId, tenantId ?? null, organizationId ?? null, 'no-map')
      }
      return payload
    }
    debug('🔒 encrypt_entity', { entityId, tenantId, organizationId, fields: map.fields.length })
    return this.encryptFields(payload, map.fields, dek)
  }

  async decryptEntityPayload(
    entityId: string,
    payload: Record<string, unknown>,
    tenantId: string | null | undefined,
    organizationId?: string | null
  ): Promise<Record<string, unknown>> {
    if (!isTenantDataEncryptionEnabled()) {
      debug('⚪️ decrypt.skip.disabled', { entityId, tenantId })
      return payload
    }
    const dek = await this.getDek(tenantId ?? null)
    if (!dek) {
      debug('⚠️ decrypt.skip.no-dek', { entityId, tenantId })
      return payload
    }
    const map = await this.getMap({ entityId, tenantId: tenantId ?? null, organizationId: organizationId ?? null })
    if (!map || !map.fields?.length) {
      debug('⚪️ decrypt.skip.no-map', { entityId, tenantId })
      return payload
    }
    debug('🔓 decrypt_entity', { entityId, tenantId, organizationId, fields: map.fields.length })
    return this.decryptFields(entityId, payload, map.fields, dek)
  }

  /**
   * Decrypt for a surface that renders rows to a person.
   *
   * decryptEntityPayload raises on an envelope it cannot open, which is right
   * for writers, CLIs and outbound paths: those must stop rather than act on a
   * broken value. A list cannot stop, so this is the boundary for it. The
   * failed fields come back as UNDECRYPTABLE_DISPLAY_TEXT, the rest of the row
   * is intact, and the caller gets the field names so it can flag the row.
   */
  async decryptEntityPayloadForDisplay(
    entityId: string,
    payload: Record<string, unknown>,
    tenantId: string | null | undefined,
    organizationId?: string | null
  ): Promise<{ payload: Record<string, unknown>; undecryptableFields: string[] }> {
    try {
      const decrypted = await this.decryptEntityPayload(entityId, payload, tenantId, organizationId)
      return { payload: decrypted, undecryptableFields: [] }
    } catch (err) {
      if (isTenantDataDecryptError(err)) {
        return { payload: err.partial, undecryptableFields: err.fields }
      }
      throw err
    }
  }
}
