jest.mock('@open-mercato/shared/lib/encryption/decryptRows', () => ({
  ...jest.requireActual('@open-mercato/shared/lib/encryption/decryptRows'),
  decryptRowFields: jest.fn(async (_em: unknown, _key: string, rows: unknown[]) => rows),
}))
jest.mock('../../../email/lib/email-router', () => ({
  sendEmailByPurpose: jest.fn(async () => ({ ok: false, error: 'email is not sent in tests' })),
}))

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFakeDb } from '../../../../lib/__tests__/support/fake-db'
import { dispatchEventRegistered, dispatchProductPurchased } from '../automation-dispatch'
import { matchesSequenceTrigger } from '../automation-trigger-match'

/**
 * The Sequences editor offered "Event registration" and "Product purchased"
 * triggers, but nothing ever dispatched them, so those sequences enrolled no
 * one. Each registration and each purchase now runs its sequences once,
 * through the same exactly-once ledger (automation_trigger_dispatches) as the
 * other triggers, and never enrolls a contact who unsubscribed.
 */

const ORG = 'org-1'
const TENANT = 'ten-1'
const OTHER_ORG = 'org-2'
const OTHER_TENANT = 'ten-2'
const DANA = 'contact-dana'
const SAM = 'contact-sam'
const scope = { organizationId: ORG, tenantId: TENANT }

type Seq = { id: string; trigger_type: string; trigger_config?: Record<string, unknown>; organization_id?: string; tenant_id?: string; status?: string }

function world(sequences: Seq[], extra: Record<string, Array<Record<string, unknown>>> = {}) {
  return createFakeDb(
    {
      automation_rules: [],
      automation_rule_logs: [],
      automation_trigger_dispatches: [],
      sequences: sequences.map((s) => ({
        name: s.id,
        organization_id: ORG,
        tenant_id: TENANT,
        status: 'active',
        deleted_at: null,
        ...s,
        trigger_config: JSON.stringify(s.trigger_config ?? {}),
      })),
      sequence_steps: sequences.map((s) => ({ id: `${s.id}-step-1`, sequence_id: s.id, step_order: 1, step_type: 'email', config: JSON.stringify({ subject: 'Hi' }) })),
      sequence_enrollments: [],
      sequence_step_executions: [],
      customer_entities: [
        { id: DANA, kind: 'person', organization_id: ORG, tenant_id: TENANT, primary_email: 'dana@example.test', deleted_at: null },
        { id: SAM, kind: 'person', organization_id: ORG, tenant_id: TENANT, primary_email: 'Sam@Example.test', deleted_at: null },
      ],
      email_unsubscribes: [],
      ...extra,
    },
    { automation_trigger_dispatches: [['organization_id', 'trigger_type', 'event_key']] },
  )
}

type Knex = ReturnType<typeof world>
const enrollments = (knex: Knex) => knex.db.tables.sequence_enrollments as Array<Record<string, unknown>>
const registration = (overrides: Partial<Parameters<typeof dispatchEventRegistered>[1]> = {}) => ({
  ...scope,
  attendeeId: 'att-1',
  eventId: 'event-open-house',
  contactId: DANA,
  email: 'dana@example.test',
  eventTitle: 'Saturday open house',
  ...overrides,
})
const purchase = (overrides: Partial<Parameters<typeof dispatchProductPurchased>[1]> = {}) => ({
  ...scope,
  purchaseKey: 'checkout:cs_test_1',
  productId: 'product-guide',
  contactId: DANA,
  email: 'dana@example.test',
  productName: 'Home seller guide',
  amount: 49,
  ...overrides,
})

describe('Event registration sequences', () => {
  it('enroll once per registration, and only sequences for that event (or any event)', async () => {
    const knex = world([
      { id: 'seq-this-event', trigger_type: 'event_registered', trigger_config: { eventId: 'event-open-house' } },
      { id: 'seq-any-event', trigger_type: 'event_registered' },
      { id: 'seq-other-event', trigger_type: 'event_registered', trigger_config: { eventId: 'event-webinar' } },
      { id: 'seq-other-trigger', trigger_type: 'course_enrolled' },
    ])
    await expect(dispatchEventRegistered(knex as never, registration())).resolves.toEqual({ dispatched: true })
    // The same registration again (a replayed request, a second webhook delivery): nothing new.
    await expect(dispatchEventRegistered(knex as never, registration())).resolves.toEqual({ dispatched: false })

    expect(enrollments(knex).map((e) => e.sequence_id).sort()).toEqual(['seq-any-event', 'seq-this-event'])
    expect(enrollments(knex).every((e) => e.contact_id === DANA && e.organization_id === ORG && e.tenant_id === TENANT)).toBe(true)
    expect(knex.db.tables.sequence_step_executions).toHaveLength(2)
    expect(knex.db.tables.automation_trigger_dispatches.map((row: { event_key: string }) => row.event_key)).toEqual(['event_attendee:att-1'])
  })

  it('a second person registering is enrolled too', async () => {
    const knex = world([{ id: 'seq-1', trigger_type: 'event_registered' }])
    await dispatchEventRegistered(knex as never, registration())
    await dispatchEventRegistered(knex as never, registration({ attendeeId: 'att-2', contactId: SAM, email: 'sam@example.test' }))
    expect(enrollments(knex).map((e) => e.contact_id)).toEqual([DANA, SAM])
  })

  it('never enrolls a contact who unsubscribed, by contact or by address; another org’s opt-out does not count', async () => {
    const knex = world([{ id: 'seq-1', trigger_type: 'event_registered' }], {
      email_unsubscribes: [
        { id: 'u-1', organization_id: ORG, tenant_id: TENANT, email: 'someone-else@example.test', contact_id: DANA },
        { id: 'u-2', organization_id: ORG, tenant_id: TENANT, email: 'sam@example.test', contact_id: null },
        { id: 'u-3', organization_id: OTHER_ORG, tenant_id: OTHER_TENANT, email: 'lee@example.test', contact_id: 'contact-lee' },
      ],
      customer_entities: [
        { id: DANA, organization_id: ORG, tenant_id: TENANT, primary_email: 'dana@example.test' },
        { id: SAM, organization_id: ORG, tenant_id: TENANT, primary_email: 'Sam@Example.test' },
        { id: 'contact-lee', organization_id: ORG, tenant_id: TENANT, primary_email: 'lee@example.test' },
      ],
    })
    await expect(dispatchEventRegistered(knex as never, registration())).resolves.toEqual({ dispatched: true, sequencesSkipped: 'unsubscribed' })
    await expect(dispatchEventRegistered(knex as never, registration({ attendeeId: 'att-2', contactId: SAM, email: 'Sam@Example.test' })))
      .resolves.toEqual({ dispatched: true, sequencesSkipped: 'unsubscribed' })
    await expect(dispatchEventRegistered(knex as never, registration({ attendeeId: 'att-3', contactId: 'contact-lee', email: 'lee@example.test' })))
      .resolves.toEqual({ dispatched: true })
    expect(enrollments(knex).map((e) => e.contact_id)).toEqual(['contact-lee'])
  })

  it('an address the registration carried counts even when the contact’s own address differs', async () => {
    const knex = world([{ id: 'seq-1', trigger_type: 'event_registered' }], {
      email_unsubscribes: [{ id: 'u-1', organization_id: ORG, tenant_id: TENANT, email: 'dana.work@example.test', contact_id: null }],
    })
    await dispatchEventRegistered(knex as never, registration({ email: 'Dana.Work@example.test' }))
    expect(enrollments(knex)).toHaveLength(0)
  })

  it('another organization’s sequences never run, and no listener means no ledger row', async () => {
    const knex = world([{ id: 'seq-other-org', trigger_type: 'event_registered', organization_id: OTHER_ORG, tenant_id: OTHER_TENANT }])
    await expect(dispatchEventRegistered(knex as never, registration())).resolves.toEqual({ dispatched: false })
    expect(enrollments(knex)).toHaveLength(0)
    expect(knex.db.tables.automation_trigger_dispatches).toHaveLength(0)
  })

  it('a paused or deleted sequence enrolls no one', async () => {
    const knex = world([
      { id: 'seq-paused', trigger_type: 'event_registered', status: 'paused' },
    ])
    await dispatchEventRegistered(knex as never, registration())
    expect(enrollments(knex)).toHaveLength(0)
  })
})

describe('Product purchased sequences', () => {
  it('enroll once per purchase, and only sequences for that product (or any product)', async () => {
    const knex = world([
      { id: 'seq-guide', trigger_type: 'product_purchased', trigger_config: { productId: 'product-guide' } },
      { id: 'seq-any', trigger_type: 'product_purchased' },
      { id: 'seq-coaching', trigger_type: 'product_purchased', trigger_config: { productId: 'product-coaching' } },
    ])
    await expect(dispatchProductPurchased(knex as never, purchase())).resolves.toEqual({ dispatched: true })
    await expect(dispatchProductPurchased(knex as never, purchase())).resolves.toEqual({ dispatched: false })
    expect(enrollments(knex).map((e) => e.sequence_id).sort()).toEqual(['seq-any', 'seq-guide'])
    expect(knex.db.tables.automation_trigger_dispatches.map((row: { event_key: string }) => row.event_key))
      .toEqual(['purchase:checkout:cs_test_1:product:product-guide'])
  })

  it('a funnel order reported by both the webhook and the upsell route counts once', async () => {
    const knex = world([{ id: 'seq-any', trigger_type: 'product_purchased' }])
    const order = purchase({ purchaseKey: 'funnel_order:order-7', productId: 'product-coaching' })
    await dispatchProductPurchased(knex as never, order)
    await dispatchProductPurchased(knex as never, order)
    expect(knex.db.tables.automation_trigger_dispatches).toHaveLength(1)
    expect(enrollments(knex)).toHaveLength(1)
  })

  it('a second buyer is enrolled; an unsubscribed buyer is not', async () => {
    const knex = world([{ id: 'seq-any', trigger_type: 'product_purchased' }], {
      email_unsubscribes: [{ id: 'u-1', organization_id: ORG, tenant_id: TENANT, email: 'sam@example.test', contact_id: null }],
    })
    await dispatchProductPurchased(knex as never, purchase())
    await expect(dispatchProductPurchased(knex as never, purchase({ purchaseKey: 'checkout:cs_test_2', contactId: SAM, email: 'sam@example.test' })))
      .resolves.toEqual({ dispatched: true, sequencesSkipped: 'unsubscribed' })
    expect(enrollments(knex).map((e) => e.contact_id)).toEqual([DANA])
  })
})

describe('trigger filters', () => {
  it('match the event and product the Sequences editor saved', () => {
    expect(matchesSequenceTrigger('event_registered', { eventId: 'e-1' }, { eventId: 'e-1' })).toBe(true)
    expect(matchesSequenceTrigger('event_registered', { eventId: 'e-1' }, { eventId: 'e-2' })).toBe(false)
    expect(matchesSequenceTrigger('event_registered', {}, { eventId: 'e-2' })).toBe(true)
    expect(matchesSequenceTrigger('product_purchased', { productId: 'p-1' }, { productId: 'p-1' })).toBe(true)
    expect(matchesSequenceTrigger('product_purchased', { productId: 'p-1' }, { productId: 'p-2' })).toBe(false)
    expect(matchesSequenceTrigger('product_purchased', { productId: '' }, { productId: 'p-2' })).toBe(true)
  })
})

describe('every registration and purchase path dispatches', () => {
  const SRC = join(__dirname, '../../../../')
  const read = (path: string) => readFileSync(join(SRC, path), 'utf8')

  it.each([
    ['modules/customers/api/crm-events/public/[slug]/register/route.ts', 'dispatchEventRegistered('],
    ['modules/customers/api/crm-events/kiosk/[token]/route.ts', 'dispatchEventRegistered('],
    ['modules/payments/api/stripe/webhook/route.ts', 'dispatchEventRegistered('],
    ['modules/payments/api/stripe/webhook/route.ts', 'purchaseKey: `checkout:${session.id}`'],
    ['modules/payments/api/stripe/webhook/route.ts', 'purchaseKey: `funnel_order:${order.id}`'],
    ['modules/landing_pages/api/funnels/public/[slug]/upsell/route.ts', 'purchaseKey: `funnel_order:${orderId}`'],
  ])('%s calls %s', (path, call) => {
    expect(read(path)).toContain(call)
  })
})
