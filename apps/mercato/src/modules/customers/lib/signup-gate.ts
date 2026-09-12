/**
 * Single source of truth for "who may create a brand-new workspace account".
 *
 * Both sign-up paths must consult this:
 *   - email/password:  POST /api/auth/signup
 *   - Google OAuth:    GET  /api/auth/google/callback (when neither googleSub nor email matches an existing user)
 *
 * Existing users are never gated here; this only decides whether a NEW account may be created.
 *
 * The repo has no staff-invitation table: an "invitation" is an entry in the beta whitelist below,
 * optionally extended at runtime via SIGNUP_INVITED_EMAILS (comma-separated) so an invite can be
 * granted without a deploy.
 */

export const SIGNUP_INVITE_ONLY_MESSAGE = 'Signups are currently invite-only. Contact us for access.'

const BETA_WHITELIST = ['wesley.b.hansen@gmail.com', 'weshansen123@yahoo.com']

export function normalizeSignupEmail(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

function envInvitedEmails(): string[] {
  const raw = process.env.SIGNUP_INVITED_EMAILS
  if (!raw) return []
  return raw
    .split(',')
    .map((e) => normalizeSignupEmail(e))
    .filter(Boolean)
}

/** True when a new account may be created for this email (it holds an invitation). */
export function isSignupInvited(email: unknown): boolean {
  const normalized = normalizeSignupEmail(email)
  if (!normalized) return false
  if (BETA_WHITELIST.includes(normalized)) return true
  return envInvitedEmails().includes(normalized)
}
