import { createFakeDb } from '../../../../lib/__tests__/support/fake-db'
import { extractCommitmentsForContact } from '../commitments'

const T = 'tenant-1'
const O = 'org-1'
const CONTACT = 'contact-1'

function geminiReply(items: unknown[]) {
  return {
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify(items) }] } }],
      usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30 },
    }),
  }
}

function mail(id: string, createdAt: string, body: string, tenantId = T) {
  return {
    id,
    organization_id: O,
    tenant_id: tenantId,
    contact_id: CONTACT,
    direction: 'inbound',
    subject: 'Showing',
    body_text: body,
    body_html: null,
    created_at: new Date(createdAt),
  }
}

describe('extractCommitmentsForContact (run by the Customer Service processor)', () => {
  const fetchMock = jest.fn()
  const realFetch = global.fetch

  beforeEach(() => {
    fetchMock.mockReset()
    ;(global as any).fetch = fetchMock
  })
  afterAll(() => {
    ;(global as any).fetch = realFetch
  })

  function db() {
    return createFakeDb({
      email_messages: [
        mail('m-1', '2026-09-20T10:00:00Z', 'I will send the signed disclosures by Friday.'),
        mail('m-foreign', '2026-09-21T10:00:00Z', 'OTHER TENANT SECRET', 'tenant-2'),
      ],
      customer_entities: [{ id: CONTACT, organization_id: O, tenant_id: T, commitments_extracted_at: null }],
      commitments: [],
    })
  }

  it('stores new commitments tagged with the message, then does not re-run for the same mail', async () => {
    const knex = db()
    fetchMock.mockResolvedValueOnce(geminiReply([
      { direction: 'theirs', description: 'They will send the signed disclosures by Friday.', dueDate: '2026-09-25' },
    ]))

    const first = await extractCommitmentsForContact(knex as any, 'key', O, T, CONTACT, { sourceRef: 'm-1' })
    expect(first.created).toBe(1)
    expect(first.tokensIn).toBe(120)
    expect(knex.db.tables.commitments).toEqual([
      expect.objectContaining({ organization_id: O, tenant_id: T, contact_id: CONTACT, direction: 'theirs', source: 'email', source_ref: 'm-1' }),
    ])
    // Only this tenant's mail went to the model.
    expect(String(fetchMock.mock.calls[0][1].body)).not.toContain('OTHER TENANT SECRET')

    // Same mail again (a retried run): no model call, nothing billed.
    const second = await extractCommitmentsForContact(knex as any, 'key', O, T, CONTACT, { sourceRef: 'm-1' })
    expect(second).toEqual(expect.objectContaining({ created: 0, tokensIn: 0, tokensOut: 0 }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('runs again for a newer message and never duplicates a tracked commitment', async () => {
    const knex = db()
    const promise = { direction: 'theirs', description: 'They will send the signed disclosures by Friday.', dueDate: null }
    fetchMock.mockResolvedValueOnce(geminiReply([promise]))
    await extractCommitmentsForContact(knex as any, 'key', O, T, CONTACT, { sourceRef: 'm-1' })

    knex.db.tables.email_messages.push(mail('m-2', '2099-01-01T00:00:00Z', 'Also, we will schedule the inspection.'))
    fetchMock.mockResolvedValueOnce(geminiReply([
      promise,
      { direction: 'ours', description: 'We will schedule the home inspection next week.', dueDate: null },
    ]))
    const next = await extractCommitmentsForContact(knex as any, 'key', O, T, CONTACT, { sourceRef: 'm-2' })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(next.created).toBe(1)
    expect(knex.db.tables.commitments.map((c: any) => c.source_ref)).toEqual(['m-1', 'm-2'])
  })
})
