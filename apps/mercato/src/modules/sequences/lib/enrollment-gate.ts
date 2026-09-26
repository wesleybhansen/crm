import type { Knex } from 'knex'
import { isContactUnsubscribed, UNSUBSCRIBED_CODE, UNSUBSCRIBED_ENROLL_REASON } from '../../email/lib/unsubscribes'
import { logTimelineEvent } from '../../../lib/timeline'

/**
 * The enrollment side of the unsubscribe gate (2026-09-26). Every way into a
 * sequence asks this first: manual enrollment (the Sequences page and the
 * assistant, through /api/sequences/[id]/enroll), every trigger
 * (services/sequence-triggers.ts), the automation "Enroll in sequence" action
 * and the inbox's one-click suggestion. A contact in email_unsubscribes (by
 * contact id or address, this organization and tenant only) is not enrolled,
 * and the reason is plain. The send-time gate (lib/email-step.ts and the email
 * router) still stands behind this for anyone who unsubscribes after enrolling.
 *
 * Relative imports only: reachable from worker-bundled subscribers.
 */

export type EnrollmentRefusal = { code: typeof UNSUBSCRIBED_CODE; reason: string }

export async function unsubscribedEnrollmentRefusal(
  knex: Knex,
  scope: { organizationId: string; tenantId: string },
  contactId: string,
  extraEmails: Array<string | null | undefined> = [],
): Promise<EnrollmentRefusal | null> {
  const unsubscribed = await isContactUnsubscribed(knex, scope, contactId, extraEmails)
  return unsubscribed ? { code: UNSUBSCRIBED_CODE, reason: UNSUBSCRIBED_ENROLL_REASON } : null
}

/** An automatic enrollment the gate refused, on the contact's timeline, where the owner looks. */
export async function recordEnrollmentSkipped(
  knex: Knex,
  scope: { organizationId: string; tenantId: string },
  input: { contactId: string; sequenceId: string; sequenceName?: string | null; reason: string; trigger?: string | null },
): Promise<void> {
  await logTimelineEvent(knex, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    contactId: input.contactId,
    eventType: 'sequence_not_enrolled',
    title: `Not enrolled in sequence: ${input.sequenceName || 'a sequence'}`,
    description: input.reason,
    metadata: { sequenceId: input.sequenceId, reason: UNSUBSCRIBED_CODE, ...(input.trigger ? { trigger: input.trigger } : {}) },
  })
}
