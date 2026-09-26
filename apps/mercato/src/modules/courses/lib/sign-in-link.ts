/* A course sign-in ("access") link a student asks for again, from the course
 * sign-in page or from an expired or used link (POST
 * /api/courses/student/magic-link).
 *
 * Until 2026-09-26 this email went out only when the business's email
 * provider was a Resend ESP, so a business that sends through Gmail, Outlook,
 * SMTP or another ESP could never get a student back into a course. It now
 * goes through the same sending path as the "You're enrolled!" email and the
 * other transactional CRM emails (sendEmailByPurpose, purpose
 * 'transactional'), with the same rules: the business's own mailbox or ESP,
 * never a Noli sender; with no email set up nothing is sent, the skip is
 * recorded on the student's contact timeline, and the student sees a plain
 * message that the business has to connect email.
 *
 * What the answer may reveal: it never says whether an address is enrolled.
 * The "connect email" message is shown only when the caller named the
 * business themselves (the course's public slug, or a link that business
 * sent them), and then it is given whether or not the address is enrolled.
 * Asked without either, the answer is always the plain "ok".
 *
 * The transport is passed in (sendEmailByPurpose in production), so tests
 * never send mail. Relative imports only. */
import crypto from 'crypto'
import type { Knex } from 'knex'
import { magicLinkExpiresAt, magicLinkTtlLabel } from './magic-tokens'
import { appOrigin } from './enrollment-email'

export const COURSE_EMAIL_NOT_CONNECTED_CODE = 'email_not_connected'
export const COURSE_EMAIL_NOT_CONNECTED_MESSAGE =
  "This course can't send sign-in emails yet. The course owner needs to connect an email account in Noli before a link can be sent. Please contact them for access."

export type SignInLinkSend = (
  knex: Knex,
  orgId: string,
  tenantId: string,
  purpose: 'transactional',
  params: { to: string; subject: string; htmlBody: string; contactId?: string },
) => Promise<{ ok: boolean; code?: string; error?: string }>

export type SignInLinkDeps = {
  send: SignInLinkSend
  hasSendingSetup: (knex: Knex, orgId: string, purpose: 'transactional') => Promise<boolean>
  now?: () => Date
  origin?: string
}

export type SignInLinkRequest = { email: string; courseSlug?: unknown; token?: unknown }

export type SignInLinkResponse =
  | { status: 200; body: { ok: true } }
  | { status: 422; body: { ok: false; code: typeof COURSE_EMAIL_NOT_CONNECTED_CODE; error: string } }

const OK: SignInLinkResponse = { status: 200, body: { ok: true } }
const NOT_CONNECTED: SignInLinkResponse = {
  status: 422,
  body: { ok: false, code: COURSE_EMAIL_NOT_CONNECTED_CODE, error: COURSE_EMAIL_NOT_CONNECTED_MESSAGE },
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function buildSignInEmail(input: { magicLink: string; ttlLabel: string }): { subject: string; html: string } {
  const link = escapeHtml(input.magicLink)
  return {
    subject: 'Your Course Access Link',
    html: `
            <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:32px">
              <h2 style="margin:0 0 8px;font-size:20px">Access Your Courses</h2>
              <p style="color:#64748b;font-size:14px;line-height:1.6;margin-bottom:24px">Click the button below to log in and access your enrolled courses.</p>
              <a href="${link}" style="display:inline-block;background:#6366f1;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">Open My Courses</a>
              <p style="color:#94a3b8;font-size:12px;margin-top:24px">This link is valid for ${escapeHtml(input.ttlLabel)}. You can request a new one anytime. If you didn't request this, you can safely ignore this email.</p>
            </div>`,
  }
}

type Business = { organizationId: string; tenantId: string | null; named: boolean }

/** Which business the request is for, and whether the caller named it. */
async function resolveBusiness(knex: Knex, input: SignInLinkRequest, email: string): Promise<Business | null> {
  const slug = typeof input.courseSlug === 'string' ? input.courseSlug.trim() : ''
  if (slug) {
    // ORG-FILTER-EXEMPT: public course slug names the business; every later query is scoped to it.
    const course = await knex('courses')
      .where('slug', slug)
      .where('is_published', true)
      .whereNull('deleted_at')
      .first('organization_id', 'tenant_id')
    if (course?.organization_id) {
      return { organizationId: String(course.organization_id), tenantId: course.tenant_id ? String(course.tenant_id) : null, named: true }
    }
  }
  const token = typeof input.token === 'string' ? input.token.trim() : ''
  if (token && token.length <= 128) {
    // ORG-FILTER-EXEMPT: the link's own token names the business; every later query is scoped to it.
    const row = await knex('course_magic_tokens').where('token', token).first('organization_id')
    if (row?.organization_id) return { organizationId: String(row.organization_id), tenantId: null, named: true }
  }
  // ORG-FILTER-EXEMPT: asked with neither, the address's own enrollment names the business (unchanged behavior).
  const enrollment = await knex('course_enrollments')
    .where('student_email', email)
    .where('status', 'active')
    .first('organization_id', 'tenant_id')
  if (enrollment?.organization_id) {
    return { organizationId: String(enrollment.organization_id), tenantId: enrollment.tenant_id ? String(enrollment.tenant_id) : null, named: false }
  }
  return null
}

export async function requestCourseSignInLink(
  knex: Knex,
  input: SignInLinkRequest,
  deps: SignInLinkDeps,
): Promise<SignInLinkResponse> {
  const to = (input.email || '').trim()
  const email = to.toLowerCase()
  if (!email) return OK

  const business = await resolveBusiness(knex, input, email)
  if (!business) return OK

  const enrollmentQuery = knex('course_enrollments')
    .where('student_email', email)
    .where('organization_id', business.organizationId)
    .where('status', 'active')
  if (business.tenantId) enrollmentQuery.where('tenant_id', business.tenantId)
  const enrollment = await enrollmentQuery.first('tenant_id', 'contact_id')

  if (!enrollment?.tenant_id) {
    // Not enrolled: say only what is true of the business, never of the address.
    if (business.named && !(await deps.hasSendingSetup(knex, business.organizationId, 'transactional'))) return NOT_CONNECTED
    return OK
  }

  const now = deps.now ? deps.now() : new Date()
  const tokenId = crypto.randomUUID()
  const token = crypto.randomBytes(32).toString('hex')
  await knex('course_magic_tokens').insert({
    id: tokenId,
    organization_id: business.organizationId,
    email,
    token,
    expires_at: magicLinkExpiresAt(now.getTime()),
    created_at: now,
  })
  const magicLink = `${deps.origin || appOrigin()}/api/courses/student/verify?token=${token}`
  const message = buildSignInEmail({ magicLink, ttlLabel: magicLinkTtlLabel() })

  let result: { ok: boolean; code?: string; error?: string }
  try {
    result = await deps.send(knex, business.organizationId, String(enrollment.tenant_id), 'transactional', {
      to,
      subject: message.subject,
      htmlBody: message.html,
      ...(enrollment.contact_id ? { contactId: String(enrollment.contact_id) } : {}),
    })
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  if (result.ok) return OK

  // Nothing was sent, so the link is withdrawn.
  await knex('course_magic_tokens')
    .where('id', tokenId)
    .where('organization_id', business.organizationId)
    .del()
    .catch(() => {})
  if (result.code === COURSE_EMAIL_NOT_CONNECTED_CODE) return business.named ? NOT_CONNECTED : OK
  console.warn('[courses.sign-in-link] not sent:', result.code || 'send_failed', result.error || '')
  return OK
}
