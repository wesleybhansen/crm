import { isMissingDatabaseRelation } from '../postgres-errors'

describe('isMissingDatabaseRelation', () => {
  it('recognizes PostgreSQL undefined-table errors and wrapped causes', () => {
    expect(isMissingDatabaseRelation({ code: '42P01' })).toBe(true)
    expect(isMissingDatabaseRelation({ cause: { code: '42P01' } })).toBe(true)
  })

  it('does not suppress other database or application errors', () => {
    expect(isMissingDatabaseRelation({ code: '23505' })).toBe(false)
    expect(isMissingDatabaseRelation(new Error('failed'))).toBe(false)
  })
})
