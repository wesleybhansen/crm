/* The "You're enrolled!" email, shared by free enrollment (POST
 * /api/courses/enrollments) and paid enrollment (the Stripe webhook, after it
 * has recorded the payment). Until 2026-09-25 only the free path sent it, so a
 * student who paid had no email and no way back into the course once the
 * post-checkout tab was closed.
 *
 * Sent at most once per enrollment, decided by our own row:
 * course_enrollments.welcome_email_sent_at is claimed with a conditional
 * UPDATE (NULL -> now) before sending, and released again if the send fails.
 * Never keyed on a provider id (Stripe event or session ids, ESP keys).
 * Before the column exists (Migration20260926130000_courses not applied yet),
 * the send is still attempted: both callers only call this right after they
 * inserted the enrollment, which is itself once per enrollment.
 *
 * The email transport is passed in (sendEmailByPurpose in production), so this
 * file has no provider imports and tests never send mail. Relative imports only. */
import crypto from 'crypto'
import type { Knex } from 'knex'
import { magicLinkExpiresAt, magicLinkTtlLabel } from './magic-tokens'

export type EnrollmentEmailSend = (
  knex: Knex,
  orgId: string,
  tenantId: string,
  purpose: 'transactional',
  params: { to: string; subject: string; htmlBody: string; contactId?: string },
) => Promise<{ ok: boolean; error?: string }>

export type EnrollmentEmailInput = {
  enrollmentId: string
  tenantId: string
  organizationId: string
  studentEmail: string
  courseTitle: string
  contactId?: string | null
}

export type EnrollmentEmailResult =
  | { sent: true }
  | { sent: false; reason: 'already_sent' | 'send_failed' | 'no_email'; error?: string }

type ClaimOutcome = 'claimed' | 'already_sent' | 'untracked'

const UNDEFINED_COLUMN = '42703'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function appOrigin(): string {
  return process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
}

export function buildEnrollmentEmail(input: { courseTitle: string; magicLink: string; ttlLabel: string }): { subject: string; html: string } {
  const title = escapeHtml(input.courseTitle)
  const link = escapeHtml(input.magicLink)
  return {
    subject: `Welcome to ${input.courseTitle}! Access your course`,
    html: `<div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px">
        <h2 style="margin:0 0 8px;font-size:20px">You're enrolled!</h2>
        <p style="color:#64748b;font-size:14px;line-height:1.6;margin-bottom:20px">Welcome to <strong>${title}</strong>. Click below to start learning.</p>
        <a href="${link}" style="display:inline-block;background:#6366f1;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">Start Course</a>
        <p style="color:#94a3b8;font-size:12px;margin-top:24px">This link is valid for ${escapeHtml(input.ttlLabel)}. You can request a new one anytime.</p>
      </div>`,
  }
}

function enrollmentRow(knex: Knex, input: EnrollmentEmailInput) {
  return knex('course_enrollments')
    .where('id', input.enrollmentId)
    .where('tenant_id', input.tenantId)
    .where('organization_id', input.organizationId)
}

async function claimEnrollmentEmail(knex: Knex, input: EnrollmentEmailInput, now: Date): Promise<ClaimOutcome> {
  try {
    const updated = await enrollmentRow(knex, input)
      .whereNull('welcome_email_sent_at')
      .update({ welcome_email_sent_at: now })
    return Number(updated) > 0 ? 'claimed' : 'already_sent'
  } catch (err) {
    if ((err as { code?: string } | null)?.code === UNDEFINED_COLUMN) {
      console.warn('[courses.enrollment-email] course_enrollments.welcome_email_sent_at is missing; apply Migration20260926130000_courses')
      return 'untracked'
    }
    throw err
  }
}

/** Send the enrollment email for one enrollment, at most once. */
export async function sendEnrollmentEmailOnce(
  knex: Knex,
  input: EnrollmentEmailInput,
  deps: { send: EnrollmentEmailSend; now?: () => Date; origin?: string },
): Promise<EnrollmentEmailResult> {
  const to = (input.studentEmail || '').trim()
  if (!to) return { sent: false, reason: 'no_email' }
  const now = deps.now ? deps.now() : new Date()

  const claim = await claimEnrollmentEmail(knex, input, now)
  if (claim === 'already_sent') return { sent: false, reason: 'already_sent' }

  const release = async () => {
    if (claim !== 'claimed') return
    await enrollmentRow(knex, input).update({ welcome_email_sent_at: null }).catch(() => {})
  }

  try {
    // A fresh access link: the checkout's own post-payment link may already be used.
    const token = crypto.randomBytes(32).toString('hex')
    await knex('course_magic_tokens').insert({
      id: crypto.randomUUID(),
      organization_id: input.organizationId,
      email: to.toLowerCase(),
      token,
      expires_at: magicLinkExpiresAt(now.getTime()),
      created_at: now,
    })
    const magicLink = `${deps.origin || appOrigin()}/api/courses/student/verify?token=${token}`
    const email = buildEnrollmentEmail({ courseTitle: input.courseTitle, magicLink, ttlLabel: magicLinkTtlLabel() })
    const result = await deps.send(knex, input.organizationId, input.tenantId, 'transactional', {
      to,
      subject: email.subject,
      htmlBody: email.html,
      ...(input.contactId ? { contactId: input.contactId } : {}),
    })
    if (!result.ok) {
      await release()
      return { sent: false, reason: 'send_failed', error: result.error }
    }
    return { sent: true }
  } catch (err) {
    await release()
    return { sent: false, reason: 'send_failed', error: err instanceof Error ? err.message : String(err) }
  }
}

/** The course_enrollments row for a paid enrollment. payment_id is OUR
 * payment_records.id (a uuid, like the column): the Stripe PaymentIntent id
 * ("pi_...") is not a uuid, and writing it failed the whole insert, so the
 * student paid and was never enrolled. The Stripe id stays on payment_records. */
export function paidEnrollmentRow(input: {
  enrollmentId: string
  tenantId: string
  organizationId: string
  courseId: string
  studentName: string
  studentEmail: string
  paymentRecordId: string
  now?: Date
}): Record<string, unknown> {
  const email = input.studentEmail.trim().toLowerCase()
  return {
    id: input.enrollmentId,
    tenant_id: input.tenantId,
    organization_id: input.organizationId,
    course_id: input.courseId,
    student_name: (input.studentName || '').trim() || email,
    student_email: email,
    contact_id: null,
    payment_id: input.paymentRecordId,
    status: 'active',
    enrolled_at: input.now ?? new Date(),
  }
}
