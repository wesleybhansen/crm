/** @jest-environment node */
import { buildEnrollmentEmail, paidEnrollmentRow, sendEnrollmentEmailOnce, type EnrollmentEmailSend } from '../enrollment-email'

type Row = { id: string; tenant_id: string; organization_id: string; welcome_email_sent_at: Date | null }

/** In-memory knex for the two tables the helper touches. */
function fakeKnex(rows: Row[], opts: { columnMissing?: boolean } = {}) {
  const tokens: Array<Record<string, any>> = []
  const knex: any = (table: string) => {
    const filters: Array<[string, unknown]> = []
    const nulls: string[] = []
    const q: any = {
      where: (field: string, value: unknown) => { filters.push([field, value]); return q },
      whereNull: (field: string) => { nulls.push(field); return q },
      insert: async (row: Record<string, any>) => { if (table === 'course_magic_tokens') tokens.push(row) },
      update: async (patch: Record<string, any>) => {
        if (table !== 'course_enrollments') return 0
        if (opts.columnMissing && 'welcome_email_sent_at' in patch) {
          throw Object.assign(new Error('column "welcome_email_sent_at" does not exist'), { code: '42703' })
        }
        const hits = rows.filter((r) =>
          filters.every(([f, v]) => (r as any)[f] === v) && nulls.every((f) => (r as any)[f] === null))
        for (const r of hits) Object.assign(r, patch)
        return hits.length
      },
    }
    return q
  }
  return { knex, tokens }
}

const input = {
  enrollmentId: 'enr-1',
  tenantId: 't-1',
  organizationId: 'o-1',
  studentEmail: 'Student@Example.com',
  courseTitle: 'Listing Mastery',
  contactId: 'c-1',
}
const fixedNow = new Date('2026-10-01T12:00:00.000Z')

function freshRow(): Row {
  return { id: 'enr-1', tenant_id: 't-1', organization_id: 'o-1', welcome_email_sent_at: null }
}

describe('sendEnrollmentEmailOnce', () => {
  it('sends the enrolled email once and stamps welcome_email_sent_at', async () => {
    const row = freshRow()
    const { knex, tokens } = fakeKnex([row])
    const send = jest.fn<ReturnType<EnrollmentEmailSend>, Parameters<EnrollmentEmailSend>>(async () => ({ ok: true }))

    const first = await sendEnrollmentEmailOnce(knex, input, { send, now: () => fixedNow, origin: 'https://crm.test' })
    expect(first).toEqual({ sent: true })
    expect(row.welcome_email_sent_at).toEqual(fixedNow)
    expect(send).toHaveBeenCalledTimes(1)

    const [, orgId, tenantId, purpose, params] = send.mock.calls[0]
    expect([orgId, tenantId, purpose]).toEqual(['o-1', 't-1', 'transactional'])
    expect(params.to).toBe('Student@Example.com')
    expect(params.contactId).toBe('c-1')
    expect(params.subject).toBe('Welcome to Listing Mastery! Access your course')
    expect(params.htmlBody).toContain("You're enrolled!")
    expect(params.htmlBody).toContain(`https://crm.test/api/courses/student/verify?token=${tokens[0].token}`)

    // The access link is a fresh magic token for this organization.
    expect(tokens).toHaveLength(1)
    expect(tokens[0]).toMatchObject({ organization_id: 'o-1', email: 'student@example.com' })

    // A second call for the same enrollment (retry, replay) sends nothing.
    const second = await sendEnrollmentEmailOnce(knex, input, { send, now: () => fixedNow })
    expect(second).toEqual({ sent: false, reason: 'already_sent' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(tokens).toHaveLength(1)
  })

  it('only claims the enrollment in its own tenant and organization', async () => {
    const other = { ...freshRow(), organization_id: 'o-2' }
    const { knex } = fakeKnex([other])
    const send = jest.fn(async () => ({ ok: true }))
    const result = await sendEnrollmentEmailOnce(knex, input, { send, now: () => fixedNow })
    expect(result).toEqual({ sent: false, reason: 'already_sent' })
    expect(send).not.toHaveBeenCalled()
    expect(other.welcome_email_sent_at).toBeNull()
  })

  it('releases the claim when the send fails, so it is not marked sent', async () => {
    const row = freshRow()
    const { knex } = fakeKnex([row])
    const send = jest.fn(async () => ({ ok: false, error: 'email_not_connected' }))
    const result = await sendEnrollmentEmailOnce(knex, input, { send, now: () => fixedNow })
    expect(result).toEqual({ sent: false, reason: 'send_failed', error: 'email_not_connected' })
    expect(row.welcome_email_sent_at).toBeNull()
  })

  it('releases the claim when the transport throws', async () => {
    const row = freshRow()
    const { knex } = fakeKnex([row])
    const send = jest.fn(async () => { throw new Error('boom') })
    const result = await sendEnrollmentEmailOnce(knex, input, { send, now: () => fixedNow })
    expect(result).toMatchObject({ sent: false, reason: 'send_failed', error: 'boom' })
    expect(row.welcome_email_sent_at).toBeNull()
  })

  it('still sends before the migration adds the column', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const { knex } = fakeKnex([freshRow()], { columnMissing: true })
    const send = jest.fn(async () => ({ ok: true }))
    const result = await sendEnrollmentEmailOnce(knex, input, { send, now: () => fixedNow })
    expect(result).toEqual({ sent: true })
    expect(send).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('does nothing without an email address', async () => {
    const { knex } = fakeKnex([freshRow()])
    const send = jest.fn(async () => ({ ok: true }))
    expect(await sendEnrollmentEmailOnce(knex, { ...input, studentEmail: '  ' }, { send })).toEqual({ sent: false, reason: 'no_email' })
    expect(send).not.toHaveBeenCalled()
  })
})

describe('buildEnrollmentEmail', () => {
  it('escapes the owner-supplied course title in the HTML', () => {
    const { subject, html } = buildEnrollmentEmail({ courseTitle: '<b>Deals</b> & more', magicLink: 'https://x/v?token=abc', ttlLabel: '7 days' })
    expect(subject).toBe('Welcome to <b>Deals</b> & more! Access your course')
    expect(html).toContain('&lt;b&gt;Deals&lt;/b&gt; &amp; more')
    expect(html).not.toContain('<b>Deals</b>')
    expect(html).toContain('valid for 7 days')
  })
})

describe('paidEnrollmentRow', () => {
  it('links the enrollment to our payment record (a uuid), never the Stripe PaymentIntent id', () => {
    const row = paidEnrollmentRow({
      enrollmentId: 'enr-1',
      tenantId: 't-1',
      organizationId: 'o-1',
      courseId: 'course-1',
      studentName: ' Pat ',
      studentEmail: ' Pat@Example.com ',
      paymentRecordId: '5b0c1f7e-7a55-4f0e-9d7c-2d6a7c1e9a10',
      now: fixedNow,
    })
    expect(row).toEqual({
      id: 'enr-1',
      tenant_id: 't-1',
      organization_id: 'o-1',
      course_id: 'course-1',
      student_name: 'Pat',
      student_email: 'pat@example.com',
      contact_id: null,
      payment_id: '5b0c1f7e-7a55-4f0e-9d7c-2d6a7c1e9a10',
      status: 'active',
      enrolled_at: fixedNow,
    })
  })
})
