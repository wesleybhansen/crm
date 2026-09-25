/**
 * A small in-memory stand-in for the knex query builder, enough for the
 * contact lookup / suppression / dedupe paths under test. It evaluates the
 * same where-trees knex would build (including nested callbacks that use
 * `this`), and understands the handful of whereRaw fragments the lookup
 * helpers emit. Anything else throws, so a test cannot pass by accident.
 */
type Row = Record<string, any>
type Pred = (row: Row) => boolean

const RAW: Array<[RegExp, (m: RegExpExecArray, b: any[]) => Pred]> = [
  [/^false$/i, () => () => false],
  [/^([\w.]+) != ''$/i, (m) => (r) => String(get(r, m[1]!) ?? '') !== ''],
  [/^lower\(([\w.]+)\) = \?$/i, (m, b) => (r) => String(get(r, m[1]!) ?? '').toLowerCase() === b[0]],
  [/^lower\(([\w.]+)\) = any\(\?\)$/i, (m, b) => (r) => (b[0] as string[]).includes(String(get(r, m[1]!) ?? '').toLowerCase())],
  [
    /^regexp_replace\(coalesce\(([\w.]+), ''\), '\\D', '', 'g'\) = \?$/i,
    (m, b) => (r) => String(get(r, m[1]!) ?? '').replace(/\D/g, '') === b[0],
  ],
]

function get(row: Row, col: string): any {
  const key = col.includes('.') ? col.split('.').pop()! : col
  return row[key]
}

class Builder {
  private preds: Array<{ or: boolean; p: Pred }> = []
  private cols: string[] | null = null
  private lim: number | null = null
  private group: string | null = null
  private minGroupSize = 0

  constructor(private readonly db: FakeKnexDb, private readonly table: string | null) {}

  private add(or: boolean, p: Pred) { this.preds.push({ or, p }); return this }
  private toPred(args: any[]): Pred {
    const [a, b, c] = args
    if (typeof a === 'function') {
      const sub = new Builder(this.db, null)
      a.call(sub, sub)
      return (r) => sub.matches(r)
    }
    if (a && typeof a === 'object') return (r) => Object.entries(a).every(([k, v]) => get(r, k) === v)
    if (args.length === 3) {
      if (b === '=') return (r) => get(r, a) === c
      if (b === '<') return (r) => get(r, a) < c
      if (b === '>') return (r) => get(r, a) > c
      throw new Error(`fake-knex: operator ${b}`)
    }
    return (r) => get(r, a) === b
  }
  matches(row: Row): boolean {
    let result = true
    let first = true
    for (const { or, p } of this.preds) {
      if (first) { result = p(row); first = false; continue }
      result = or ? result || p(row) : result && p(row)
    }
    return result
  }

  where(...args: any[]) { return this.add(false, this.toPred(args)) }
  andWhere(...args: any[]) { return this.where(...args) }
  orWhere(...args: any[]) { return this.add(true, this.toPred(args)) }
  whereNot(col: string, val: any) { return this.add(false, (r) => get(r, col) !== val) }
  whereNull(col: string) { return this.add(false, (r) => get(r, col) == null) }
  whereNotNull(col: string) { return this.add(false, (r) => get(r, col) != null) }
  whereIn(col: string, vals: any[]) { return this.add(false, (r) => vals.includes(get(r, col))) }
  whereRaw(sql: string, bindings: any[] = []) {
    for (const [re, make] of RAW) {
      const m = re.exec(sql.trim())
      if (m) return this.add(false, make(m, bindings))
    }
    throw new Error(`fake-knex: unsupported whereRaw: ${sql}`)
  }
  modify(fn: (qb: Builder) => void) { fn(this); return this }
  orderBy() { return this }
  groupBy(col: string) { this.group = col; return this }
  havingRaw(sql: string) {
    const m = /^count\(\*\) > (\d+)$/i.exec(sql.trim())
    if (!m) throw new Error(`fake-knex: unsupported havingRaw: ${sql}`)
    this.minGroupSize = Number(m[1]) + 1
    return this
  }
  limit(n: number) { this.lim = n; return this }
  select(...cols: any[]) { this.cols = cols.flat(); return this }

  private rows(): Row[] {
    const all = (this.db.tables[this.table!] ??= [])
    let out = all.filter((r) => this.matches(r))
    if (this.group) {
      const counts = new Map<unknown, Row[]>()
      for (const r of out) counts.set(get(r, this.group), [...(counts.get(get(r, this.group)) ?? []), r])
      out = Array.from(counts.values()).filter((g) => g.length >= this.minGroupSize).map((g) => g[0]!)
    }
    if (this.lim != null) out = out.slice(0, this.lim)
    return out
  }
  private project(r: Row): Row {
    if (!this.cols) return { ...r }
    const o: Row = {}
    for (const c of this.cols) {
      const [src, alias] = String(c).split(/\s+as\s+/i)
      o[(alias ?? src!).split('.').pop()!] = get(r, src!)
    }
    return o
  }
  async first() { const r = this.rows()[0]; return r ? this.project(r) : undefined }
  async update(patch: Row) {
    const rows = this.rows()
    for (const r of rows) Object.assign(r, patch)
    this.db.log.push({ op: 'update', table: this.table!, ids: rows.map((r) => r.id), patch })
    return rows.length
  }
  async insert(row: Row | Row[]) {
    const list = Array.isArray(row) ? row : [row]
    ;(this.db.tables[this.table!] ??= []).push(...list.map((r) => ({ ...r })))
    this.db.log.push({ op: 'insert', table: this.table!, rows: list })
    return list.length
  }
  then(resolve: (v: Row[]) => unknown, reject?: (e: unknown) => unknown) {
    try { return Promise.resolve(resolve(this.rows().map((r) => this.project(r)))) } catch (e) { return reject ? reject(e) : Promise.reject(e) }
  }
  catch() { return this }
}

export type FakeKnexDb = {
  tables: Record<string, Row[]>
  log: Array<{ op: 'update' | 'insert'; table: string; ids?: string[]; patch?: Row; rows?: Row[] }>
}

export function createFakeKnex(tables: Record<string, Row[]>) {
  const db: FakeKnexDb = { tables, log: [] }
  const knex: any = (table: string) => new Builder(db, table.split(/\s+as\s+/i)[0]!)
  knex.db = db
  return knex as ((table: string) => any) & { db: FakeKnexDb }
}
