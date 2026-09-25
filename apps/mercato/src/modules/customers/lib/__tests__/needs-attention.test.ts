import { buildAttentionItems, isAutomatedOrSystemSender, senderAddress, type AttentionRow } from '../needs-attention'

const row = (over: Partial<AttentionRow>): AttentionRow => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  subject: 'Invoice question',
  from_address: 'pat@client.com',
  sentiment: 'urgent',
  contact_id: 'c1',
  created_at: '2026-09-24T10:00:00Z',
  ...over,
})

describe('isAutomatedOrSystemSender', () => {
  it('flags Noli system mailboxes and no-reply senders anywhere', () => {
    expect(isAutomatedOrSystemSender('notifications@noliai.com')).toBe(true)
    expect(isAutomatedOrSystemSender('Noli Alerts <alerts@mail.noliai.com>')).toBe(true)
    expect(isAutomatedOrSystemSender('no-reply@stripe.com')).toBe(true)
    expect(isAutomatedOrSystemSender('MAILER-DAEMON@gmail.com')).toBe(true)
  })

  it('keeps real people, including a person at noliai.com', () => {
    expect(isAutomatedOrSystemSender('pat@client.com')).toBe(false)
    expect(isAutomatedOrSystemSender('wesley@noliai.com')).toBe(false)
    expect(isAutomatedOrSystemSender('notifications@client.com')).toBe(false)
    expect(isAutomatedOrSystemSender(null)).toBe(false)
  })

  it('reads the address out of a display-name form', () => {
    expect(senderAddress('Pat Doe <Pat@Client.com>')).toBe('pat@client.com')
  })
})

describe('buildAttentionItems', () => {
  it('drops system mail and collapses repeats into one row with a count', () => {
    const rows: AttentionRow[] = [
      ...Array.from({ length: 10 }, (_, i) => row({
        id: `h${i}`, subject: 'Hermes upgrade control alert: backup or drift', from_address: 'notifications@noliai.com', contact_id: null,
        created_at: `2026-09-24T0${i}:00:00Z`,
      })),
      row({ id: 'a1', created_at: '2026-09-24T08:00:00Z' }),
      row({ id: 'a2', subject: 'RE: Invoice question', created_at: '2026-09-24T09:00:00Z' }),
      row({ id: 'a3', subject: 'Invoice question', from_address: 'Pat <PAT@client.com>', created_at: '2026-09-23T09:00:00Z' }),
      row({ id: 'b1', subject: 'Cancel my plan', sentiment: 'negative', from_address: 'sam@else.com', contact_name: 'Sam', created_at: '2026-09-24T11:00:00Z' }),
    ]
    const items = buildAttentionItems(rows)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ id: 'b1', type: 'negative', title: 'Negative: Cancel my plan', description: 'From Sam', count: 1 })
    expect(items[1]).toMatchObject({ id: 'a2', type: 'urgent', count: 3, description: 'From pat@client.com · 3 emails' })
  })

  it('caps the list', () => {
    const rows = Array.from({ length: 15 }, (_, i) => row({ id: `r${i}`, subject: `Subject ${i}` }))
    expect(buildAttentionItems(rows, 10)).toHaveLength(10)
  })
})
