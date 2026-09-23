/**
 * Email from Noli itself to a Noli user (digests, meeting prep, flag alerts, reminders, booking alerts,
 * team invites). These are the platform talking to its customer, so they always go out through Noli's own
 * sending account from a noliai.com address — never through a mailbox the user connected. Before
 * 2026-09-23 they fell back to the connected mailbox, so owners received "Noli" mail from their own
 * personal Gmail, and invites went out from the inviter's personal address.
 *
 * Fails closed: if the platform sender is not configured the email is not sent (and the caller logs it);
 * it never falls back to a personal mailbox.
 *
 * Env: PLATFORM_RESEND_API_KEY (Noli's own Resend account, the one with noliai.com verified; falls back to
 * RESEND_API_KEY) and NOTIFICATIONS_EMAIL_FROM (e.g. "Noli <notifications@noliai.com>", falls back to EMAIL_FROM).
 */
import { sendViaESP } from './esp-service'

export interface PlatformSendResult {
  ok: boolean
  messageId?: string
  error?: string
}

export function platformSenderAddress(): string | null {
  const from = (process.env.NOTIFICATIONS_EMAIL_FROM || process.env.EMAIL_FROM || '').trim()
  if (!from || !from.includes('@') || from.includes('localhost')) return null
  return from
}

export async function sendPlatformNotification(params: {
  to: string
  subject: string
  htmlBody: string
}): Promise<PlatformSendResult> {
  const apiKey = (process.env.PLATFORM_RESEND_API_KEY || process.env.RESEND_API_KEY || '').trim()
  const from = platformSenderAddress()
  if (!apiKey || !from) {
    return { ok: false, error: 'Platform sender not configured (PLATFORM_RESEND_API_KEY / NOTIFICATIONS_EMAIL_FROM)' }
  }
  try {
    const result = await sendViaESP('resend', apiKey, from, params.to, params.subject, params.htmlBody)
    return { ok: true, messageId: result.messageId }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to send platform notification'
    console.error('[platform-sender] send failed:', message)
    return { ok: false, error: message }
  }
}
