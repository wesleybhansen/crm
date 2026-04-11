import { Pool } from 'pg'

let _pool: Pool | null = null

function getPool(): Pool {
  if (!_pool) {
    _pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 })
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
