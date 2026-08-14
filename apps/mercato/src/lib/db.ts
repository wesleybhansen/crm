import { Pool } from 'pg'

function createPool() {
  return new Pool({ connectionString: process.env.DATABASE_URL, max: 5 })
}

type PoolInstance = ReturnType<typeof createPool>

let _pool: PoolInstance | null = null

function getPool(): PoolInstance {
  if (!_pool) {
    _pool = createPool()
  }
  return _pool
}

export async function query(text: string, params?: any[]) {
  const pool = getPool()
  const result = await pool.query(text, params)
  return result.rows
}

export async function queryOne(text: string, params?: any[]) {
  const rows = await query(text, params)
  return rows[0] || null
}
