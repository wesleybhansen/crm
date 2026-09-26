import { CRM_TOOLS, READ_ONLY_TOOLS } from '../crm-tool-catalog'
import {
  classifyAssistantAction,
  requiresConfirmation,
  runVoiceToolCall,
  type AssistantAction,
} from '../assistant-action-policy'

// Voice mode used to run these straight away (only a short hand list of
// manage_* deletes was gated): the security bug this suite pins shut.
const MUST_CONFIRM_IN_VOICE: AssistantAction[] = [
  { type: 'delete_deal', data: { dealId: 'd1' } },
  { type: 'delete_task', data: { taskId: 't1' } },
  { type: 'delete_invoice', data: { invoiceId: 'i1' } },
  { type: 'delete_contact', data: { contactId: 'c1' } },
  { type: 'delete_event', data: { eventId: 'e1' } },
  { type: 'delete_product', data: { productId: 'p1' } },
  { type: 'delete_landing_page', data: { pageId: 'l1' } },
  { type: 'delete_booking_page', data: { pageId: 'b1' } },
  { type: 'send_invoice', data: { invoiceId: 'i1' } },
  { type: 'send_email', data: { to: 'consumerprofile@protonmail.com', subject: 'Hi', body: 'x' } },
  { type: 'send_sms', data: { to: '+15555550100', message: 'x' } },
  { type: 'enroll_in_sequence', data: { contactId: 'c1', sequenceId: 's1' } },
  { type: 'activate_sequence', data: { sequenceId: 's1' } },
  { type: 'close_deal', data: { dealId: 'd1', result: 'won' } },
  { type: 'close_deal', data: { dealId: 'd1', result: 'lost' } },
  { type: 'cancel_event', data: { eventId: 'e1' } },
  { type: 'mark_invoice_paid', data: { invoiceId: 'i1' } },
  { type: 'publish_landing_page', data: { pageId: 'l1' } },
  { type: 'create_landing_page', data: { title: 'Offer' } },
  { type: 'create_automation_rule', data: { name: 'Welcome' } },
  { type: 'manage_deal', data: { action: 'delete', dealId: 'd1' } },
  { type: 'manage_deal', data: { action: 'close_won', dealId: 'd1' } },
  { type: 'manage_deal', data: { action: 'close_lost', dealId: 'd1' } },
  { type: 'manage_task_advanced', data: { action: 'delete', taskId: 't1' } },
  { type: 'manage_invoice', data: { action: 'send', invoiceId: 'i1' } },
  { type: 'manage_invoice', data: { action: 'delete', invoiceId: 'i1' } },
  { type: 'manage_invoice', data: { action: 'mark_paid', invoiceId: 'i1' } },
  { type: 'manage_campaign', data: { action: 'send', campaignId: 'm1' } },
  { type: 'manage_inbox_conversation', data: { action: 'reply', conversationId: 'x' } },
  { type: 'manage_event_advanced', data: { action: 'email_attendees', eventId: 'e1' } },
  { type: 'manage_survey_advanced', data: { action: 'send', surveyId: 's1' } },
  { type: 'manage_sequence_advanced', data: { action: 'activate', sequenceId: 's1' } },
  { type: 'manage_booking', data: { action: 'confirm', bookingId: 'b1' } },
  { type: 'process_payment', data: { action: 'refund', paymentId: 'p1' } },
  { type: 'process_payment', data: { action: 'cancel_subscription', subscriptionId: 's1' } },
  { type: 'update_settings', data: { action: 'invite_team', teamEmail: 'consumerprofile@protonmail.com' } },
  { type: 'manage_contact_advanced', data: { action: 'merge', contactId: 'c1' } },
  { type: 'manage_pipeline', data: { action: 'update_stages', stages: ['A'] } },
  // Moving a deal into Won/Lost closes it.
  { type: 'move_deal_stage', data: { dealId: 'd1', stage: 'Closed Won' } },
  { type: 'edit_deal', data: { dealId: 'd1', stage: 'Lost' } },
  { type: 'manage_deal', data: { action: 'edit', dealId: 'd1', stage: 'Won' } },
]

describe('assistant action policy: voice mode', () => {
  it.each(MUST_CONFIRM_IN_VOICE.map((a) => [`${a.type}${a.data?.action ? `:${a.data.action}` : ''}`, a] as const))(
    '%s requires confirmation in voice mode',
    (_label, action) => {
      expect(requiresConfirmation(action, 'voice')).toBe(true)
    },
  )

  it('never runs a delete or a send until the user confirms', async () => {
    for (const action of MUST_CONFIRM_IN_VOICE) {
      const execute = jest.fn(async () => ({ ok: true, message: 'done' }))
      const onAutoExecute = jest.fn()
      const requestConfirmation = jest.fn(async () => false)
      const outcome = await runVoiceToolCall(action, { requestConfirmation, execute, onAutoExecute })
      expect(requestConfirmation).toHaveBeenCalledTimes(1)
      expect(execute).not.toHaveBeenCalled()
      expect(onAutoExecute).not.toHaveBeenCalled()
      expect(outcome).toEqual({ status: 'cancelled' })
    }
  })

  it('does not run the action when the confirmation prompt fails', async () => {
    const execute = jest.fn(async () => ({ ok: true, message: 'done' }))
    const outcome = await runVoiceToolCall(
      { type: 'delete_deal', data: { dealId: 'd1' } },
      { requestConfirmation: async () => { throw new Error('ui gone') }, execute },
    )
    expect(execute).not.toHaveBeenCalled()
    expect(outcome.status).toBe('cancelled')
  })

  it('runs the action exactly once after the user confirms', async () => {
    const order: string[] = []
    const execute = jest.fn(async () => { order.push('execute'); return { ok: true, message: 'Invoice sent' } })
    const outcome = await runVoiceToolCall(
      { type: 'send_invoice', data: { invoiceId: 'i1' } },
      { requestConfirmation: async () => { order.push('confirm'); return true }, execute },
    )
    expect(order).toEqual(['confirm', 'execute'])
    expect(execute).toHaveBeenCalledTimes(1)
    expect(outcome).toEqual({ status: 'executed', confirmed: true, result: { ok: true, message: 'Invoice sent' } })
  })

  it('runs safe internal writes and reads without a prompt', async () => {
    for (const action of [
      { type: 'create_task', data: { title: 'Call Maria' } },
      { type: 'add_note', data: { contactId: 'c1', content: 'x' } },
      { type: 'move_deal_stage', data: { dealId: 'd1', stage: 'Proposal' } },
      { type: 'get_pipeline_summary', data: {} },
      { type: 'manage_task_advanced', data: { action: 'complete', taskId: 't1' } },
    ] as AssistantAction[]) {
      const requestConfirmation = jest.fn(async () => true)
      const execute = jest.fn(async () => ({ ok: true, message: 'ok' }))
      const outcome = await runVoiceToolCall(action, { requestConfirmation, execute })
      expect(requestConfirmation).not.toHaveBeenCalled()
      expect(execute).toHaveBeenCalledTimes(1)
      expect(outcome.status).toBe('executed')
    }
  })

  it('fails closed: unknown tools and unknown sub-actions ask first', () => {
    expect(requiresConfirmation({ type: 'wipe_everything', data: {} }, 'voice')).toBe(true)
    expect(requiresConfirmation({ type: 'manage_deal', data: { action: 'archive_all' } }, 'voice')).toBe(true)
    expect(requiresConfirmation({ type: 'manage_invoice', data: {} }, 'voice')).toBe(true)
    expect(requiresConfirmation({ type: '', data: {} }, 'voice')).toBe(true)
  })

  it('every sub-action in the tool catalog that deletes, sends, publishes or moves money asks first', () => {
    // "close" alone is closing an inbox thread (reopenable); close_won/close_lost close deals.
    const risky = /delete|send|reply|email|refund|cancel|publish|remove|merge|invite|activate|close_|approve|reject|payout/
    const checked: string[] = []
    for (const tool of CRM_TOOLS) {
      const actionProp = (tool.parameters as any)?.properties?.action
      const values: string[] = Array.isArray(actionProp?.enum) ? actionProp.enum : []
      for (const sub of values) {
        if (!risky.test(sub)) continue
        if (sub === 'unpublish') continue
        checked.push(`${tool.name}:${sub}`)
        expect({ tool: tool.name, sub, confirm: requiresConfirmation({ type: tool.name, data: { action: sub } }, 'voice') })
          .toEqual({ tool: tool.name, sub, confirm: true })
      }
      if (/^(delete_|send_|cancel_)/.test(tool.name)) {
        checked.push(tool.name)
        expect({ tool: tool.name, confirm: requiresConfirmation({ type: tool.name, data: {} }, 'voice') })
          .toEqual({ tool: tool.name, confirm: true })
      }
    }
    expect(checked.length).toBeGreaterThan(20)
  })
})

describe('assistant action policy: text mode is unchanged', () => {
  it('asks before every non-read tool and auto-runs reads', () => {
    for (const tool of CRM_TOOLS) {
      const expected = !READ_ONLY_TOOLS.has(tool.name)
      expect({ tool: tool.name, confirm: requiresConfirmation({ type: tool.name, data: {} }, 'text') })
        .toEqual({ tool: tool.name, confirm: expected })
    }
  })

  it('classifies reads as read', () => {
    expect(classifyAssistantAction({ type: 'find_entity', data: {} })).toBe('read')
    expect(classifyAssistantAction({ type: 'manage_calendar', data: { action: 'get_week' } })).toBe('read')
  })
})
