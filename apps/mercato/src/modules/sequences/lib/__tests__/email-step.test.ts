/** @jest-environment node */
import type { Knex } from 'knex'
import {
  runSequenceEmailStep,
  SEQUENCE_EMAIL_WAIT_RETRY_MS,
  SEQUENCE_WAITING_MESSAGE,
  type SequenceEmailStepDeps,
} from '../email-step'

type Op =
  | { table: string; kind: 'insert'; row: Record<string, unknown> }
  | { table: string; kind: 'update'; where: Record<string, unknown>; patch: Record<string, unknown> }

function recordingKnex() {
  const ops: Op[] = []
  const knex = ((table: string) => {
    const where: Record<string, unknown> = {}
    const q: any = {
      where: (field: string, value: unknown) => { where[field] = value; return q },
      insert: async (row: Record<string, unknown>) => { ops.push({ table, kind: 'insert', row }) },
      update: async (patch: Record<string, unknown>) => {
        ops.push({ table, kind: 'update', where: { ...where }, patch })
        return 1
      },
    }
    return q
  }) as unknown as Knex
  return { knex, ops }
}

const NOW = new Date('2026-09-24T12:00:00.000Z')
const INPUT = {
  executionId: 'exec-1',
  enrollmentId: 'enr-1',
  organizationId: 'org-1',
  tenantId: 'tenant-1',
  contactId: 'contact-1',
  to: 'lead@example.test',
  subject: 'Hello',
  bodyHtml: '<p>Hi</p>',
}

function deps(overrides: Partial<SequenceEmailStepDeps> = {}): SequenceEmailStepDeps & { send: jest.Mock } {
  return {
    isUnsubscribed: jest.fn(async () => false),
    hasSendingSetup: jest.fn(async () => true),
    send: jest.fn(async () => ({ ok: true, fromAddress: 'owner@customer.test', messageId: 'm-1' })),
    now: () => NOW,
    ...overrides,
  } as SequenceEmailStepDeps & { send: jest.Mock }
}

describe('runSequenceEmailStep', () => {
  it('with no sending setup: sends nothing, writes no message row, and leaves the step scheduled with a visible reason', async () => {
    const { knex, ops } = recordingKnex()
    const d = deps({ hasSendingSetup: jest.fn(async () => false) })

    const outcome = await runSequenceEmailStep(knex, INPUT, d)

    expect(outcome).toBe('waiting')
    expect(d.send).not.toHaveBeenCalled()
    expect(ops.filter((op) => op.table === 'email_messages')).toHaveLength(0)
    expect(ops).toHaveLength(1)
    const op = ops[0] as Extract<Op, { kind: 'update' }>
    expect(op.table).toBe('sequence_step_executions')
    expect(op.where).toEqual({ id: 'exec-1' })
    expect(op.patch.status).toBe('scheduled')
    expect(op.patch).not.toHaveProperty('executed_at')
    expect((op.patch.scheduled_for as Date).getTime()).toBe(NOW.getTime() + SEQUENCE_EMAIL_WAIT_RETRY_MS)
    expect(JSON.parse(op.patch.result as string)).toEqual({
      waiting: 'email_not_connected',
      reason: SEQUENCE_WAITING_MESSAGE,
    })
  })

  it('checks the marketing purpose, the one the send uses', async () => {
    const { knex } = recordingKnex()
    const hasSendingSetup = jest.fn(async () => false)
    await runSequenceEmailStep(knex, INPUT, deps({ hasSendingSetup }))
    expect(hasSendingSetup).toHaveBeenCalledWith(knex, 'org-1', 'marketing')
  })

  it('on a successful send: message row marked sent with the real from address, step executed', async () => {
    const { knex, ops } = recordingKnex()
    const d = deps()

    const outcome = await runSequenceEmailStep(knex, INPUT, d)

    expect(outcome).toBe('sent')
    expect(d.send).toHaveBeenCalledTimes(1)
    const insert = ops.find((op) => op.kind === 'insert') as Extract<Op, { kind: 'insert' }>
    expect(insert.table).toBe('email_messages')
    expect(insert.row.status).toBe('queued')
    const messageUpdate = ops.find((op) => op.kind === 'update' && op.table === 'email_messages') as Extract<Op, { kind: 'update' }>
    expect(messageUpdate.where).toEqual({ id: insert.row.id })
    expect(messageUpdate.patch).toMatchObject({ status: 'sent', from_address: 'owner@customer.test', sent_at: NOW })
    const stepUpdate = ops.find((op) => op.kind === 'update' && op.table === 'sequence_step_executions') as Extract<Op, { kind: 'update' }>
    expect(stepUpdate.patch.status).toBe('executed')
    expect(JSON.parse(stepUpdate.patch.result as string)).toMatchObject({ sent_to: INPUT.to, tracking_id: insert.row.tracking_id })
  })

  it('on a provider failure: message row and step are recorded failed with the error, never executed', async () => {
    const { knex, ops } = recordingKnex()
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const d = deps({ send: jest.fn(async () => ({ ok: false, error: 'Gmail token expired. Reconnect Gmail in Settings.' })) })

    const outcome = await runSequenceEmailStep(knex, INPUT, d)

    expect(outcome).toBe('failed')
    const messageUpdate = ops.find((op) => op.kind === 'update' && op.table === 'email_messages') as Extract<Op, { kind: 'update' }>
    expect(messageUpdate.patch).toEqual({ status: 'failed' })
    const stepUpdate = ops.find((op) => op.kind === 'update' && op.table === 'sequence_step_executions') as Extract<Op, { kind: 'update' }>
    expect(stepUpdate.patch.status).toBe('failed')
    expect(JSON.parse(stepUpdate.patch.result as string).error).toBe('Gmail token expired. Reconnect Gmail in Settings.')
    errorSpy.mockRestore()
  })

  it('a thrown send is recorded as failed too', async () => {
    const { knex, ops } = recordingKnex()
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const outcome = await runSequenceEmailStep(knex, INPUT, deps({ send: jest.fn(async () => { throw new Error('boom') }) }))
    expect(outcome).toBe('failed')
    const stepUpdate = ops.find((op) => op.kind === 'update' && op.table === 'sequence_step_executions') as Extract<Op, { kind: 'update' }>
    expect(stepUpdate.patch.status).toBe('failed')
    errorSpy.mockRestore()
  })
})
