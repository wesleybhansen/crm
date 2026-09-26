/** @jest-environment node */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createFakeDb } from '../../../../lib/__tests__/support/fake-db'
import {
  COURSE_EMAIL_NOT_CONNECTED_MESSAGE,
  requestCourseSignInLink,
  type SignInLinkDeps,
  type SignInLinkSend,
} from '../sign-in-link'

/**
 * A course sign-in link could be re-sent only when the business's email
 * provider was Resend. It now goes through the business's own transactional
 * sending path, like the enrollment email: whatever mailbox or ESP the
 * business connected, never a Noli sender, and a plain "connect email"
 * answer when there is none (only to a caller who named the business).
 */

const ORG = 'org-1'
const TENANT = 'ten-1'
const OTHER_ORG = 'org-2'
const OTHER_TENANT = 'ten-2'
const now = new Date('2026-10-01T12:00:00.000Z')

function world() {
  return createFakeDb({
    courses: [
      { id: 'course-1', slug: 'listing-photos', organization_id: ORG, tenant_id: TENANT, is_published: true, deleted_at: null },
      { id: 'course-2', slug: 'other-business', organization_id: OTHER_ORG, tenant_id: OTHER_TENANT, is_published: true, deleted_at: null },
    ],
    course_enrollments: [
      { id: 'enr-1', organization_id: ORG, tenant_id: TENANT, course_id: 'course-1', student_email: 'dana@example.test', contact_id: 'contact-dana', status: 'active' },
      { id: 'enr-2', organization_id: OTHER_ORG, tenant_id: OTHER_TENANT, course_id: 'course-2', student_email: 'lee@example.test', contact_id: 'contact-lee', status: 'active' },
    ],
    course_magic_tokens: [
      { id: 'tok-old', organization_id: ORG, email: 'dana@example.test', token: 'a'.repeat(64), expires_at: new Date('2026-09-01'), created_at: new Date('2026-08-25') },
    ],
    // A Gmail-connected business has no ESP row at all; the link still goes out.
    esp_connections: [],
  })
}

function deps(options: { connected: boolean; sendResult?: Awaited<ReturnType<SignInLinkSend>> }) {
  const send = jest.fn<ReturnType<SignInLinkSend>, Parameters<SignInLinkSend>>(async () =>
    options.sendResult ?? (options.connected
      ? { ok: true }
      : { ok: false, code: 'email_not_connected', error: 'Not sent: no email account is connected.' }))
  const hasSendingSetup = jest.fn(async () => options.connected)
  const d: SignInLinkDeps = { send, hasSendingSetup, now: () => now, origin: 'https://crm.test' }
  return { send, hasSendingSetup, d }
}

const tokens = (knex: ReturnType<typeof world>) => knex.db.tables.course_magic_tokens as Array<Record<string, unknown>>

describe('requestCourseSignInLink', () => {
  it('sends through the business’s own transactional path (any provider), with a fresh link', async () => {
    const knex = world()
    const { send, d } = deps({ connected: true })
    await expect(requestCourseSignInLink(knex as never, { email: ' Dana@Example.test ', courseSlug: 'listing-photos' }, d))
      .resolves.toEqual({ status: 200, body: { ok: true } })

    expect(send).toHaveBeenCalledTimes(1)
    const [, orgId, tenantId, purpose, params] = send.mock.calls[0]
    expect([orgId, tenantId, purpose]).toEqual([ORG, TENANT, 'transactional'])
    expect(params.to).toBe('Dana@Example.test')
    expect(params.contactId).toBe('contact-dana')
    expect(params.subject).toBe('Your Course Access Link')

    const fresh = tokens(knex).find((t) => t.id !== 'tok-old')!
    expect(fresh).toMatchObject({ organization_id: ORG, email: 'dana@example.test' })
    expect(params.htmlBody).toContain(`https://crm.test/api/courses/student/verify?token=${fresh.token}`)
  })

  it('with no email set up: nothing sent, the link withdrawn, and a plain message to connect email', async () => {
    const knex = world()
    const { send, d } = deps({ connected: false })
    const result = await requestCourseSignInLink(knex as never, { email: 'dana@example.test', courseSlug: 'listing-photos' }, d)
    expect(result).toEqual({ status: 422, body: { ok: false, code: 'email_not_connected', error: COURSE_EMAIL_NOT_CONNECTED_MESSAGE } })
    expect(COURSE_EMAIL_NOT_CONNECTED_MESSAGE).toMatch(/connect an email account/)
    expect(COURSE_EMAIL_NOT_CONNECTED_MESSAGE).not.toMatch(/Noli will send|via Noli/)
    // The router was asked (it records the skip on the student's timeline) and refused.
    expect(send).toHaveBeenCalledTimes(1)
    expect(tokens(knex).map((t) => t.id)).toEqual(['tok-old'])
  })

  it('gives the same answer for an address that is not enrolled, so it reveals nothing about the address', async () => {
    const knex = world()
    const offline = deps({ connected: false })
    await expect(requestCourseSignInLink(knex as never, { email: 'stranger@example.test', courseSlug: 'listing-photos' }, offline.d))
      .resolves.toMatchObject({ status: 422 })
    expect(offline.send).not.toHaveBeenCalled()

    const online = deps({ connected: true })
    await expect(requestCourseSignInLink(knex as never, { email: 'stranger@example.test', courseSlug: 'listing-photos' }, online.d))
      .resolves.toEqual({ status: 200, body: { ok: true } })
    expect(online.send).not.toHaveBeenCalled()
  })

  it('an expired link names its business, so its resend gets the plain message too', async () => {
    const knex = world()
    const { d } = deps({ connected: false })
    await expect(requestCourseSignInLink(knex as never, { email: 'dana@example.test', token: 'a'.repeat(64) }, d))
      .resolves.toMatchObject({ status: 422, body: { code: 'email_not_connected' } })
  })

  it('asked without a course or a link, it always answers ok', async () => {
    const knex = world()
    const { send, d } = deps({ connected: false })
    await expect(requestCourseSignInLink(knex as never, { email: 'dana@example.test' }, d)).resolves.toEqual({ status: 200, body: { ok: true } })
    await expect(requestCourseSignInLink(knex as never, { email: 'nobody@example.test' }, d)).resolves.toEqual({ status: 200, body: { ok: true } })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('a provider failure is not reported to the student, and the unsent link is withdrawn', async () => {
    const knex = world()
    const { d } = deps({ connected: true, sendResult: { ok: false, error: 'Gmail token expired' } })
    await expect(requestCourseSignInLink(knex as never, { email: 'dana@example.test', courseSlug: 'listing-photos' }, d))
      .resolves.toEqual({ status: 200, body: { ok: true } })
    expect(tokens(knex).map((t) => t.id)).toEqual(['tok-old'])
  })

  it('never uses another business’s enrollment for a course that names this one', async () => {
    const knex = world()
    const { send, d } = deps({ connected: true })
    await requestCourseSignInLink(knex as never, { email: 'lee@example.test', courseSlug: 'listing-photos' }, d)
    expect(send).not.toHaveBeenCalled()
  })

  it('the route sends through the business’s sending path, never a Resend-only branch', () => {
    const route = readFileSync(join(__dirname, '../../api/student/magic-link/route.ts'), 'utf8')
    expect(route).toContain('requestCourseSignInLink(')
    expect(route).toContain('sendEmailByPurpose')
    expect(route).not.toMatch(/from 'resend'|import\('resend'\)|esp_connections/)
  })
})
