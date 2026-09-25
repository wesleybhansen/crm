/**
 * Sequence enrollment rules, shared by the enroll API and the Sequences page.
 *
 * One behavior (QA 2026-09-24): contacts can be enrolled only into an ACTIVE
 * sequence. A draft or paused sequence does not run, and an email sequence
 * cannot be activated until an email account is connected (422
 * email_not_connected), so there is no "queue now, send whenever email gets
 * connected" path for drafts. Queued enrollments would fire later with no
 * clear moment when the owner chose to start them, which is exactly what the
 * activation gate prevents. Enrollments wait at an email step only in an
 * already-active sequence whose email connection later drops.
 *
 * Relative imports only (no `@/`).
 */

export function enrollmentBlockedReason(status: string | null | undefined): string | null {
  switch (status) {
    case 'active':
      return null
    case 'draft':
      return 'This sequence is a draft. Activate it before enrolling contacts.'
    case 'paused':
      return 'This sequence is paused. Resume it before enrolling contacts.'
    case 'archived':
      return 'This sequence is archived, so it cannot take new enrollments.'
    default:
      return 'Only an active sequence can take new enrollments.'
  }
}

export type EnrollAttempt = { ok: boolean; error?: string | null }

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/**
 * One plain-English line for a batch of enroll calls, carrying the server's
 * real reasons (deduplicated) instead of a guess. Null when all succeeded.
 */
export function summarizeEnrollResults(results: EnrollAttempt[]): { tone: 'success' | 'error'; text: string } | null {
  const total = results.length
  const succeeded = results.filter((r) => r.ok).length
  const failed = total - succeeded
  if (total === 0) return null
  if (failed === 0) return { tone: 'success', text: `Enrolled ${plural(succeeded, 'contact', 'contacts')}.` }
  const reasons = Array.from(new Set(results.filter((r) => !r.ok).map((r) => (r.error || '').trim() || 'Unknown error')))
  const reasonText = reasons.join(' ')
  const lead = succeeded === 0
    ? `Could not enroll ${failed === 1 ? 'the contact' : `any of the ${failed} contacts`}.`
    : `Enrolled ${succeeded} of ${total} contacts. ${plural(failed, 'contact was', 'contacts were')} not enrolled.`
  return { tone: 'error', text: `${lead} ${reasonText}` }
}

/** Copy for the detail page's no-email banner, true to what will happen. */
export function noEmailBannerText(status: string | null | undefined): string {
  if (status === 'active') {
    return 'Enrollments wait at their email step and continue on their own once it is connected.'
  }
  return 'You can activate this sequence and enroll contacts once it is connected.'
}
