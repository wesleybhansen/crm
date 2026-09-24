/**
 * Org-level email sending readiness (2026-09-24 product rule: Noli sends a
 * customer's email only through the customer's own connected mailbox or ESP,
 * never a fallback; when there is none it blocks and asks them to connect one).
 *
 * - emailNotConnectedBody(): the one refusal body every owner-facing send or
 *   enable path returns (HTTP 422, code 'email_not_connected').
 * - refusalIfNotConnected(): the pre-check those paths call.
 * - getEmailSendingGap(): which enabled features cannot send right now; drives
 *   the backend-wide banner.
 *
 * Relative imports only: this file is reachable from worker bundles through
 * the email router.
 */
import type { Knex } from 'knex'
import {
  EMAIL_NOT_CONNECTED_CODE,
  EMAIL_NOT_CONNECTED_MESSAGE,
  hasSendingSetup,
  type EmailPurpose,
} from './routing-service'

export const EMAIL_NOT_CONNECTED_BANNER =
  "Email isn't connected, so Noli can't send your automations, form replies, booking confirmations or invoices. Connect it in Settings."

// What an event-triggered send records (router error, contact timeline) when
// it was skipped for lack of a sending setup.
export const EMAIL_NOT_SENT_NOT_CONNECTED =
  'Not sent: no email account is connected. Connect one in Settings.'

export type EmailNotConnectedBody = { ok: false; code: typeof EMAIL_NOT_CONNECTED_CODE; error: string }

export function emailNotConnectedBody(message: string = EMAIL_NOT_CONNECTED_MESSAGE): EmailNotConnectedBody {
  return { ok: false, code: EMAIL_NOT_CONNECTED_CODE, error: message }
}

/** Null when the org can send for this purpose, else the 422 body to return. */
export async function refusalIfNotConnected(
  knex: Knex,
  orgId: string,
  purpose: EmailPurpose,
  message?: string,
): Promise<EmailNotConnectedBody | null> {
  return (await hasSendingSetup(knex, orgId, purpose)) ? null : emailNotConnectedBody(message)
}

// Automation actions that send email to a contact.
export const EMAIL_ACTION_TYPES = ['send_email', 'send_survey'] as const

/** True when a rule (legacy single action or multi-step) sends email. */
export function automationSendsEmail(rule: { action_type?: unknown; actionType?: unknown; steps?: unknown }): boolean {
  const isEmail = (value: unknown) => typeof value === 'string' && (EMAIL_ACTION_TYPES as readonly string[]).includes(value)
  let steps = rule.steps
  if (typeof steps === 'string') {
    try { steps = JSON.parse(steps) } catch { steps = null }
  }
  if (Array.isArray(steps) && steps.length > 0) {
    return steps.some((step: any) => step && step.type === 'action' && isEmail(step.actionType))
  }
  return isEmail(rule.action_type ?? rule.actionType)
}

export type EmailFeature = 'automations' | 'sequences' | 'forms' | 'bookings'

export type EmailSendingGap = {
  /** Enabled features whose sends have no sending setup right now. */
  blocked: EmailFeature[]
}

// Which routing purpose each feature sends through (see the call sites):
// automation actions 'automations', sequences 'marketing', form replies
// 'transactional', booking confirmations 'inbox' (booking-emails.ts).
const FEATURE_PURPOSE: Record<EmailFeature, EmailPurpose> = {
  automations: 'automations',
  sequences: 'marketing',
  forms: 'transactional',
  bookings: 'inbox',
}

async function featureEnabled(knex: Knex, orgId: string, feature: EmailFeature): Promise<boolean> {
  switch (feature) {
    case 'automations': {
      const rules = await knex('automation_rules')
        .where('organization_id', orgId)
        .where('is_active', true)
        .select('action_type', 'steps')
      return rules.some((rule: any) => automationSendsEmail(rule))
    }
    case 'sequences': {
      const row = await knex('sequences as s')
        .join('sequence_steps as ss', 'ss.sequence_id', 's.id')
        .where('s.organization_id', orgId)
        .where('s.status', 'active')
        .whereNull('s.deleted_at')
        .where('ss.step_type', 'email')
        .first('s.id')
      return !!row
    }
    case 'forms': {
      const row = await knex('forms')
        .where('organization_id', orgId)
        .where('is_active', true)
        .whereNull('deleted_at')
        .whereRaw("(settings->>'notifyEmail' IS NOT NULL OR settings->'leadMagnet'->>'downloadUrl' IS NOT NULL)")
        .first('id')
      return !!row
    }
    case 'bookings': {
      const row = await knex('booking_pages').where('organization_id', orgId).where('is_active', true).first('id')
      return !!row
    }
  }
}

/**
 * Enabled email-sending features that cannot send because the org has no
 * sending setup for their purpose. Best-effort per feature: a failed read
 * leaves that feature out rather than failing the page.
 */
export async function getEmailSendingGap(knex: Knex, orgId: string): Promise<EmailSendingGap> {
  const blocked: EmailFeature[] = []
  const readiness = new Map<EmailPurpose, boolean>()
  for (const feature of Object.keys(FEATURE_PURPOSE) as EmailFeature[]) {
    try {
      if (!(await featureEnabled(knex, orgId, feature))) continue
      const purpose = FEATURE_PURPOSE[feature]
      if (!readiness.has(purpose)) readiness.set(purpose, await hasSendingSetup(knex, orgId, purpose))
      if (!readiness.get(purpose)) blocked.push(feature)
    } catch {
      // leave this feature out
    }
  }
  return { blocked }
}
