export const metadata = { POST: { requireAuth: true } }
export const openApi = { summary: 'ai-chat', methods: {} }
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'

type ChatMessage = { role: 'user' | 'assistant'; content: string }

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const aiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY
  if (!aiKey) {
    return NextResponse.json({ ok: false, error: 'AI not configured' }, { status: 500 })
  }

  const body = await req.json()
  const { message, history, context } = body as {
    message: string
    history?: ChatMessage[]
    context?: {
      currentRule?: Record<string, any>
      existingRules?: Array<{ name: string; trigger_type: string; action_type: string; status: string }>
    }
  }

  if (!message?.trim()) {
    return NextResponse.json({ ok: false, error: 'Message required' }, { status: 400 })
  }

  const existingRulesContext = context?.existingRules?.length
    ? context.existingRules.map(r => `- "${r.name}" (trigger: ${r.trigger_type}, action: ${r.action_type}, status: ${r.status})`).join('\n')
    : 'No automations created yet.'

  const currentRuleContext = context?.currentRule
    ? `AUTOMATION BEING EDITED:
Name: ${context.currentRule.name || '(unnamed)'}
Trigger: ${context.currentRule.trigger_type || '(not set)'}
Action: ${context.currentRule.action_type || '(not set)'}
Status: ${context.currentRule.status || 'draft'}`
    : ''

  const systemPrompt = `You are an AI assistant helping users set up and troubleshoot automations in their CRM. Be helpful, concise, and practical.

AVAILABLE TRIGGER TYPES:
- contact_created: Fires when a new contact is added to the CRM
- contact_updated: Fires when a contact's information changes
- company_created: Fires when a new company record is added
- tag_added: Fires when a tag is assigned to a contact
- tag_removed: Fires when a tag is removed from a contact
- deal_created: Fires when a new deal is created
- deal_won: Fires when a deal is marked as won
- deal_lost: Fires when a deal is marked as lost
- stage_change: Fires when a deal moves to a different pipeline stage
- invoice_paid: Fires when an invoice payment is received
- invoice_overdue: Fires when an invoice passes its due date
- form_submitted: Fires when someone submits a form on a landing page
- booking_created: Fires when someone books an appointment
- course_enrolled: Fires when someone enrolls in a course
- schedule: Runs on a recurring schedule (daily, weekly, etc.)

AVAILABLE ACTION TYPES:
- send_email: Send an automated email (supports {{firstName}}, {{email}} variables)
- send_sms: Send a text message
- add_tag: Add a tag to the contact
- remove_tag: Remove a tag from the contact
- move_to_stage: Change the contact's lifecycle stage
- create_task: Create a follow-up task with optional due date
- enroll_in_sequence: Add the contact to an email sequence
- webhook: Send data to an external URL

MULTI-STEP SUPPORT:
Automations can have multiple steps with delays between them. Example:
Step 1: Send welcome email
Step 2: Wait 3 days
Step 3: Send follow-up email
Step 4: Create a task to call

CONDITIONS:
Each automation can have conditions that must be true before it runs. Example:
- source equals "website"
- lifecycle_stage equals "customer"
- Only fire if a specific field has a specific value

USER'S CURRENT AUTOMATIONS:
${existingRulesContext}

${currentRuleContext}

GUIDELINES:
- Give specific, actionable advice
- Reference the exact trigger/action types by name
- If the user describes something complex, break it into steps
- If something isn't possible yet, say so honestly and suggest alternatives
- For troubleshooting, ask about: Is the automation active? Is the trigger type correct? Are conditions blocking it?
- Keep responses concise — 2-4 sentences for simple questions, more for complex setup guidance`

  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = []

  // Add conversation history
  if (history?.length) {
    for (const msg of history) {
      contents.push({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.content }],
      })
    }
  }

  // Add current user message
  contents.push({ role: 'user', parts: [{ text: message }] })

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${aiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents,
          generationConfig: { maxOutputTokens: 800 },
        }),
      },
    )
    const data = await res.json()
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || ''

    if (!text) {
      return NextResponse.json({ ok: false, error: 'No response from AI' }, { status: 500 })
    }

    return NextResponse.json({ ok: true, data: { message: text } })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed to get AI response' }, { status: 500 })
  }
}
