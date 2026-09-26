/**
 * An in-memory stand-in for the knex query builder, covering what the outbox,
 * automation dispatch and Assisted-reply paths use: where trees (with nested
 * callbacks and comparison operators), whereIn/whereNull/whereNot, a few
 * jsonb whereRaw shapes, inner joins, orderBy/limit, first/select, count,
 * update (including knex.raw('col + 1')), and insert with unique keys and
 * onConflict().ignore().returning(). Anything else throws, so a test cannot
 * pass by accident.
 */
type Row = Record<string, any>
type Pred = (row: Row) => boolean

export type FakeDb = {
  tables: Record<string, Row[]>
  uniques: Record<string, string[][]>
}

type Raw = { __raw: string }

function isRaw(value: unknown): value is Raw {
  return !!value && typeof value === 'object' && typeof (value as Raw).__raw === 'string'
}

function parseJson(value: unknown): any {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function compare(a: any, b: any): number {
  const av = a instanceof Date ? a.getTime() : a
  const bv = b instanceof Date ? b.getTime() : b
  if (av === bv) return 0
  return av < bv ? -1 : 1
}

class Builder {
  private preds: Array<{ or: boolean; p: Pred }> = []
  private cols: string[] | null = null
  private lim: number | null = null
  private orders: Array<{ col: string; dir: 'asc' | 'desc' }> = []
  private joins: Array<{ table: string; alias: string; left: string; right: string }> = []
  private countAlias: string | null = null
  private distinctCols: string[] | null = null
  private pendingInsert: Row[] | null = null
  private conflictCols: string[] | null = null
  private returningCols: string[] | null = null

  constructor(private readonly db: FakeDb, private readonly table: string | null, private readonly alias: string | null) {}

  private get(row: Row, col: string): any {
    if (col in row) return row[col]
    const bare = col.includes('.') ? col.split('.').pop()! : col
    if (bare in row) return row[bare]
    const key = Object.keys(row).find((k) => k.endsWith(`.${bare}`))
    return key ? row[key] : undefined
  }

  private add(or: boolean, p: Pred) {
    this.preds.push({ or, p })
    return this
  }

  private toPred(args: any[]): Pred {
    const [a, b, c] = args
    if (typeof a === 'function') {
      const sub = new Builder(this.db, null, null)
      a.call(sub, sub)
      return (r) => sub.matches(r)
    }
    if (a && typeof a === 'object') return (r) => Object.entries(a).every(([k, v]) => this.get(r, k) === v)
    if (args.length === 3) {
      const ops: Record<string, (x: any, y: any) => boolean> = {
        '=': (x, y) => compare(x, y) === 0,
        '<': (x, y) => x != null && compare(x, y) < 0,
        '<=': (x, y) => x != null && compare(x, y) <= 0,
        '>': (x, y) => x != null && compare(x, y) > 0,
        '>=': (x, y) => x != null && compare(x, y) >= 0,
      }
      const op = ops[b]
      if (!op) throw new Error(`fake-db: operator ${b}`)
      return (r) => op(this.get(r, a), c)
    }
    return (r) => this.get(r, a) === b
  }

  matches(row: Row): boolean {
    let result = true
    let first = true
    for (const { or, p } of this.preds) {
      if (first) {
        result = p(row)
        first = false
        continue
      }
      result = or ? result || p(row) : result && p(row)
    }
    return result
  }

  where(...args: any[]) { return this.add(false, this.toPred(args)) }
  andWhere(...args: any[]) { return this.where(...args) }
  orWhere(...args: any[]) { return this.add(true, this.toPred(args)) }
  whereNot(col: string, val: any) { return this.add(false, (r) => this.get(r, col) !== val) }
  whereNull(col: string) { return this.add(false, (r) => this.get(r, col) == null) }
  whereNotNull(col: string) { return this.add(false, (r) => this.get(r, col) != null) }
  whereIn(col: string, vals: any[]) { return this.add(false, (r) => vals.includes(this.get(r, col))) }
  whereNotIn(col: string, vals: any[]) { return this.add(false, (r) => !vals.includes(this.get(r, col))) }
  orWhereIn(col: string, vals: any[]) { return this.add(true, (r) => vals.includes(this.get(r, col))) }
  whereRaw(sql: string, bindings: any[] = []) {
    const isNull = /^(\w+)->>'(\w+)' is null$/i.exec(sql.trim())
    if (isNull) {
      const [, col, key] = isNull
      return this.add(false, (r) => parseJson(this.get(r, col!))?.[key!] == null)
    }
    const m = /^(\w+)->>'(\w+)' = (\?|'[^']*')$/.exec(sql.trim())
    if (!m) throw new Error(`fake-db: unsupported whereRaw: ${sql}`)
    const [, col, key, rhs] = m
    const expected = rhs === '?' ? bindings[0] : rhs!.slice(1, -1)
    return this.add(false, (r) => {
      const value = parseJson(this.get(r, col!))?.[key!]
      return value != null && String(value) === String(expected)
    })
  }
  join(table: string, left: string, right: string) {
    const [name, alias] = table.split(/\s+as\s+/i)
    this.joins.push({ table: name!, alias: alias ?? name!, left, right })
    return this
  }
  orderBy(col: string, dir: 'asc' | 'desc' = 'asc') { this.orders.push({ col, dir }); return this }
  limit(n: number) { this.lim = n; return this }
  select(...cols: any[]) { this.cols = cols.flat(); return this }
  distinct(...cols: any[]) { this.cols = cols.flat(); this.distinctCols = cols.flat(); return this }
  count(spec: string) {
    const m = /\s+as\s+(\w+)$/i.exec(spec)
    this.countAlias = m ? m[1]! : 'count'
    return this
  }

  private baseRows(): Row[] {
    const base = (this.db.tables[this.table!] ??= [])
    if (!this.joins.length) return base
    const alias = this.alias ?? this.table!
    let rows: Row[] = base.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [`${alias}.${k}`, v])))
    for (const j of this.joins) {
      const other = this.db.tables[j.table] ?? []
      const next: Row[] = []
      for (const r of rows) {
        for (const o of other) {
          const merged = { ...r, ...Object.fromEntries(Object.entries(o).map(([k, v]) => [`${j.alias}.${k}`, v])) }
          if (this.get(merged, j.left) === this.get(merged, j.right)) next.push(merged)
        }
      }
      rows = next
    }
    return rows
  }

  private rows(): Row[] {
    let out = this.baseRows().filter((r) => this.matches(r))
    for (const { col, dir } of [...this.orders].reverse()) {
      out = [...out].sort((a, b) => (dir === 'desc' ? -1 : 1) * compare(this.get(a, col), this.get(b, col)))
    }
    if (this.lim != null) out = out.slice(0, this.lim)
    return out
  }

  private project(r: Row, cols: string[] | null): Row {
    if (!cols || !cols.length || cols.includes('*')) {
      if (!this.joins.length) return { ...r }
      return Object.fromEntries(Object.entries(r).map(([k, v]) => [k.split('.').pop()!, v]))
    }
    const o: Row = {}
    for (const c of cols) {
      const [src, as] = String(c).split(/\s+as\s+/i)
      o[(as ?? src!).split('.').pop()!] = this.get(r, src!)
    }
    return o
  }

  async first(...cols: any[]) {
    if (this.countAlias) return { [this.countAlias]: this.rows().length }
    const r = this.rows()[0]
    return r ? this.project(r, cols.length ? cols.flat() : this.cols) : undefined
  }

  async update(patch: Row) {
    const rows = this.rows()
    for (const r of rows) {
      for (const [k, v] of Object.entries(patch)) {
        if (isRaw(v)) {
          const m = /^(\w+) \+ (\d+)$/.exec(v.__raw)
          if (!m) throw new Error(`fake-db: unsupported raw update ${v.__raw}`)
          r[k] = Number(r[m[1]!] ?? 0) + Number(m[2])
        } else {
          r[k] = v
        }
      }
    }
    return rows.length
  }

  async del() {
    const table = (this.db.tables[this.table!] ??= [])
    const doomed = new Set(this.rows())
    this.db.tables[this.table!] = table.filter((r) => !doomed.has(r))
    return doomed.size
  }

  insert(row: Row | Row[]) {
    this.pendingInsert = Array.isArray(row) ? row : [row]
    return this
  }
  onConflict(cols: string[]) { this.conflictCols = cols; return this }
  ignore() { return this }
  returning(cols: string | string[]) { this.returningCols = Array.isArray(cols) ? cols : [cols]; return this }

  private runInsert(): any {
    const table = (this.db.tables[this.table!] ??= [])
    const keys = this.db.uniques[this.table!] ?? []
    const inserted: Row[] = []
    for (const raw of this.pendingInsert!) {
      const row = { id: raw.id ?? `id-${table.length + 1}-${Math.random().toString(36).slice(2, 8)}`, ...raw }
      const clash = keys.some((cols) => table.some((t) => cols.every((c) => t[c] === row[c])))
      if (clash) {
        if (this.conflictCols) continue
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' })
      }
      table.push(row)
      inserted.push(row)
    }
    if (this.returningCols) return inserted.map((r) => this.project(r, this.returningCols))
    return inserted.length
  }

  then(resolve: (v: any) => unknown, reject?: (e: unknown) => unknown) {
    try {
      if (this.pendingInsert) return Promise.resolve(resolve(this.runInsert()))
      if (this.countAlias) return Promise.resolve(resolve([{ [this.countAlias]: this.rows().length }]))
      let projected = this.rows().map((r) => this.project(r, this.cols))
      if (this.distinctCols) {
        const seen = new Set<string>()
        projected = projected.filter((r) => {
          const key = JSON.stringify(this.distinctCols!.map((c) => r[c.split('.').pop()!]))
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
      }
      return Promise.resolve(resolve(projected))
    } catch (e) {
      return reject ? Promise.resolve(reject(e)) : Promise.reject(e)
    }
  }

  catch(onRejected: (e: unknown) => unknown) {
    return this.then((v) => v, onRejected)
  }
}

export function createFakeDb(tables: Record<string, Row[]> = {}, uniques: Record<string, string[][]> = {}) {
  const db: FakeDb = { tables, uniques }
  const knex: any = (table: string) => {
    const [name, alias] = table.split(/\s+as\s+/i)
    return new Builder(db, name!, alias ?? null)
  }
  knex.raw = (sql: string) => ({ __raw: sql })
  knex.db = db
  return knex as ((table: string) => any) & { db: FakeDb; raw: (sql: string) => Raw }
}
