/** @jest-environment node */
import type { Knex } from 'knex'
import { espOwnFromAddress, hasSendingSetup, resolveSenderAddress } from '../routing-service'
import { automationSendsEmail, EMAIL_NOT_SENT_NOT_CONNECTED, getEmailSendingGap } from '../sending-readiness'
import { sendEmailByPurpose } from '../email-router'

type Row = Record<string, any>

// Minimal knex stand-in: equality filters, whereNull, first/select, insert.
function fakeKnex(tables: Record<string, Row[]>) {
  const inserts: Array<{ table: string; row: Row }> = []
  const knex = ((name: string) => {
    const table = name.split(' as ')[0]
    const filters: Array<(row: Row) => boolean> = []
    const q: any = {
      where: (field: any, value?: any) => {
        if (typeof field === 'object') {
          for (const [k, v] of Object.entries(field)) filters.push((row) => row[k] === v)
        } else {
          const key = String(field).split('.').pop()!
          filters.push((row) => row[key] === value)
        }
        return q
      },
      whereNull: (field: string) => {
        const key = field.split('.').pop()!
        filters.push((row) => row[key] == null)
        return q
      },
      whereRaw: () => q,
      join: () => q,
      orderBy: () => q,
      first: async () => (tables[table] ?? []).find((row) => filters.every((f) => f(row))),
      select: async () => (tables[table] ?? []).filter((row) => filters.every((f) => f(row))),
      insert: async (row: Row) => { inserts.push({ table, row }) },
      update: async () => 1,
    }
    return q
  }) as unknown as Knex
  return { knex, inserts }
}

const ORG = 'org-1'
const ORIGINAL_EMAIL_FROM = process.env.EMAIL_FROM

afterEach(() => {
  if (ORIGINAL_EMAIL_FROM === undefined) delete process.env.EMAIL_FROM
  else process.env.EMAIL_FROM = ORIGINAL_EMAIL_FROM
})

describe('routing never pairs a customer ESP with Noli EMAIL_FROM', () => {
  it('an ESP with no from address of its own is not a sending setup, even with EMAIL_FROM set', async () => {
    process.env.EMAIL_FROM = 'Noli <hello@noliai.com>'
    const { knex } = fakeKnex({
      esp_connections: [{ id: 'esp-1', organization_id: ORG, is_active: true, provider: 'resend' }],
    })
    expect(await hasSendingSetup(knex, ORG, 'marketing')).toBe(false)
    expect(await resolveSenderAddress(knex, ORG, 'marketing')).toBeNull()
  })

  it("uses the ESP's own default sender or verified domain", async () => {
    process.env.EMAIL_FROM = 'Noli <hello@noliai.com>'
    const withSender = fakeKnex({
      esp_connections: [{ id: 'esp-1', organization_id: ORG, is_active: true, provider: 'resend', default_sender_email: 'owner@customer.test' }],
    })
    expect(await resolveSenderAddress(withSender.knex, ORG, 'marketing')).toBe('owner@customer.test')
    const withDomain = fakeKnex({
      esp_connections: [{ id: 'esp-1', organization_id: ORG, is_active: true, provider: 'resend', sending_domain: 'customer.test' }],
    })
    expect(await resolveSenderAddress(withDomain.knex, ORG, 'marketing')).toBe('noreply@customer.test')
  })

  it("an ESP without a from address falls through to the customer's connected mailbox", async () => {
    const { knex } = fakeKnex({
      esp_connections: [{ id: 'esp-1', organization_id: ORG, is_active: true, provider: 'resend' }],
      email_connections: [{ id: 'c-1', organization_id: ORG, is_active: true, provider: 'gmail', email_address: 'me@customer.test' }],
    })
    expect(await resolveSenderAddress(knex, ORG, 'marketing')).toBe('me@customer.test')
  })

  it('espOwnFromAddress never invents a Noli address', () => {
    process.env.EMAIL_FROM = 'Noli <hello@noliai.com>'
    expect(espOwnFromAddress(null)).toBeNull()
    expect(espOwnFromAddress({ provider: 'resend' })).toBeNull()
    expect(espOwnFromAddress({ default_sender_email: 'a@customer.test' })).toBe('a@customer.test')
    expect(espOwnFromAddress({ sending_domain: 'customer.test' })).toBe('noreply@customer.test')
  })
})

describe('sendEmailByPurpose with no sending setup', () => {
  it('refuses with code email_not_connected and notes it on the contact timeline', async () => {
    const { knex, inserts } = fakeKnex({})
    const result = await sendEmailByPurpose(knex, ORG, 'tenant-1', 'automations', {
      to: 'lead@example.test',
      subject: 'Welcome',
      htmlBody: '<p>Hi</p>',
      contactId: 'contact-1',
    })
    expect(result).toEqual({ ok: false, code: 'email_not_connected', error: EMAIL_NOT_SENT_NOT_CONNECTED })
    expect(inserts).toHaveLength(1)
    expect(inserts[0].table).toBe('contact_timeline_events')
    expect(inserts[0].row).toMatchObject({
      organization_id: ORG,
      contact_id: 'contact-1',
      event_type: 'email_not_sent',
      title: 'Email not sent: Welcome',
      description: EMAIL_NOT_SENT_NOT_CONNECTED,
    })
  })

  it('writes nothing when there is no contact to note it on', async () => {
    const { knex, inserts } = fakeKnex({})
    const result = await sendEmailByPurpose(knex, ORG, 'tenant-1', 'transactional', {
      to: 'owner@example.test', subject: 'x', htmlBody: 'y',
    })
    expect(result.code).toBe('email_not_connected')
    expect(inserts).toHaveLength(0)
  })
})

describe('automationSendsEmail', () => {
  it('detects legacy single actions and multi-step actions', () => {
    expect(automationSendsEmail({ action_type: 'send_email' })).toBe(true)
    expect(automationSendsEmail({ action_type: 'send_survey' })).toBe(true)
    expect(automationSendsEmail({ action_type: 'add_tag' })).toBe(false)
    expect(automationSendsEmail({
      action_type: 'send_email',
      steps: JSON.stringify([{ type: 'delay' }, { type: 'action', actionType: 'create_task' }]),
    })).toBe(false)
    expect(automationSendsEmail({
      action_type: 'add_tag',
      steps: [{ type: 'action', actionType: 'add_tag' }, { type: 'action', actionType: 'send_email' }],
    })).toBe(true)
  })
})

describe('getEmailSendingGap', () => {
  it('flags an enabled email automation when nothing is connected', async () => {
    const { knex } = fakeKnex({
      automation_rules: [{ organization_id: ORG, is_active: true, action_type: 'send_email', steps: null }],
    })
    expect((await getEmailSendingGap(knex, ORG)).blocked).toContain('automations')
  })

  it('flags nothing once a mailbox is connected', async () => {
    const { knex } = fakeKnex({
      automation_rules: [{ organization_id: ORG, is_active: true, action_type: 'send_email', steps: null }],
      booking_pages: [{ id: 'b-1', organization_id: ORG, is_active: true }],
      email_connections: [{ id: 'c-1', organization_id: ORG, is_active: true, provider: 'gmail', email_address: 'me@customer.test' }],
    })
    expect((await getEmailSendingGap(knex, ORG)).blocked).toEqual([])
  })

  it('flags nothing when no email feature is enabled', async () => {
    const { knex } = fakeKnex({
      automation_rules: [{ organization_id: ORG, is_active: true, action_type: 'add_tag', steps: null }],
    })
    expect((await getEmailSendingGap(knex, ORG)).blocked).toEqual([])
  })
})
