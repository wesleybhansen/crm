/**
 * In-memory stand-in for the handful of SQL statements the blind search index
 * issues (searchIndex.ts, searchIndexSync.ts, searchIndexBackfill.ts). Each
 * statement shape is recognised and executed with the same semantics in JS,
 * so tokenization, hashing, AND matching, org scoping and write-path upkeep
 * can be tested without a database. The SQL itself is exercised against a
 * real Postgres by searchIndex.pg.test.ts when a database URL is provided.
 */
import crypto from 'node:crypto'
import type { SearchSql } from '../../searchIndex'
import type { SearchBackfillDb } from '../../searchIndexBackfill'

export type TokenRow = {
  tenant_id: string
  organization_id: string
  entity_type: string
  entity_id: string
  field: string
  token_hash: string
}

export type Tables = {
  customer_entities: Array<Record<string, any>>
  customer_people: Array<Record<string, any>>
  customer_companies: Array<Record<string, any>>
  customer_deals: Array<Record<string, any>>
}

const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim()

export class FakeSearchDb implements SearchBackfillDb {
  tokens: TokenRow[] = []
  tables: Tables = { customer_entities: [], customer_people: [], customer_companies: [], customer_deals: [] }
  statements: string[] = []
  tableExists = true

  async transaction<T>(fn: (tx: SearchSql) => Promise<T>): Promise<T> {
    const snapshot = this.tokens.map((t) => ({ ...t }))
    try {
      return await fn(this)
    } catch (err) {
      this.tokens = snapshot
      throw err
    }
  }

  private liveContact(id: string) {
    return this.tables.customer_entities.find((r) => r.id === id && !r.deleted_at)
  }

  async query<T = Record<string, unknown>>(rawSql: string, params: unknown[]): Promise<T[]> {
    const sql = norm(rawSql)
    this.statements.push(sql)
    const p = [...params]

    if (/^(savepoint|release savepoint|rollback to savepoint)/.test(sql)) return []

    if (sql.startsWith(`select to_regclass('customer_search_tokens')`)) {
      return [{ t: this.tableExists ? 'customer_search_tokens' : null }] as T[]
    }

    if (sql.startsWith('insert into customer_search_tokens')) {
      const [tenants, orgs, types, ids, fields, hashes] = p as string[][]
      for (let i = 0; i < tenants.length; i++) {
        const row: TokenRow = {
          tenant_id: tenants[i]!, organization_id: orgs[i]!, entity_type: types[i]!,
          entity_id: ids[i]!, field: fields[i]!, token_hash: hashes[i]!,
        }
        const dup = this.tokens.some((t) => t.entity_id === row.entity_id && t.entity_type === row.entity_type && t.field === row.field && t.token_hash === row.token_hash)
        if (!dup) this.tokens.push(row)
      }
      return []
    }

    if (sql.startsWith('delete from customer_search_tokens where entity_id = ? and entity_type = ? and tenant_id = ? and field = any')) {
      const [id, type, tenant, fields] = p as [string, string, string, string[]]
      this.tokens = this.tokens.filter((t) => !(t.entity_id === id && t.entity_type === type && t.tenant_id === tenant && fields.includes(t.field)))
      return []
    }

    if (sql.startsWith('delete from customer_search_tokens where entity_id = ? and entity_type = any')) {
      const [id, types, fields] = p as [string, string[], string[]]
      this.tokens = this.tokens.filter((t) => !(t.entity_id === id && types.includes(t.entity_type) && fields.includes(t.field)))
      return []
    }

    if (sql.startsWith('delete from customer_search_tokens where entity_id = any')) {
      const ids = p.shift() as string[]
      const types = sql.includes('entity_type = any') ? (p.shift() as string[]) : null
      const fields = sql.includes('field = any') ? (p.shift() as string[]) : null
      this.tokens = this.tokens.filter((t) => !(ids.includes(t.entity_id) && (!types || types.includes(t.entity_type)) && (!fields || fields.includes(t.field))))
      return []
    }

    if (sql.includes('from customer_search_tokens t where t.tenant_id = ?') && sql.includes('having')) {
      const tenant = p.shift() as string
      const orgs = p.shift() as string[]
      const types = p.shift() as string[]
      const all = p.shift() as string[]
      const fields = sql.includes('t.field = any') ? (p.shift() as string[]) : null
      const termCount = (sql.match(/bool_or\(/g) ?? []).length
      const terms = p.splice(0, termCount) as string[][]
      const [limit, offset] = p as [number, number]
      const live = sql.includes('exists (select 1 from customer_deals')
      const candidates = this.tokens.filter((t) => t.tenant_id === tenant && orgs.includes(t.organization_id)
        && types.includes(t.entity_type) && all.includes(t.token_hash) && (!fields || fields.includes(t.field)))
      const groups = new Map<string, TokenRow[]>()
      for (const t of candidates) {
        const k = `${t.entity_id}|${t.entity_type}`
        groups.set(k, [...(groups.get(k) ?? []), t])
      }
      let matched = Array.from(groups.values())
        .filter((rows) => terms.every((hashes) => rows.some((r) => hashes.includes(r.token_hash))))
        .map((rows) => ({ entity_id: rows[0]!.entity_id, entity_type: rows[0]!.entity_type, rank: new Set(rows.map((r) => r.field)).size }))
      if (live) {
        matched = matched.filter((m) => m.entity_type === 'deal'
          ? this.tables.customer_deals.some((d) => d.id === m.entity_id && !d.deleted_at)
          : Boolean(this.liveContact(m.entity_id)))
      }
      matched.sort((a, b) => b.rank - a.rank || (a.entity_id < b.entity_id ? -1 : a.entity_id > b.entity_id ? 1 : 0))
      const total = matched.length
      return matched.slice(offset, offset + limit).map((m) => ({ ...m, total })) as T[]
    }

    if (sql.startsWith('select tenant_id, organization_id, kind from customer_entities where id = ?')) {
      const row = this.tables.customer_entities.find((r) => r.id === p[0])
      return (row ? [{ tenant_id: row.tenant_id, organization_id: row.organization_id, kind: row.kind }] : []) as T[]
    }
    if (sql.startsWith('select tenant_id, organization_id from customer_deals where id = ?')) {
      const row = this.tables.customer_deals.find((r) => r.id === p[0])
      return (row ? [{ tenant_id: row.tenant_id, organization_id: row.organization_id }] : []) as T[]
    }

    // Source reads (backfill batches and refreshSearchTokensForIds).
    const src = /from "?(customer_entities|customer_people|customer_companies|customer_deals)"? s/.exec(sql)
    if (sql.startsWith('select s.id,') && src) {
      const table = src[1] as keyof Tables
      const keyCol = /s\."?(\w+)"? as search_key/.exec(sql)![1]!
      let rows = [...this.tables[table]]
      if (sql.includes('where s.id = any')) {
        const ids = p[0] as string[]
        rows = rows.filter((r) => ids.includes(r.id))
      } else {
        const after = p.shift() as string | null
        p.shift()
        if (sql.includes('s.tenant_id = ?')) { const t = p.shift(); rows = rows.filter((r) => r.tenant_id === t) }
        if (sql.includes('s.organization_id = ?')) { const o = p.shift(); rows = rows.filter((r) => r.organization_id === o) }
        const limit = p.shift() as number
        rows = rows.filter((r) => !after || r.id > after).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, limit)
      }
      return rows.map((r) => {
        const parent = keyCol === 'id' ? r : this.tables.customer_entities.find((e) => e.id === r.entity_id)
        return {
          ...r,
          search_key: r[keyCol],
          kind: table === 'customer_deals' ? null : parent?.kind ?? null,
          parent_deleted_at: keyCol === 'id' ? r.deleted_at ?? null : parent?.deleted_at ?? null,
        }
      }) as T[]
    }

    if (sql.startsWith('select entity_id, entity_type, field, token_hash, tenant_id, organization_id from customer_search_tokens')) {
      const [ids, fields] = p as [string[], string[]]
      return this.tokens.filter((t) => ids.includes(t.entity_id) && fields.includes(t.field)) as unknown as T[]
    }

    if (sql.includes('from customer_search_tokens t where (')) {
      // Orphans (see ORPHAN_WHERE).
      const tenant = sql.includes('t.tenant_id = ?') ? (p.shift() as string) : null
      const org = sql.includes('t.organization_id = ?') ? (p.shift() as string) : null
      const personFields = ['first_name', 'last_name', 'preferred_name', 'job_title']
      const companyFields = ['legal_name', 'brand_name', 'domain', 'website_url']
      const isOrphan = (t: TokenRow) => {
        if (tenant && t.tenant_id !== tenant) return false
        if (org && t.organization_id !== org) return false
        if (t.entity_type === 'deal') {
          return !this.tables.customer_deals.some((d) => d.id === t.entity_id && !d.deleted_at && d.tenant_id === t.tenant_id && d.organization_id === t.organization_id)
        }
        const ce = this.liveContact(t.entity_id)
        if (!ce || ce.kind !== t.entity_type || ce.tenant_id !== t.tenant_id || ce.organization_id !== t.organization_id) return true
        if (personFields.includes(t.field) && !this.tables.customer_people.some((x) => x.entity_id === t.entity_id)) return true
        if (companyFields.includes(t.field) && !this.tables.customer_companies.some((x) => x.entity_id === t.entity_id)) return true
        return false
      }
      if (sql.startsWith('select count(*)')) return [{ n: this.tokens.filter(isOrphan).length }] as T[]
      if (sql.startsWith('delete from')) { this.tokens = this.tokens.filter((t) => !isOrphan(t)); return [] }
    }

    throw new Error(`FakeSearchDb: unsupported statement: ${sql.slice(0, 120)}`)
  }
}

/** A DEK source + decrypt stand-in: plaintext rows pass through; `UNREADABLE` values fail. */
export const UNREADABLE = 'aaaa:bbbb:cccc:v2:0011aabb'

export function fakeService(opts: { noKeyFor?: string[] } = {}) {
  return {
    async getDek(tenantId: string | null | undefined) {
      if (!tenantId || opts.noKeyFor?.includes(tenantId)) return null
      // Deterministic per-tenant "DEK", like the derived KMS scheme.
      return { tenantId, key: crypto.createHash('sha256').update(`dek:${tenantId}`).digest('base64'), fetchedAt: 0 }
    },
    async decryptEntityPayloadForDisplay(_entityId: string, payload: Record<string, unknown>) {
      const out: Record<string, unknown> = { ...payload }
      const failed: string[] = []
      for (const [k, v] of Object.entries(out)) {
        if (v === UNREADABLE) { out[k] = 'This record could not be decrypted. Contact support.'; failed.push(k) }
      }
      return { payload: out, undecryptableFields: failed }
    },
  }
}
