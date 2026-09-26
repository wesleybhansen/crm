/** @jest-environment node */
const mockSendEmailByPurpose = jest.fn()
const mockCreateRequestContainer = jest.fn()
const mockGetAuth = jest.fn()

jest.mock('@open-mercato/shared/lib/encryption/decryptRows', () => ({
  ...jest.requireActual('@open-mercato/shared/lib/encryption/decryptRows'),
  decryptRowFields: jest.fn(async (_em: unknown, _key: string, rows: unknown[]) => rows),
}))
jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn(async () => {
    throw new Error('no ORM in this test: use the raw fallback')
  }),
}))
jest.mock('../../../email/lib/email-router', () => ({
  sendEmailByPurpose: (...args: unknown[]) => mockSendEmailByPurpose(...args),
}))
jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: (...args: unknown[]) => mockCreateRequestContainer(...args),
}))
jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromCookies: (...args: unknown[]) => mockGetAuth(...args),
}))

import { createFakeDb } from '../../../../lib/__tests__/support/fake-db'
import { checkSequenceTriggers } from '../../services/sequence-triggers'
import { dispatchContactCreated } from '../automation-dispatch'
import { runAutomationRuleNow } from '../automation-execute'
import { runSequenceEmailStep, type SequenceEmailStepDeps } from '../email-step'
import { summarizeEnrollResults } from '../enrollment'
import {
  isRecipientUnsubscribed,
  UNSUBSCRIBED_CODE,
  UNSUBSCRIBED_ENROLL_REASON,
  UNSUBSCRIBED_SEND_REASON,
  UNSUBSCRIBED_STOP_REASON,
} from '../../../email/lib/unsubscribes'
import { POST as enrollPOST } from '../../api/[id]/enroll/route'

/**
 * The unsubscribe gates (2026-09-26). Before this, only the "Event
 * registration" and "Product purchased" triggers checked email_unsubscribes;
 * every other trigger, manual enrollment and the sequence email step could
 * still email a person who unsubscribed from the business. Now:
 * - no enrollment, by any path, for an unsubscribed contact (with the reason);
 * - no send at the email step (the step says why, the sequence stops);
 * - another business's unsubscribes never count here.
 */

const ORG = 'org-1'
const TENANT = 'ten-1'
const OTHER_ORG = 'org-2'
const OTHER_TENANT = 'ten-2'
const DANA = 'contact-dana' // unsubscribed by contact id
const SAM = 'contact-sam' // unsubscribed by address, stored in another case
const LEE = 'contact-lee' // only unsubscribed from ANOTHER business
const scope = { organizationId: ORG, tenantId: TENANT }

function world(extra: Record<string, Array<Record<string, unknown>>> = {}) {
  return createFakeDb(
    {
      automation_rules: [],
      automation_rule_logs: [],
      automation_trigger_dispatches: [],
      contact_timeline_events: [],
      sequences: [
        { id: 'seq-tag', name: 'Tag nurture', organization_id: ORG, tenant_id: TENANT, status: 'active', deleted_at: null, trigger_type: 'tag_added', trigger_config: JSON.stringify({}) },
        { id: 'seq-welcome', name: 'Welcome', organization_id: ORG, tenant_id: TENANT, status: 'active', deleted_at: null, trigger_type: 'contact_created', trigger_config: JSON.stringify({}) },
        { id: 'seq-manual', name: 'Manual nurture', organization_id: ORG, tenant_id: TENANT, status: 'active', deleted_at: null, trigger_type: 'manual', trigger_config: JSON.stringify({}) },
      ],
      sequence_steps: ['seq-tag', 'seq-welcome', 'seq-manual'].map((id) => ({
        id: `${id}-step-1`, sequence_id: id, step_order: 1, step_type: 'email', config: JSON.stringify({ subject: 'Hi' }),
      })),
      sequence_enrollments: [],
      sequence_step_executions: [],
      email_messages: [],
      customer_entities: [
        { id: DANA, kind: 'person', organization_id: ORG, tenant_id: TENANT, primary_email: 'dana@example.test', display_name: 'Dana', deleted_at: null },
        { id: SAM, kind: 'person', organization_id: ORG, tenant_id: TENANT, primary_email: 'sam@example.test', display_name: 'Sam', deleted_at: null },
        { id: LEE, kind: 'person', organization_id: ORG, tenant_id: TENANT, primary_email: 'lee@example.test', display_name: 'Lee', deleted_at: null },
      ],
      email_unsubscribes: [
        { id: 'u-dana', organization_id: ORG, tenant_id: TENANT, email: 'old-address@example.test', contact_id: DANA },
        { id: 'u-sam', organization_id: ORG, tenant_id: TENANT, email: 'Sam@Example.TEST', contact_id: null },
        // Another business: its unsubscribes must not leak into this one.
        { id: 'u-lee-elsewhere', organization_id: OTHER_ORG, tenant_id: OTHER_TENANT, email: 'lee@example.test', contact_id: LEE },
      ],
      ...extra,
    },
    { automation_trigger_dispatches: [['organization_id', 'trigger_type', 'event_key']] },
  )
}

type Knex = ReturnType<typeof world>
const rows = (knex: Knex, table: string) => knex.db.tables[table] as Array<Record<string, any>>

beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(console, 'log').mockImplementation(() => {})
  mockSendEmailByPurpose.mockResolvedValue({ ok: true, sentVia: 'esp:resend', messageId: 'm-1', fromAddress: 'owner@customer.test' })
})
afterEach(() => jest.restoreAllMocks())

describe('the unsubscribe store: one matching rule', () => {
  it('matches by contact id, or by address in any case; another business’s unsubscribes never count', async () => {
    const knex = world()
    await expect(isRecipientUnsubscribed(knex as never, scope, { contactId: DANA, emails: ['dana@example.test'] })).resolves.toBe(true)
    await expect(isRecipientUnsubscribed(knex as never, scope, { contactId: SAM, emails: ['SAM@example.test'] })).resolves.toBe(true)
    await expect(isRecipientUnsubscribed(knex as never, scope, { emails: [' sam@EXAMPLE.test '] })).resolves.toBe(true)
    await expect(isRecipientUnsubscribed(knex as never, scope, { contactId: LEE, emails: ['lee@example.test'] })).resolves.toBe(false)
    // The other business sees its own unsubscribe.
    await expect(isRecipientUnsubscribed(knex as never, { organizationId: OTHER_ORG, tenantId: OTHER_TENANT }, { emails: ['lee@example.test'] })).resolves.toBe(true)
  })
})

describe('enrollment gate', () => {
  it('a trigger never enrolls an unsubscribed contact, and the timeline says why', async () => {
    const knex = world()
    const dana = await checkSequenceTriggers(knex, ORG, TENANT, 'tag_added', { contactId: DANA })
    const sam = await checkSequenceTriggers(knex, ORG, TENANT, 'tag_added', { contactId: SAM })
    expect(dana).toEqual({ enrolled: [], skipped: [{ sequenceId: 'seq-tag', code: UNSUBSCRIBED_CODE, reason: UNSUBSCRIBED_ENROLL_REASON }] })
    expect(sam.enrolled).toEqual([])
    expect(rows(knex, 'sequence_enrollments')).toHaveLength(0)
    expect(rows(knex, 'sequence_step_executions')).toHaveLength(0)
    const timeline = rows(knex, 'contact_timeline_events')
    expect(timeline.map((e) => [e.contact_id, e.event_type, e.description])).toEqual([
      [DANA, 'sequence_not_enrolled', UNSUBSCRIBED_ENROLL_REASON],
      [SAM, 'sequence_not_enrolled', UNSUBSCRIBED_ENROLL_REASON],
    ])
    expect(timeline.every((e) => e.organization_id === ORG && e.tenant_id === TENANT)).toBe(true)
  })

  it('an address the event carried counts too (a form submitted with an unsubscribed address)', async () => {
    const knex = world()
    const out = await checkSequenceTriggers(knex, ORG, TENANT, 'tag_added', { contactId: LEE, emails: ['SAM@example.test'] })
    expect(out.enrolled).toEqual([])
  })

  it('a contact unsubscribed only from another business is enrolled as usual', async () => {
    const knex = world()
    const out = await checkSequenceTriggers(knex, ORG, TENANT, 'tag_added', { contactId: LEE })
    expect(out).toEqual({ enrolled: ['seq-tag'], skipped: [] })
    expect(rows(knex, 'sequence_enrollments').map((e) => [e.contact_id, e.organization_id, e.tenant_id])).toEqual([[LEE, ORG, TENANT]])
  })

  it('dispatched triggers (contact created) are gated the same way', async () => {
    const knex = world()
    await dispatchContactCreated(knex as never, { organizationId: ORG, tenantId: TENANT, contactId: DANA })
    await dispatchContactCreated(knex as never, { organizationId: ORG, tenantId: TENANT, contactId: LEE })
    expect(rows(knex, 'sequence_enrollments').map((e) => [e.sequence_id, e.contact_id])).toEqual([['seq-welcome', LEE]])
  })

  it('the automation "Enroll in sequence" action skips an unsubscribed contact with the reason', async () => {
    const knex = world()
    const rule = { id: 'rule-1', action_type: 'enroll_in_sequence', action_config: JSON.stringify({ sequenceId: 'seq-manual' }) }
    const runs = await runAutomationRuleNow(knex, scope, rule, { contactId: SAM })
    expect(runs).toEqual([expect.objectContaining({ status: 'skipped', detail: UNSUBSCRIBED_ENROLL_REASON })])
    expect(rows(knex, 'sequence_enrollments')).toHaveLength(0)
    expect(rows(knex, 'automation_rule_logs').map((l) => l.status)).toEqual(['skipped'])

    const ok = await runAutomationRuleNow(knex, scope, rule, { contactId: LEE })
    expect(ok[0]).toMatchObject({ status: 'executed' })
    expect(rows(knex, 'sequence_enrollments').map((e) => e.contact_id)).toEqual([LEE])
  })

  describe('manual enrollment (the Sequences page and the assistant)', () => {
    function enroll(knex: Knex, contactId: string) {
      mockCreateRequestContainer.mockResolvedValue({ resolve: () => ({ getKnex: () => knex }) })
      return enrollPOST(
        new Request('https://crm.example.test/api/sequences/seq-manual/enroll', { method: 'POST', body: JSON.stringify({ contactId }) }),
        { params: { id: 'seq-manual' } },
      )
    }

    it('refuses an unsubscribed contact with code "unsubscribed" and a plain reason; enrolls anyone else', async () => {
      const knex = world()
      mockGetAuth.mockResolvedValue({ orgId: ORG, tenantId: TENANT, sub: 'user-1' })
      const refused = await enroll(knex, DANA)
      expect(refused.status).toBe(409)
      await expect(refused.json()).resolves.toEqual({ ok: false, code: UNSUBSCRIBED_CODE, error: UNSUBSCRIBED_ENROLL_REASON })
      expect(rows(knex, 'sequence_enrollments')).toHaveLength(0)

      const enrolled = await enroll(knex, LEE)
      expect(enrolled.status).toBe(201)
      expect(rows(knex, 'sequence_enrollments').map((e) => e.contact_id)).toEqual([LEE])
    })

    it('the page tells the user how many people were skipped because they unsubscribed', () => {
      expect(summarizeEnrollResults([
        { ok: true },
        { ok: false, code: UNSUBSCRIBED_CODE, error: UNSUBSCRIBED_ENROLL_REASON },
        { ok: false, code: UNSUBSCRIBED_CODE, error: UNSUBSCRIBED_ENROLL_REASON },
      ])).toEqual({ tone: 'success', text: 'Enrolled 1 contact. 2 people were skipped because they unsubscribed.' })
      expect(summarizeEnrollResults([{ ok: false, code: UNSUBSCRIBED_CODE, error: UNSUBSCRIBED_ENROLL_REASON }]))
        .toEqual({ tone: 'error', text: 'No one was enrolled. 1 person was skipped because they unsubscribed.' })
      expect(summarizeEnrollResults([
        { ok: true },
        { ok: false, code: UNSUBSCRIBED_CODE, error: UNSUBSCRIBED_ENROLL_REASON },
        { ok: false, error: 'Contact is already enrolled in this sequence' },
      ])?.text).toBe('Enrolled 1 of 3 contacts. 1 person was skipped because they unsubscribed. 1 contact was not enrolled. Contact is already enrolled in this sequence')
    })
  })
})

describe('send gate: the sequence email step', () => {
  const NOW = new Date('2026-09-26T12:00:00.000Z')

  function stepWorld(contactId: string, to: string) {
    const knex = world({
      sequence_enrollments: [{ id: 'enr-1', sequence_id: 'seq-manual', contact_id: contactId, organization_id: ORG, tenant_id: TENANT, status: 'active', current_step_order: 1 }],
      sequence_step_executions: [{ id: 'exec-1', enrollment_id: 'enr-1', step_id: 'seq-manual-step-1', status: 'processing' }],
    })
    const input = { executionId: 'exec-1', enrollmentId: 'enr-1', organizationId: ORG, tenantId: TENANT, contactId, to, subject: 'Hello', bodyHtml: '<p>Hi</p>' }
    const send = jest.fn(async () => ({ ok: true, fromAddress: 'owner@customer.test' }))
    const deps: SequenceEmailStepDeps = { isUnsubscribed: isRecipientUnsubscribed, hasSendingSetup: jest.fn(async () => true), send, now: () => NOW }
    return { knex, input, send, deps }
  }

  it('an unsubscribed contact: nothing sent or written, the step says why, the sequence stops', async () => {
    for (const [contactId, to] of [[DANA, 'dana@example.test'], [SAM, 'sam@example.test']] as const) {
      const { knex, input, send, deps } = stepWorld(contactId, to)
      await expect(runSequenceEmailStep(knex as never, input, deps)).resolves.toBe('unsubscribed')
      expect(send).not.toHaveBeenCalled()
      expect(rows(knex, 'email_messages')).toHaveLength(0)
      const step = rows(knex, 'sequence_step_executions')[0]!
      expect(step.status).toBe('skipped')
      expect(JSON.parse(step.result)).toEqual({ skipped: true, unsubscribed: true, reason: UNSUBSCRIBED_STOP_REASON })
      expect(rows(knex, 'sequence_enrollments')[0]).toMatchObject({ status: 'unsubscribed', paused_at: NOW })
    }
  })

  it('someone unsubscribed only from another business still gets the email', async () => {
    const { knex, input, send, deps } = stepWorld(LEE, 'lee@example.test')
    await expect(runSequenceEmailStep(knex as never, input, deps)).resolves.toBe('sent')
    expect(send).toHaveBeenCalledTimes(1)
    expect(rows(knex, 'sequence_enrollments')[0]!.status).toBe('active')
  })

  it('an unsubscribe that lands after the check is still refused by the router, and stops the sequence', async () => {
    const { knex, input, deps } = stepWorld(LEE, 'lee@example.test')
    const send = jest.fn(async () => ({ ok: false, code: UNSUBSCRIBED_CODE, error: UNSUBSCRIBED_SEND_REASON }))
    await expect(runSequenceEmailStep(knex as never, input, { ...deps, send })).resolves.toBe('unsubscribed')
    expect(rows(knex, 'email_messages').map((m) => m.status)).toEqual(['failed'])
    expect(rows(knex, 'sequence_enrollments')[0]!.status).toBe('unsubscribed')
  })

  it('if the unsubscribe list cannot be read, nothing is sent and the step waits to retry', async () => {
    const { knex, input, send, deps } = stepWorld(LEE, 'lee@example.test')
    jest.spyOn(console, 'error').mockImplementation(() => {})
    const isUnsubscribed = jest.fn(async () => { throw new Error('connection reset') })
    await expect(runSequenceEmailStep(knex as never, input, { ...deps, isUnsubscribed })).resolves.toBe('waiting')
    expect(send).not.toHaveBeenCalled()
    const step = rows(knex, 'sequence_step_executions')[0]!
    expect(step.status).toBe('scheduled')
    expect(JSON.parse(step.result).waiting).toBe('unsubscribe_check_failed')
    expect(rows(knex, 'sequence_enrollments')[0]!.status).toBe('active')
  })
})

describe('send gate: automation email actions', () => {
  it('a "Send email" action the router refuses as unsubscribed is logged as skipped with the reason', async () => {
    const knex = world()
    mockSendEmailByPurpose.mockResolvedValue({ ok: false, code: UNSUBSCRIBED_CODE, error: UNSUBSCRIBED_SEND_REASON })
    const rule = { id: 'rule-2', action_type: 'send_email', action_config: JSON.stringify({ subject: 'Hi', body: 'Hello' }) }
    const runs = await runAutomationRuleNow(knex, scope, rule, { contactId: DANA })
    expect(mockSendEmailByPurpose).toHaveBeenCalledWith(knex, ORG, TENANT, 'automations', expect.objectContaining({ contactId: DANA }))
    expect(runs).toEqual([expect.objectContaining({ status: 'skipped', detail: UNSUBSCRIBED_SEND_REASON })])
    expect(rows(knex, 'automation_rule_logs').map((l) => l.status)).toEqual(['skipped'])
  })
})
