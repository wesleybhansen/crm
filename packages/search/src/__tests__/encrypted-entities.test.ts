import { VectorSearchStrategy } from '../strategies/vector.strategy'
import type { IndexableRecord } from '../types'

/**
 * Contacts, companies and deals are encrypted at rest. The vector store kept
 * their names and emails in clear (result_title, presenter, links) and sent
 * them to the embedding provider. They are no longer embedded unless
 * SEARCH_VECTOR_INDEX_ENCRYPTED=true, and even then no display text is stored.
 */
function harness() {
  const upserts: any[] = []
  const deletes: any[] = []
  const driver = {
    id: 'pgvector',
    ensureReady: async () => {},
    upsert: async (doc: any) => { upserts.push(doc) },
    delete: async (...args: any[]) => { deletes.push(args) },
    query: async () => [],
  }
  const embeddings: string[] = []
  const embeddingService = { available: true, createEmbedding: async (text: string) => { embeddings.push(text); return [0.1, 0.2] } }
  const strategy = new VectorSearchStrategy(embeddingService, driver as any)
  return { strategy, upserts, deletes, embeddings }
}

const contact: IndexableRecord = {
  entityId: 'customers:customer_person_profile' as any,
  recordId: 'p1',
  tenantId: 't1',
  organizationId: 'o1',
  fields: { first_name: 'Ada', last_name: 'Lovelace' },
  presenter: { title: 'Ada Lovelace', subtitle: 'ada@example.com' },
  links: [{ href: '/backend/customers/people/p1', label: 'Ada Lovelace' }],
  text: 'Ada Lovelace ada@example.com',
}

afterEach(() => { delete process.env.SEARCH_VECTOR_INDEX_ENCRYPTED })

describe('vector indexing of encrypted-by-design entities', () => {
  it('does not embed contacts by default and removes an existing entry', async () => {
    const h = harness()
    await h.strategy.index(contact)
    expect(h.upserts).toEqual([])
    expect(h.embeddings).toEqual([])
    expect(h.deletes).toEqual([['customers:customer_person_profile', 'p1', 't1']])
  })

  it('opted in: embeds, but stores no display text', async () => {
    process.env.SEARCH_VECTOR_INDEX_ENCRYPTED = 'true'
    const h = harness()
    await h.strategy.index(contact)
    expect(h.upserts).toHaveLength(1)
    const doc = h.upserts[0]
    expect(doc.presenter).toBeUndefined()
    expect(doc.links).toBeUndefined()
    expect(doc.resultTitle).toBe('p1')
    expect(doc.resultSubtitle).toBeUndefined()
    expect(JSON.stringify(doc)).not.toMatch(/Lovelace|ada@example/)
  })

  it('keeps indexing entities without encrypted fields as before', async () => {
    const h = harness()
    await h.strategy.index({ ...contact, entityId: 'customers:customer_todo_link' as any, presenter: { title: 'Call back' } })
    expect(h.upserts).toHaveLength(1)
    expect(h.upserts[0].resultTitle).toBe('Call back')
  })
})
