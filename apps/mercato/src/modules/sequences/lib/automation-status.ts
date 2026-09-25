/**
 * Client-safe helpers for the automation editor (no server imports).
 *
 * An automation that emails contacts cannot be switched on while the workspace
 * has no connected email account (the API refuses with 422
 * email_not_connected). The editor therefore opens such a NEW automation as
 * paused and says why, instead of promising it "will run immediately".
 */

const EMAIL_ACTIONS = ['send_email', 'send_survey']

export type EditorStep = { type?: string; actionType?: string }

export function stepsSendEmail(steps: EditorStep[] | null | undefined): boolean {
  return Array.isArray(steps) && steps.some((step) => step?.type === 'action' && EMAIL_ACTIONS.includes(String(step.actionType)))
}

/**
 * Initial status for the editor. Existing rules keep their status. A new rule
 * (blank, from a template or from AI) starts paused when it sends email and
 * email is known to be disconnected; otherwise it keeps the requested status.
 */
export function initialAutomationStatus(opts: {
  isNew: boolean
  requested: string | null | undefined
  steps: EditorStep[] | null | undefined
  emailConnected: boolean | null | undefined
}): 'active' | 'paused' {
  const requested = opts.requested === 'paused' ? 'paused' : 'active'
  if (!opts.isNew) return requested
  if (opts.emailConnected === false && stepsSendEmail(opts.steps)) return 'paused'
  return requested
}

/** The one line under the editor's Status switch. */
export function automationStatusHint(opts: {
  status: 'active' | 'paused'
  steps: EditorStep[] | null | undefined
  emailConnected: boolean | null | undefined
}): { text: string; warning: boolean } {
  if (opts.emailConnected === false && stepsSendEmail(opts.steps)) {
    return opts.status === 'active'
      ? { text: "Email isn't connected, so this can't be turned on yet. Save it paused, then turn it on after you connect an email account in Settings.", warning: true }
      : { text: "Paused because email isn't connected. Connect an email account in Settings, then turn it on.", warning: true }
  }
  return opts.status === 'active'
    ? { text: 'Automation will run immediately', warning: false }
    : { text: 'Automation is paused', warning: false }
}
