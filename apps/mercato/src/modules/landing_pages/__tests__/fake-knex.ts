/**
 * A small in-memory stand-in for the knex query builder, covering what the
 * public checkout and the Stripe webhook use: where / orWhere (including
 * nested callbacks and operators), whereNull, whereIn, first, thenable
 * selects, lazy inserts with unique constraints and onConflict().ignore(),
 * update (returns the row count), count, increment, raw.
 */
type Row = Record<string, any>
type Pred = (row: Row) => boolean

export type FakeKnexOptions = {
  /** Unique column sets per table; an insert that collides throws 23505. */
  unique?: Record<string, string[][]>
}

export type FakeKnex = ((table: string) => any) & { raw: (...args: any[]) => any; tables: Record<string, Row[]> }

function compare(a: any, op: string, b: any): boolean {
  const norm = (v: any) => (v instanceof Date ? v.getTime() : v)
  const x = norm(a)
  const y = norm(b)
  switch (op) {
    case '=': return x === y
    case '!=': case '<>': return x !== y
    case '>': return x > y
    case '>=': return x >= y
    case '<': return x != null && x < y
    case '<=': return x != null && x <= y
    default: throw new Error(`fake knex: unsupported operator ${op}`)
  }
}

function group() {
  const clauses: Array<{ pred: Pred; or: boolean }> = []
  const api: any = {}
  const add = (or: boolean, args: any[]) => {
    clauses.push({ pred: predFromArgs(args), or })
    return api
  }
  api.where = (...args: any[]) => add(false, args)
  api.andWhere = api.where
  api.orWhere = (...args: any[]) => add(true, args)
  api.whereNull = (c: string) => add(false, [(r: Row) => r[col(c)] == null, '__pred'])
  api.whereNotNull = (c: string) => add(false, [(r: Row) => r[col(c)] != null, '__pred'])
  api.whereIn = (c: string, values: any[]) => add(false, [(r: Row) => values.includes(r[col(c)]), '__pred'])
  const pred: Pred = (row) => {
    let result = true
    clauses.forEach((c, i) => {
      if (i === 0) result = c.pred(row)
      else result = c.or ? result || c.pred(row) : result && c.pred(row)
    })
    return result
  }
  return { api, pred }
}

/** "fo.session_id" -> "session_id" (aliases are ignored; one table per query). */
const col = (name: string) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name)

function predFromArgs(args: any[]): Pred {
  if (args[1] === '__pred') return args[0]
  if (typeof args[0] === 'string') args = [col(args[0]), ...args.slice(1)]
  if (typeof args[0] === 'function') {
    const g = group()
    args[0].call(g.api, g.api)
    return g.pred
  }
  if (args[0] && typeof args[0] === 'object') {
    const obj = args[0]
    return (row) => Object.entries(obj).every(([k, v]) => row[k] === v)
  }
  if (args.length === 2) return (row) => row[args[0]] === args[1]
  return (row) => compare(row[args[0]], String(args[1]), args[2])
}

export function createFakeKnex(tables: Record<string, Row[]>, options: FakeKnexOptions = {}): FakeKnex {
  const unique = options.unique ?? {}

  const knex: any = (tableRef: string) => {
    const table = tableRef.split(/\s+as\s+/i)[0].trim()
    const g = group()
    let orderCol: string | null = null
    let orderDir: 'asc' | 'desc' = 'asc'
    const rows = () => {
      const list = (tables[table] ?? []).filter(g.pred)
      if (orderCol) {
        const k = orderCol
        list.sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * (orderDir === 'desc' ? -1 : 1))
      }
      return list
    }
    const q: any = g.api
    const wrap = (name: string) => {
      const fn = q[name]
      q[name] = (...args: any[]) => { fn(...args); return q }
    }
    ;['where', 'andWhere', 'orWhere', 'whereNull', 'whereNotNull', 'whereIn'].forEach(wrap)
    q.select = () => q
    q.leftJoin = () => q
    q.orderBy = (c: string, dir?: string) => { orderCol = col(c); orderDir = dir === 'desc' ? 'desc' : 'asc'; return q }
    q.first = async () => rows()[0]
    q.then = (resolve: any, reject: any) => Promise.resolve(rows()).then(resolve, reject)
    q.update = (patch: Row) => {
      const matched = rows()
      for (const row of matched) Object.assign(row, patch)
      return Promise.resolve(matched.length)
    }
    q.increment = (col: string, by = 1) => {
      const matched = rows()
      for (const row of matched) row[col] = (Number(row[col]) || 0) + by
      return Promise.resolve(matched.length)
    }
    q.count = () => Promise.resolve([{ count: rows().length }])
    q.delete = () => {
      const matched = new Set(rows())
      tables[table] = (tables[table] ?? []).filter((r) => !matched.has(r))
      return Promise.resolve(matched.size)
    }
    q.insert = (value: Row | Row[]) => {
      let ignoreConflicts = false
      const run = () => {
        const list = Array.isArray(value) ? value : [value]
        const target = (tables[table] ??= [])
        for (const row of list) {
          const collides = (unique[table] ?? []).some((cols) =>
            target.some((existing) => cols.every((c) => existing[c] != null && existing[c] === row[c])),
          )
          if (collides) {
            if (ignoreConflicts) continue
            const err: any = new Error(`duplicate key value violates unique constraint on ${table}`)
            err.code = '23505'
            throw err
          }
          target.push({ ...row })
        }
        return list.length
      }
      const pending: any = {
        onConflict: () => ({ ignore: () => { ignoreConflicts = true; return pending }, merge: () => pending }),
        returning: () => pending,
        then: (resolve: any, reject: any) => {
          try {
            return Promise.resolve(run()).then(resolve, reject)
          } catch (err) {
            return Promise.reject(err).then(resolve, reject)
          }
        },
        catch: (handler: any) => pending.then(undefined, handler),
      }
      return pending
    }
    return q
  }
  knex.raw = (sql: string, bindings?: unknown) => ({ __raw: true, sql, bindings, then: (r: any) => Promise.resolve({ rows: [] }).then(r) })
  knex.tables = tables
  return knex as FakeKnex
}
