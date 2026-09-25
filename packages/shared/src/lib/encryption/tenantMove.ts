import { decryptWithAesGcmStrict, encryptWithAesGcm, keyIdForDek, TenantDataEncryptionError, TenantDataEncryptionErrorCode } from './aes'
import { parseEnvelope } from './envelopeFormat'

/**
 * Pure functions for moving rows from one tenant key to another (the tenant
 * split, scripts/split-tenants.ts). No database, no KMS: callers pass the two
 * data keys (base64 DEKs) and get back rewritten values plus counts.
 *
 * What an envelope is: aes.ts / envelopeFormat.ts. A value is re-keyed when it
 * is one of our envelopes AND it belongs to the old key:
 *   - v2 (and interim v1.<keyId>) stamped with the old key id: decrypted
 *     strictly with the old key, encrypted with the new one;
 *   - bare v1 (no key id): tried with the old key; it re-keys when that opens
 *     it, and is reported `unreadable` when it does not;
 *   - stamped with the NEW key id: already moved (a resumed run), untouched;
 *   - stamped with any other key id: `foreign`, untouched and reported (it was
 *     unreadable under the old tenant too; moving it changes nothing).
 * A string that is not an envelope is plain data; it may still carry a literal
 * the move must rewrite (the old tenant id, an old role id), handled by the
 * `replacements` below and never applied inside an envelope.
 *
 * jsonb values are walked recursively: custom field values, snapshots and
 * query-index documents carry envelopes (and ids) in nested strings.
 *
 * Nothing here ever logs or returns a decrypted value.
 *
 * Relative imports only: bundled into the standalone split script.
 */

export type EnvelopeState = 'none' | 'old' | 'new' | 'v1' | 'foreign'

export type RekeyKeys = {
  oldKey: string
  newKey: string
  /** keyIdForDek(oldKey); computed when omitted. */
  oldKeyId?: string
  newKeyId?: string
}

export type ResolvedKeys = { oldKey: string; newKey: string; oldKeyId: string; newKeyId: string }

export function resolveKeys(keys: RekeyKeys): ResolvedKeys {
  return {
    oldKey: keys.oldKey,
    newKey: keys.newKey,
    oldKeyId: keys.oldKeyId ?? keyIdForDek(keys.oldKey),
    newKeyId: keys.newKeyId ?? keyIdForDek(keys.newKey),
  }
}

export function envelopeState(value: unknown, keys: Pick<ResolvedKeys, 'oldKeyId' | 'newKeyId'>): EnvelopeState {
  const parsed = parseEnvelope(value)
  if (!parsed) return 'none'
  if (parsed.keyId === null) return 'v1'
  if (parsed.keyId === keys.oldKeyId) return 'old'
  if (parsed.keyId === keys.newKeyId) return 'new'
  return 'foreign'
}

export type RekeyCounts = {
  /** Envelopes rewritten from the old key to the new one. */
  rekeyed: number
  /** Envelopes already under the new key (a resumed or repeated run). */
  alreadyNew: number
  /** Envelopes stamped with a key id that is neither the old nor the new key. */
  foreign: number
  /** Envelopes that carry the old key id (or none) but did not open with the old key. */
  unreadable: number
  /** Plain (non-envelope) strings in which a literal was replaced. */
  literalsReplaced: number
}

export function emptyRekeyCounts(): RekeyCounts {
  return { rekeyed: 0, alreadyNew: 0, foreign: 0, unreadable: 0, literalsReplaced: 0 }
}

export function addRekeyCounts(into: RekeyCounts, add: RekeyCounts): RekeyCounts {
  into.rekeyed += add.rekeyed
  into.alreadyNew += add.alreadyNew
  into.foreign += add.foreign
  into.unreadable += add.unreadable
  into.literalsReplaced += add.literalsReplaced
  return into
}

/**
 * Literals to rewrite in plain strings:
 *  - `exact`: a whole string equal to a key is replaced by its value (old role
 *    ids inside api_keys.roles_json and similar id lists);
 *  - `substring`: every occurrence is replaced (the old tenant id inside a
 *    cache key, an idempotency key or a job payload of a moved row).
 */
export type LiteralReplacements = {
  exact?: ReadonlyMap<string, string>
  substring?: ReadonlyMap<string, string>
}

function replaceLiterals(value: string, replacements: LiteralReplacements | undefined): string {
  if (!replacements) return value
  const exact = replacements.exact?.get(value)
  if (exact !== undefined) return exact
  let out = value
  if (replacements.substring) {
    for (const [from, to] of replacements.substring) {
      if (from && out.includes(from)) out = out.split(from).join(to)
    }
  }
  return out
}

export type RekeyResult<T> = { value: T; changed: boolean; counts: RekeyCounts }

/**
 * Re-key one stored string. Throws only on a v2/interim envelope that carries
 * the OLD key id and still fails authentication: that is corruption under the
 * old key, and the move must stop rather than carry it along silently.
 */
export function rekeyString(value: string, keys: ResolvedKeys, replacements?: LiteralReplacements): RekeyResult<string> {
  const counts = emptyRekeyCounts()
  const state = envelopeState(value, keys)
  switch (state) {
    case 'none': {
      const replaced = replaceLiterals(value, replacements)
      if (replaced !== value) {
        counts.literalsReplaced++
        return { value: replaced, changed: true, counts }
      }
      return { value, changed: false, counts }
    }
    case 'new':
      counts.alreadyNew++
      return { value, changed: false, counts }
    case 'foreign':
      counts.foreign++
      return { value, changed: false, counts }
    case 'v1': {
      let plain: string
      try {
        plain = decryptWithAesGcmStrict(value, keys.oldKey)
      } catch {
        counts.unreadable++
        return { value, changed: false, counts }
      }
      counts.rekeyed++
      return { value: encryptWithAesGcm(plain, keys.newKey).value as string, changed: true, counts }
    }
    case 'old': {
      let plain: string
      try {
        plain = decryptWithAesGcmStrict(value, keys.oldKey)
      } catch (err) {
        const code = (err as TenantDataEncryptionError)?.code
        throw new TenantDataEncryptionError(
          code === TenantDataEncryptionErrorCode.MALFORMED_PAYLOAD ? code : TenantDataEncryptionErrorCode.AUTH_FAILED,
          `An envelope stamped with the old tenant key id ${keys.oldKeyId} did not open with that key`,
          { stampedKeyId: keys.oldKeyId, activeKeyId: keys.oldKeyId },
        )
      }
      counts.rekeyed++
      return { value: encryptWithAesGcm(plain, keys.newKey).value as string, changed: true, counts }
    }
  }
}

/** Re-key every string leaf of a JSON value (objects, arrays, nested). Keys are left alone. */
export function rekeyJson(value: unknown, keys: ResolvedKeys, replacements?: LiteralReplacements): RekeyResult<unknown> {
  const counts = emptyRekeyCounts()
  let changed = false
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const r = rekeyString(node, keys, replacements)
      addRekeyCounts(counts, r.counts)
      if (r.changed) changed = true
      return r.value
    }
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = walk(v)
      return out
    }
    return node
  }
  const next = walk(value)
  return { value: changed ? next : value, changed, counts }
}

/**
 * Re-key a column value as the database driver returned it: a string for
 * text/varchar, a parsed value for json/jsonb (node-postgres parses both). A
 * text column holding serialized JSON is treated as a plain string, which is
 * still correct: an envelope is never inside a longer string (it would not be
 * one of ours), so only whole-value envelopes are re-keyed there.
 */
export function rekeyColumnValue(value: unknown, isJson: boolean, keys: ResolvedKeys, replacements?: LiteralReplacements): RekeyResult<unknown> {
  if (value === null || value === undefined) return { value, changed: false, counts: emptyRekeyCounts() }
  if (isJson) return rekeyJson(value, keys, replacements)
  if (typeof value !== 'string') return { value, changed: false, counts: emptyRekeyCounts() }
  return rekeyString(value, keys, replacements)
}

export type KeyIdTally = { byKeyId: Map<string, number>; v1: number }

/** Count envelopes by the key id they carry (verification: 0 must carry the old id). */
export function tallyEnvelopeKeyIds(value: unknown, tally: KeyIdTally = { byKeyId: new Map(), v1: 0 }): KeyIdTally {
  const visit = (node: unknown) => {
    if (typeof node === 'string') {
      const parsed = parseEnvelope(node)
      if (!parsed) return
      if (parsed.keyId === null) tally.v1++
      else tally.byKeyId.set(parsed.keyId, (tally.byKeyId.get(parsed.keyId) ?? 0) + 1)
      return
    }
    if (Array.isArray(node)) node.forEach(visit)
    else if (node && typeof node === 'object') Object.values(node as Record<string, unknown>).forEach(visit)
  }
  visit(value)
  return tally
}

/** Every envelope in the value opens with the key (strict). Returns how many did not. */
export function countUndecryptable(value: unknown, key: string): { checked: number; failed: number } {
  const out = { checked: 0, failed: 0 }
  const visit = (node: unknown) => {
    if (typeof node === 'string') {
      if (!parseEnvelope(node)) return
      out.checked++
      try {
        decryptWithAesGcmStrict(node, key)
      } catch {
        out.failed++
      }
      return
    }
    if (Array.isArray(node)) node.forEach(visit)
    else if (node && typeof node === 'object') Object.values(node as Record<string, unknown>).forEach(visit)
  }
  visit(value)
  return out
}

/* ---------------------------------------------------------------------------
 * Roles are tenant-level rows. A moved organization gets the new tenant's own
 * roles; every old role id its rows reference is remapped to the new tenant's
 * role of the same name. `superadmin` maps to `admin`: a customer tenant never
 * carries the cross-tenant super-admin grant.
 * ------------------------------------------------------------------------- */

export const SUPERADMIN_ROLE_NAME = 'superadmin'

export type RoleRow = { id: string; name: string }

export function targetRoleName(oldName: string): string {
  return oldName.trim().toLowerCase() === SUPERADMIN_ROLE_NAME ? 'admin' : oldName
}

export type RolePlan = {
  /** old role id -> name the moved rows get in the new tenant */
  targetNameByOldId: Map<string, string>
  /** role names that must exist in the new tenant */
  requiredNames: string[]
  /** old role ids that were superadmin (reported) */
  demotedSuperadmin: string[]
}

export function planRoleMapping(referencedOldRoles: readonly RoleRow[], seededNames: readonly string[]): RolePlan {
  const targetNameByOldId = new Map<string, string>()
  const names = new Set<string>(seededNames)
  const demotedSuperadmin: string[] = []
  for (const role of referencedOldRoles) {
    const target = targetRoleName(role.name)
    if (target !== role.name) demotedSuperadmin.push(role.id)
    targetNameByOldId.set(role.id, target)
    names.add(target)
  }
  return { targetNameByOldId, requiredNames: [...names], demotedSuperadmin }
}

/** old role id -> new role id, from the plan and the new tenant's roles by name. */
export function buildRoleIdMap(plan: RolePlan, newRolesByName: ReadonlyMap<string, string>): Map<string, string> {
  const map = new Map<string, string>()
  for (const [oldId, name] of plan.targetNameByOldId) {
    const newId = newRolesByName.get(name)
    if (!newId) throw new Error(`ROLE_NOT_PROVISIONED:${name}`)
    map.set(oldId, newId)
  }
  return map
}

/* ---------------------------------------------------------------------------
 * Table classes, derived from the live schema (information_schema), never
 * from entity definitions: raw setup-tables.sql tables and runtime-created
 * tables are covered the same way.
 * ------------------------------------------------------------------------- */

export type ColumnInfo = { table: string; column: string; dataType: string }

export type TableClass =
  /** tenant_id + organization_id: rows move with their organization */
  | 'org'
  /** tenant_id, no organization_id: tenant-level rows */
  | 'tenant'
  /** organization_id, no tenant_id: re-encrypted only */
  | 'org_only'
  /** neither: child rows, re-encrypted through a foreign key to a moved row */
  | 'child'

export type TableInfo = {
  table: string
  cls: TableClass
  columns: ColumnInfo[]
  /** text / varchar / char / json / jsonb columns: where envelopes and literals live */
  scanColumns: Array<{ column: string; isJson: boolean }>
  uuidColumns: string[]
}

const TEXT_TYPES = new Set(['text', 'character varying', 'character', 'varchar', 'char', 'citext'])
const JSON_TYPES = new Set(['json', 'jsonb'])

export function classifyTables(columns: readonly ColumnInfo[]): Map<string, TableInfo> {
  const byTable = new Map<string, ColumnInfo[]>()
  for (const col of columns) {
    const list = byTable.get(col.table) ?? []
    list.push(col)
    byTable.set(col.table, list)
  }
  const out = new Map<string, TableInfo>()
  for (const [table, cols] of byTable) {
    const names = new Set(cols.map((c) => c.column))
    const hasTenant = names.has('tenant_id')
    const hasOrg = names.has('organization_id')
    const cls: TableClass = hasTenant && hasOrg ? 'org' : hasTenant ? 'tenant' : hasOrg ? 'org_only' : 'child'
    out.set(table, {
      table,
      cls: table === 'organizations' ? 'tenant' : cls,
      columns: cols,
      scanColumns: cols
        .filter((c) => TEXT_TYPES.has(c.dataType) || JSON_TYPES.has(c.dataType))
        .map((c) => ({ column: c.column, isJson: JSON_TYPES.has(c.dataType) })),
      uuidColumns: cols.filter((c) => c.dataType === 'uuid').map((c) => c.column),
    })
  }
  return out
}

/** Quote an identifier taken from the catalog (never from input). */
export function qi(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}
