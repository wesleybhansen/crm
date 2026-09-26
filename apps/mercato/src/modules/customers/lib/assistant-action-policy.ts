/* Confirm-before-acting policy for the CRM assistant.
 *
 * Text mode shows every non-read-only action as a Confirm/Cancel prompt before
 * anything runs. Voice mode executes tool calls as the model emits them, so it
 * needs its own gate: any action that destroys data, moves money, or reaches
 * someone outside the CRM (email, SMS, invoices, sequences, public pages) must
 * wait for the user's explicit Confirm, exactly like text mode.
 *
 * The voice gate FAILS CLOSED: an action is only auto-run when it is a known
 * read or a known internal, reversible write. A new tool or a new sub-action
 * that nobody classified here asks for confirmation.
 *
 * Pure module (no React, no fetch) so it is unit-testable and safe to import
 * from anywhere. */

import { READ_ONLY_TOOLS } from './crm-tool-catalog'

export interface AssistantAction {
  type: string
  data?: Record<string, unknown> | null
}

export type AssistantActionRisk = 'read' | 'write' | 'destructive' | 'outbound'

export type AssistantMode = 'text' | 'voice'

// Grouped manage_* tools carry the operation in data.action.
const READ_SUB_ACTIONS: Record<string, readonly string[]> = {
  manage_company: ['search'],
  manage_contact_advanced: ['view_attachments', 'export_csv'],
  manage_task_advanced: ['list_overdue'],
  manage_pipeline: ['get_stages'],
  manage_product_advanced: ['list_details'],
  manage_sequence_advanced: ['list_enrollments'],
  manage_landing_page: ['get_analytics'],
  manage_funnel: ['get_analytics'],
  manage_event_advanced: ['get_attendees'],
  manage_calendar: ['get_today', 'get_week'],
  manage_survey_advanced: ['get_responses'],
  manage_form_advanced: ['get_submissions'],
  manage_chat_widget: ['get_conversations'],
  manage_automation_advanced: ['get_logs'],
}

// Internal, reversible writes voice may run without a prompt.
const SAFE_WRITE_TOOLS = new Set([
  'create_contact',
  'create_task',
  'add_note',
  'add_commitment',
  'resolve_commitment',
  'add_tag',
  'remove_tag',
  'create_deal',
  'move_deal_stage',
  'move_contact_stage',
  'create_invoice', // creates a draft; sending is a separate, gated action
  'create_product',
  'update_contact',
  'edit_contact',
  'create_reminder',
  'set_reminder',
  'create_email_campaign', // draft only; manage_campaign send is gated
  'create_booking_page',
  'create_event',
  'create_survey',
  'create_form',
  'create_email_list',
  'add_to_email_list',
  'edit_event',
  'edit_task',
  'complete_task',
  'edit_deal',
  'edit_product',
  'pause_sequence',
  'create_funnel',
  'create_course',
  'create_email_sequence', // created with no enrollments, so nothing sends
  'ai_draft_email', // drafts text, sends nothing
])

const SAFE_WRITE_SUB_ACTIONS: Record<string, readonly string[]> = {
  manage_deal: ['edit'],
  manage_company: ['create', 'link_contact', 'unlink_contact'],
  manage_contact_advanced: ['set_lifecycle_stage'],
  manage_task_advanced: ['edit', 'complete'],
  manage_product_advanced: ['edit'],
  manage_campaign: ['edit', 'test'], // test goes to the signed-in user only
  manage_sequence_advanced: ['pause', 'edit'],
  manage_email_list_advanced: ['edit', 'add_bulk'],
  manage_landing_page: ['edit'],
  manage_event_advanced: ['edit'],
  manage_booking: ['edit_page'],
  manage_calendar: ['block_time'],
  manage_survey_advanced: ['edit', 'toggle_active'],
  manage_form_advanced: ['edit', 'duplicate'],
  manage_course_advanced: ['edit', 'generate_outline', 'generate_landing'],
  manage_chat_widget: ['create', 'edit', 'toggle_active'],
  manage_inbox_conversation: ['mark_read', 'close', 'reopen', 'add_note', 'ai_draft'],
  manage_affiliate: ['create_campaign', 'pause'],
  manage_automation_advanced: ['disable', 'edit'],
  update_settings: ['update_profile', 'update_persona'],
}

// Reaches a person outside the CRM or the public web.
const OUTBOUND_TOOLS = new Set([
  'send_email',
  'send_sms',
  'send_invoice',
  'enroll_in_sequence',
  'activate_sequence',
  'publish_landing_page',
  'create_landing_page', // generates AND publishes the page
  'create_automation_rule', // created active, so it can send on its own
])

const OUTBOUND_SUB_ACTIONS: Record<string, readonly string[]> = {
  manage_invoice: ['send'],
  manage_campaign: ['send'],
  manage_sequence_advanced: ['activate'],
  manage_survey_advanced: ['send'],
  manage_event_advanced: ['email_attendees', 'publish'],
  manage_booking: ['confirm'],
  manage_inbox_conversation: ['reply'],
  manage_landing_page: ['publish'],
  manage_funnel: ['publish'],
  manage_course_advanced: ['publish'],
  manage_affiliate: ['add_affiliate'],
  manage_automation_advanced: ['enable', 'test', 'duplicate'],
  update_settings: ['invite_team'],
}

// Deal stage names that close a deal: moving there is the same as closing it.
const CLOSING_STAGE = /\b(won|win|lost|lose|loose|closed)\b/i

function subActionOf(action: AssistantAction): string {
  const raw = action.data && typeof action.data === 'object' ? (action.data as Record<string, unknown>).action : undefined
  return typeof raw === 'string' ? raw.trim().toLowerCase() : ''
}

function stageOf(action: AssistantAction): string {
  const raw = action.data && typeof action.data === 'object' ? (action.data as Record<string, unknown>).stage : undefined
  return typeof raw === 'string' ? raw : ''
}

function listed(map: Record<string, readonly string[]>, type: string, sub: string): boolean {
  return !!sub && (map[type] ?? []).includes(sub)
}

/**
 * Classify one assistant action. Anything not positively known to be a read or
 * a safe internal write is 'destructive' (fail closed).
 */
export function classifyAssistantAction(action: AssistantAction): AssistantActionRisk {
  const type = typeof action?.type === 'string' ? action.type : ''
  if (!type) return 'destructive'
  const sub = subActionOf(action)

  if (READ_ONLY_TOOLS.has(type)) return 'read'
  if (listed(READ_SUB_ACTIONS, type, sub)) return 'read'

  if (OUTBOUND_TOOLS.has(type) || listed(OUTBOUND_SUB_ACTIONS, type, sub)) return 'outbound'

  // Moving a deal into a Won or Lost stage closes it (reports, the deal-closed
  // event, the marketing app all follow), so treat it like close_deal.
  if ((type === 'move_deal_stage' || type === 'edit_deal' || (type === 'manage_deal' && sub === 'edit'))
    && CLOSING_STAGE.test(stageOf(action))) {
    return 'destructive'
  }

  if (SAFE_WRITE_TOOLS.has(type)) return 'write'
  if (listed(SAFE_WRITE_SUB_ACTIONS, type, sub)) return 'write'

  return 'destructive'
}

/**
 * Whether the assistant must show Confirm/Cancel and wait before running the
 * action. Text mode: every non-read action (unchanged behaviour). Voice mode:
 * every destructive or outbound action, and anything unclassified.
 */
export function requiresConfirmation(action: AssistantAction, mode: AssistantMode): boolean {
  if (mode === 'text') return !READ_ONLY_TOOLS.has(action?.type)
  const risk = classifyAssistantAction(action)
  return risk === 'destructive' || risk === 'outbound'
}

export interface AssistantActionResult {
  ok: boolean
  message: string
}

export interface VoiceToolCallDeps {
  /** Show a Confirm/Cancel prompt and resolve with the user's choice. */
  requestConfirmation: (action: AssistantAction) => Promise<boolean>
  /** Run the action against the CRM. */
  execute: (action: AssistantAction) => Promise<AssistantActionResult>
  /** Called right before an action that needs no prompt runs (UI bubble). */
  onAutoExecute?: (action: AssistantAction) => void
}

export type VoiceToolCallOutcome =
  | { status: 'cancelled' }
  | { status: 'executed'; confirmed: boolean; result: AssistantActionResult }

/**
 * The voice tool-call gate. Confirmation-required actions never reach
 * execute() unless requestConfirmation resolves true.
 */
export async function runVoiceToolCall(action: AssistantAction, deps: VoiceToolCallDeps): Promise<VoiceToolCallOutcome> {
  if (requiresConfirmation(action, 'voice')) {
    let confirmed = false
    try {
      confirmed = (await deps.requestConfirmation(action)) === true
    } catch {
      confirmed = false
    }
    if (!confirmed) return { status: 'cancelled' }
    const result = await deps.execute(action)
    return { status: 'executed', confirmed: true, result }
  }
  deps.onAutoExecute?.(action)
  const result = await deps.execute(action)
  return { status: 'executed', confirmed: false, result }
}
