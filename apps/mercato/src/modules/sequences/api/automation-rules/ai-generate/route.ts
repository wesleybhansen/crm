export const metadata = { POST: { requireAuth: true } }
export const openApi = { summary: 'ai-generate', methods: {} }
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'

const VALID_TRIGGERS = ['contact_created', 'tag_added', 'tag_removed', 'form_submitted', 'invoice_paid', 'booking_created', 'deal_won', 'deal_lost', 'course_enrolled', 'stage_change']
const VALID_ACTIONS = ['send_email', 'send_sms', 'add_tag', 'remove_tag', 'move_to_stage', 'create_task', 'add_to_list', 'enroll_in_sequence', 'webhook']

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const aiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY
  if (!aiKey) {
    return NextResponse.json({ ok: false, error: 'AI not configured' }, { status: 500 })
  }

  const { prompt } = await req.json()
  if (!prompt?.trim()) {
    return NextResponse.json({ ok: false, error: 'Prompt required' }, { status: 400 })
  }

  const systemPrompt = `You are an expert marketing automation builder for a CRM used by solopreneurs and small businesses. Given a user's plain-English description, generate a complete automation rule as JSON.

IMPORTANT RULES:
- Respond with ONLY valid JSON. No markdown, no backticks, no explanation.
- Write professional, warm, conversion-focused email copy. Not generic filler.
- Email subjects should be attention-grabbing and personal (use {{firstName}} for personalization).
- Email HTML should be well-formatted with proper paragraphs, a friendly tone, and a clear call-to-action where appropriate.
- Use realistic delays (not arbitrary numbers).

Available trigger types: ${VALID_TRIGGERS.join(', ')}
Available action types: ${VALID_ACTIONS.join(', ')}

JSON format:
{
  "name": "Short descriptive name for this automation",
  "description": "One sentence explaining what this does and why",
  "triggerType": "one of the trigger types",
  "triggerConfig": {},
  "steps": [
    { "type": "action", "actionType": "send_email", "actionConfig": { "subject": "...", "bodyHtml": "<div>...</div>" } },
    { "type": "delay", "delayMinutes": 4320 },
    { "type": "action", "actionType": "create_task", "actionConfig": { "title": "...", "dueDays": 3 } }
  ],
  "conditions": []
}

Step types:
- "action" with actionType and actionConfig
- "delay" with delayMinutes (60=1hr, 1440=1day, 4320=3days, 10080=1week)

Action configs:
- send_email: { "subject": "...", "bodyHtml": "<div style='font-family:sans-serif;max-width:520px;margin:0 auto'>...</div>" }
  Write emails that sound human, not robotic. Use {{firstName}} for the recipient's name. Include proper HTML with inline styles.
- create_task: { "title": "...", "dueDays": number }
- add_tag / remove_tag: { "tagName": "..." }
- move_to_stage: { "stage": "..." }
- webhook: { "url": "https://example.com/webhook", "method": "POST" }
- send_sms: { "message": "..." }
- enroll_in_sequence: { "sequenceName": "..." }

Trigger configs:
- contact_created: {} or { "source": "filter" }
- tag_added / tag_removed: { "tagSlug": "tag-name" }
- form_submitted: {} or { "formId": "id" }
- deal_won / deal_lost: {}
- stage_change: { "toStage": "stage name" }
- invoice_paid / booking_created / course_enrolled: {}

Conditions (optional, only if user mentions filtering):
{ "field": "source|lifecycle_stage", "operator": "equals|contains|is_set", "value": "..." }

Example email for a welcome automation:
{
  "subject": "Welcome aboard, {{firstName}}!",
  "bodyHtml": "<div style='font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:24px'><h2 style='font-size:20px;margin:0 0 12px'>Hey {{firstName}}, welcome!</h2><p style='color:#475569;font-size:15px;line-height:1.6;margin-bottom:16px'>Thanks for connecting with us. We're excited to have you here.</p><p style='color:#475569;font-size:15px;line-height:1.6;margin-bottom:20px'>If you have any questions at all, just hit reply — I read every email personally.</p><p style='color:#475569;font-size:15px;line-height:1.6'>Talk soon!</p></div>"
}

User request: ${prompt}`

  // Try up to 2 times (retry once on JSON parse failure)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${aiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: systemPrompt }] }],
            generationConfig: { maxOutputTokens: 2000, temperature: 0.7 },
          }),
        },
      )

      if (!res.ok) {
        if (attempt === 0) continue
        return NextResponse.json({ ok: false, error: 'AI service error' }, { status: 502 })
      }

      const data = await res.json()
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || ''

      if (!text.trim()) {
        if (attempt === 0) continue
        return NextResponse.json({ ok: false, error: 'AI returned empty response' }, { status: 500 })
      }

      // Clean and parse JSON
      const jsonStr = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
      let result: any
      try {
        result = JSON.parse(jsonStr)
      } catch {
        if (attempt === 0) continue
        return NextResponse.json({ ok: false, error: 'AI returned invalid format. Try rephrasing your request.' }, { status: 422 })
      }

      // Validate required fields
      if (!result.name || !result.triggerType) {
        if (attempt === 0) continue
        return NextResponse.json({ ok: false, error: 'AI response missing required fields. Try again.' }, { status: 422 })
      }

      // Validate trigger type
      if (!VALID_TRIGGERS.includes(result.triggerType)) {
        result.triggerType = 'contact_created'
      }

      // Validate steps
      if (Array.isArray(result.steps)) {
        result.steps = result.steps.filter((s: any) => {
          if (s.type === 'delay') return typeof s.delayMinutes === 'number' && s.delayMinutes > 0
          if (s.type === 'action') return VALID_ACTIONS.includes(s.actionType)
          return false
        })
      }

      // Ensure at least one step
      if (!result.steps?.length) {
        result.steps = [{
          type: 'action',
          actionType: result.actionType || 'send_email',
          actionConfig: result.actionConfig || { subject: 'Automated email', bodyHtml: '<p>Hello {{firstName}},</p>' },
        }]
      }

      return NextResponse.json({ ok: true, data: result })
    } catch {
      if (attempt === 0) continue
      return NextResponse.json({ ok: false, error: 'Failed to generate automation' }, { status: 500 })
    }
  }

  return NextResponse.json({ ok: false, error: 'Failed after retries' }, { status: 500 })
}
