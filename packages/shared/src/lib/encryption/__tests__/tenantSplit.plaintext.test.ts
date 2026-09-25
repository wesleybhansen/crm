import { encryptWithAesGcm } from '../aes'
import { countPlaintextMappedValues, type SplitQuery } from '../tenantSplit'

/*
 * 2026-09-25 review, H2: the split verifier counted envelopes only, so six
 * plaintext user emails "verified OK". Non-envelope values in any column an
 * active map lists are now counted (and fail the verification).
 */

const KEY = Buffer.alloc(32, 7).toString('base64')
const ORG = '11111111-0000-4000-8000-000000000001'

function fakeDb(rows: Record<string, Array<Record<string, unknown>>>): SplitQuery {
  return {
    async query(sql: string, params?: unknown[]) {
      if (/from encryption_maps/.test(sql)) {
        const entity = params?.[0]
        if (entity === 'auth:user') return { rows: [{ fields_json: [{ field: 'email', hashField: 'email_hash' }] }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      }
      const table = /from "?([a-z_]+)"? t/.exec(sql)?.[1] ?? ''
      const column = /select t\."?([a-z_]+)"? as v/.exec(sql)?.[1] ?? ''
      const out = (rows[table] ?? []).map((r) => ({ v: r[column] }))
      return { rows: out, rowCount: out.length }
    },
  }
}

const schema = {
  tables: new Map([
    ['users', { table: 'users', cls: 'org', columns: [{ table: 'users', column: 'id', dataType: 'uuid' }, { table: 'users', column: 'organization_id', dataType: 'uuid' }, { table: 'users', column: 'email', dataType: 'text' }], scanColumns: [], uuidColumns: [] }],
  ]),
  fks: [],
} as never

describe('countPlaintextMappedValues', () => {
  it('counts plaintext in a mapped column and ignores envelopes', async () => {
    const envelope = encryptWithAesGcm('ada@example.com', KEY).value
    const db = fakeDb({ users: [{ email: 'bob@example.com' }, { email: envelope }, { email: 'carol@example.com' }] })
    expect(await countPlaintextMappedValues(db, schema, [ORG])).toEqual([{ table: 'users', column: 'email', count: 2 }])
  })

  it('reports nothing when every mapped value is an envelope', async () => {
    const db = fakeDb({ users: [{ email: encryptWithAesGcm('ada@example.com', KEY).value }] })
    expect(await countPlaintextMappedValues(db, schema, [ORG])).toEqual([])
  })
})
