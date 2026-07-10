// ORM-SKIP: uses raw pg query() — conversion requires SQL rewrite
export const metadata = { path: '/ai/realtime/session', POST: { requireAuth: true } }
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { checkCustomersAiAllowance } from '@/lib/usage/allowance'
import { meterCustomersAi } from '@/lib/usage/meter'
import { query, queryOne } from '@/lib/db'
import { CRM_TOOLS } from '@/modules/customers/lib/crm-tool-catalog'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { TenantDataEncryptionService } from '@open-mercato/shared/lib/encryption/tenantDataEncryptionService'
import { isTenantDataEncryptionEnabled } from '@open-mercato/shared/lib/encryption/toggles'
import { createKmsService } from '@open-mercato/shared/lib/encryption/kms'

async function decryptContactRows(rows: any[], tenantId: string, orgId: string): Promise<any[]> {
  if (!rows.length || !isTenantDataEncryptionEnabled()) return rows
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const svc = new TenantDataEncryptionService(em as any, { kms: createKmsService() })
    return await Promise.all(rows.map(async (r) => {
      try {
        const dec = await svc.decryptEntityPayload('customers:customer_entity', { display_name: r.display_name, primary_email: r.primary_email }, tenantId, orgId)
        return { ...r, display_name: dec.display_name ?? r.display_name, primary_email: dec.primary_email ?? r.primary_email }
      } catch {
        return r
      }
    }))
  } catch {
    return rows
  }
}


export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  const userId = auth?.sub
  if (!auth?.tenantId || !auth?.orgId || !userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  // Cap gate — voice is the most expensive surface; block over-allowance orgs.
  // Realtime runs on OpenAI, so the BYOK fall-through must resolve the org's
  // OpenAI key (not the default Google).
  const gate = await checkCustomersAiAllowance(auth, 'openai')
  if (!gate.allowed) {
    return NextResponse.json({ ok: false, error: gate.message }, { status: 402 })
  }

  const apiKey = gate.byoApiKey || process.env.OPENAI_API_KEY
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: 'OpenAI API key not configured' }, { status: 500 })
  }

  try {
    const body = await req.json().catch(() => ({}))
    // Realtime API voices: alloy, ash, ballad, coral, echo, sage, shimmer, verse
    const validVoices = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse']
    const voice = validVoices.includes(body.voice) ? body.voice : 'alloy'

    // Optional page context — the client figures out what entity the user is
    // currently viewing (from URL or referrer) and passes it in so Scout can
    // default to it when the user says "add a note" without naming anyone.
    const pageContext = body.pageContext && typeof body.pageContext === 'object' ? body.pageContext : null
    const ctxEntityType = typeof pageContext?.entityType === 'string' ? pageContext.entityType : null
    const ctxEntityId = typeof pageContext?.entityId === 'string' ? pageContext.entityId : null
    const ctxEntityName = typeof pageContext?.entityName === 'string' ? pageContext.entityName : null
    const ctxPathname = typeof pageContext?.pathname === 'string' ? pageContext.pathname : null

    // Load persona
    const profile = await queryOne(
      'SELECT ai_persona_name, ai_persona_style, ai_custom_instructions, business_name, business_type, business_description FROM business_profiles WHERE organization_id = $1',
      [auth.orgId]
    )

    const personaName = profile?.ai_persona_name || 'Scout'
    const personaStyle = profile?.ai_persona_style || 'professional'

    // Build persona prompt
    const stylePrompts: Record<string, string> = {
      professional: `You are ${personaName}, a sharp and efficient business assistant. Be direct, data-driven, and proactive. Use professional language. Get to the point quickly.`,
      casual: `You are ${personaName}, a friendly and encouraging business partner. Be warm, conversational, and supportive. Feel like a helpful friend who's great at business.`,
      minimal: `You are ${personaName}. Be extremely concise. Only speak when valuable. No filler. Just substance.`,
    }

    let instructions = stylePrompts[personaStyle] || stylePrompts.professional
    if (profile?.business_name) instructions += `
Business: ${profile.business_name}`
    if (profile?.business_type) instructions += `
Type: ${profile.business_type}`
    if (profile?.business_description) instructions += `
Description: ${profile.business_description}`
    if (profile?.ai_custom_instructions) instructions += `
CUSTOM INSTRUCTIONS:
${profile.ai_custom_instructions}`

    instructions += `

You have 65 tools to FULLY control the CRM. You can CREATE, EDIT, DELETE, and MANAGE everything. NEVER say "I can't do that" — if the user asks you to edit, delete, or change something, USE THE APPROPRIATE TOOL.

CREATE: create_contact, create_task, add_note, add_tag, create_deal, send_email, move_deal_stage, create_invoice, create_product, create_reminder, enroll_in_sequence, send_sms, create_email_campaign, create_automation_rule, create_booking_page, create_event, create_survey, create_form, create_email_list, add_to_email_list

EDIT/DELETE/MANAGE (use "action" parameter: edit, delete, publish, etc.):
- manage_event_advanced — EDIT event duration/time/title, DELETE events, publish, cancel, email attendees. To change duration: pass action="edit" with eventId and duration (minutes).
- manage_deal — EDIT deal title/value/stage, close as won/lost, DELETE deals
- manage_task_advanced — EDIT tasks, mark complete, DELETE tasks
- manage_landing_page — EDIT page title, publish/unpublish, DELETE pages
- manage_contact_advanced — merge contacts, set lifecycle stage, view attachments
- manage_booking — confirm/cancel/delete bookings, edit/delete booking pages
- manage_calendar — view today/week schedule, block time off
- manage_invoice — send invoice, mark as paid, DELETE
- manage_product_advanced — EDIT product name/price, DELETE
- manage_campaign — EDIT campaign, send, test, DELETE
- manage_sequence_advanced — pause, activate, EDIT, DELETE sequences
- manage_email_list_advanced — EDIT lists, add/remove members, DELETE
- manage_funnel — publish/unpublish, DELETE, view analytics
- manage_survey_advanced — EDIT, toggle active, DELETE, view responses
- manage_form_advanced — EDIT, DELETE, view submissions
- manage_course_advanced — EDIT, publish, DELETE, generate AI outline
- manage_chat_widget — create, EDIT, DELETE, toggle active
- manage_automation_advanced — enable, disable, EDIT, DELETE, test
- update_settings — update business profile, pipeline config, AI persona, invite team
- Also: update_contact, delete_contact, search_contacts, get_engagement_score

QUERY: get_pipeline_summary, get_contact_details, get_today_tasks, get_upcoming_events, get_inbox_summary, get_revenue_summary, list_sequences, list_landing_pages, list_email_lists, list_products, list_recent_activity

COMPLEX (ask follow-up questions first): create_landing_page, create_funnel, create_course, create_email_sequence, generate_report, ai_draft_email

When editing/deleting, use the id= values from the CRM DATA section below. You can also pass item names and they'll be auto-resolved. Always confirm DELETE actions with the user first.`

    // Load user info and email connections
    const orgId = auth.orgId
    const tenantId = auth.tenantId

    const [currentUser, emailConnections, espConnection] = await Promise.all([
      queryOne('SELECT name, email FROM users WHERE id = $1', [userId]).catch(() => null),
      query('SELECT provider, email_address, is_primary FROM email_connections WHERE organization_id = $1 AND user_id = $2 AND is_active = true ORDER BY is_primary DESC', [orgId, userId]).catch(() => []),
      queryOne('SELECT provider, default_sender_name, default_sender_email FROM esp_connections WHERE organization_id = $1 AND is_active = true LIMIT 1', [orgId]).catch(() => null),
    ])

    const userName = currentUser?.name || 'User'
    const userEmail = currentUser?.email || ''

    // Load CRM data context
    const [contactCount, dealCount, taskCount, invoiceCount, sequences, emailLists, landingPages, forms, bookingPages] = await Promise.all([
      queryOne('SELECT count(*)::int as total FROM customer_entities WHERE organization_id = $1 AND deleted_at IS NULL AND kind = $2', [orgId, 'person']),
      queryOne('SELECT count(*)::int as total, count(*) filter (where status IS NULL or status NOT IN ($2,$3))::int as open_count, coalesce(sum(value_amount),0)::numeric as total_value FROM customer_deals WHERE organization_id = $1 AND deleted_at IS NULL', [orgId, 'win', 'lose']),
      queryOne('SELECT count(*) filter (where is_done = false)::int as open, count(*) filter (where is_done = true)::int as done FROM tasks WHERE organization_id = $1', [orgId]),
      queryOne('SELECT count(*)::int as total FROM invoices WHERE organization_id = $1', [orgId]),
      query('SELECT id, name, is_active FROM sequences WHERE organization_id = $1 LIMIT 10', [orgId]).catch(() => []),
      query('SELECT id, name, member_count FROM email_lists WHERE organization_id = $1 LIMIT 10', [orgId]).catch(() => []),
      query('SELECT id, title, status, slug, view_count, submission_count FROM landing_pages WHERE organization_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 10', [orgId]).catch(() => []),
      query('SELECT id, title, submission_count FROM forms WHERE organization_id = $1 LIMIT 10', [orgId]).catch(() => []),
      query('SELECT id, title, slug FROM booking_pages WHERE organization_id = $1 LIMIT 10', [orgId]).catch(() => []),
    ])

    const recentContactsRaw = await query(
      'SELECT id, display_name, primary_email, lifecycle_stage FROM customer_entities WHERE organization_id = $1 AND deleted_at IS NULL AND kind = $2 ORDER BY created_at DESC LIMIT 10',
      [orgId, 'person']
    )
    const recentContacts = await decryptContactRows(recentContactsRaw as any[], auth.tenantId, auth.orgId)

    const recentDeals = await query(
      'SELECT id, title, pipeline_stage, value_amount, status FROM customer_deals WHERE organization_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 10',
      [orgId]
    )

    const recentEvents = await query(
      'SELECT id, title, event_type, status, start_time, end_time FROM events WHERE organization_id = $1 AND deleted_at IS NULL ORDER BY start_time DESC LIMIT 10',
      [orgId]
    ).catch(() => [])

    const recentTasks = await query(
      'SELECT id, title, is_done, due_date FROM tasks WHERE organization_id = $1 AND is_done = false ORDER BY due_date ASC NULLS LAST LIMIT 10',
      [orgId]
    ).catch(() => [])

    let dataContext = `

CURRENT CRM DATA (use these IDs when editing/deleting items):
`
    dataContext += `CONTACTS: ${contactCount?.total || 0} people
`
    if (recentContacts.length > 0) {
      dataContext += `Recent contacts:
${recentContacts.map((c: any) => `  - "${c.display_name}" (${c.primary_email || 'no email'}) [${c.lifecycle_stage || 'prospect'}] id=${c.id}`).join('\n')}
`
    }
    dataContext += `PIPELINE: ${dealCount?.total || 0} deals (${dealCount?.open_count || 0} open), $${Number(dealCount?.total_value || 0).toLocaleString()} total value
`
    if (recentDeals.length > 0) {
      dataContext += `Recent deals:
${recentDeals.map((d: any) => `  - "${d.title}" — ${d.pipeline_stage || 'Unassigned'} ($${Number(d.value_amount || 0).toLocaleString()}) id=${d.id}`).join('\n')}
`
    }
    dataContext += `TASKS: ${taskCount?.open || 0} open, ${taskCount?.done || 0} completed
`
    if ((recentTasks as any[]).length > 0) {
      dataContext += `Open tasks:
${(recentTasks as any[]).map((t: any) => `  - "${t.title}" ${t.due_date ? `due ${new Date(t.due_date).toLocaleDateString()}` : '(no due date)'} id=${t.id}`).join('\n')}
`
    }
    if ((recentEvents as any[]).length > 0) {
      dataContext += `Events:
${(recentEvents as any[]).map((e: any) => `  - "${e.title}" (${e.event_type || 'event'}) ${e.start_time ? new Date(e.start_time).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short' }) : ''} [${e.status}] id=${e.id}`).join('\n')}
`
    }
    dataContext += `INVOICES: ${invoiceCount?.total || 0} total
`
    if ((sequences as any[]).length > 0) {
      dataContext += `SEQUENCES:
${(sequences as any[]).map((s: any) => `  - "${s.name}" (${s.is_active ? 'active' : 'paused'}) id=${s.id}`).join('\n')}
`
    }
    if ((emailLists as any[]).length > 0) {
      dataContext += `EMAIL LISTS:
${(emailLists as any[]).map((l: any) => `  - "${l.name}" (${l.member_count || 0} members) id=${l.id}`).join('\n')}
`
    }
    const baseUrl = process.env.APP_URL || 'http://localhost:3000'
    if ((landingPages as any[]).length > 0) {
      dataContext += `LANDING PAGES:
${(landingPages as any[]).map((p: any) => `  - "${p.title}" [${p.status}] ${p.view_count || 0} views, ${p.submission_count || 0} leads${p.slug ? ` — link: ${baseUrl}/p/${p.slug}` : ''} id=${p.id}`).join('\n')}
`
    }
    if ((forms as any[]).length > 0) {
      dataContext += `FORMS:
${(forms as any[]).map((f: any) => `  - "${f.title}" (${f.submission_count || 0} submissions) id=${f.id}`).join('\n')}
`
    }
    if ((bookingPages as any[]).length > 0) {
      dataContext += `BOOKING PAGES:
${(bookingPages as any[]).map((b: any) => `  - "${b.title}" — link: ${baseUrl}/book/${b.slug} id=${b.id}`).join('\n')}
`
    }

    instructions += dataContext

    // Add user identity context
    const now = new Date()
    instructions += `

USER IDENTITY:
Name: ${userName}
Email: ${userEmail}
Timezone: America/Los_Angeles (Pacific Time)
Current date/time: ${now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'full', timeStyle: 'short' })}
ISO now: ${now.toISOString()}
`

    // Add email provider context
    const connectedProviders = (emailConnections as any[])
    if (connectedProviders.length > 0) {
      instructions += `
EMAIL PROVIDERS CONNECTED:
`
      connectedProviders.forEach((c: any) => {
        instructions += `- ${c.provider.toUpperCase()}: ${c.email_address}${c.is_primary ? ' (primary)' : ''}
`
      })
      instructions += `Emails will be sent from the primary connected provider automatically. You do NOT need to ask which provider to use.
`
    } else {
      instructions += `
NO EMAIL PROVIDER CONNECTED. `
    }
    if (espConnection) {
      instructions += `ESP backup: ${espConnection.provider} (${espConnection.default_sender_email || 'configured'})
`
    }
    if (!connectedProviders.length && !espConnection) {
      instructions += `The user has no email providers connected. Emails will go to console only. Suggest they connect Gmail or Outlook in Settings.
`
    }

    instructions += `

IMPORTANT — USING IDs:
When editing, deleting, or managing existing items, you MUST pass the item's ID (the id= value from the CRM data above). The system can also look up items by name, but using the ID is faster and more reliable. When the user says "delete that event" or "edit the networking event", find the matching item in the CRM data above and use its id= value.

BEHAVIOR GUIDELINES:
- You are a voice assistant. Keep responses concise and conversational — you're speaking out loud, not writing an essay.
- When sending emails, the sender name "${userName}" and email address are set automatically. Do NOT use placeholders.
- NEVER use placeholder URLs like "https://yourwebsite.com/..." or "[link]" in emails. ALWAYS use REAL URLs from the CRM data above. For booking pages, use the exact booking link shown in the BOOKING PAGES section. For landing pages, use the exact link shown in LANDING PAGES. If you don't have a real URL, tell the user you need to create the page first before sending a link.
- When sending an email that includes a booking link, look up the booking page URL from the BOOKING PAGES data above and use it verbatim. Example: if the data says 'link: ${baseUrl}/book/discovery-call-123', put exactly that URL in the email.
- For COMPLEX WORKFLOWS (landing pages, courses, funnels, sequences): ask follow-up questions FIRST to gather all needed information, then call the tool. Don't assume details.
- For SIMPLE ACTIONS (create contact, send email, create task): execute immediately with the info given. Ask only if critical info is missing (e.g., no email address for send_email).
- You CAN create booking pages with real links. Use the create_booking_page tool. After creation, the tool returns the actual booking URL — share it with the user. Existing booking page links are listed in the BOOKING PAGES section above.
- Always confirm before taking DESTRUCTIVE actions (delete, send to many contacts).
- If a tool call fails, report the error honestly. Do NOT retry automatically — tell the user what went wrong.
- When the user asks about Google Meet links: you cannot create Google Meet links directly. Suggest they create the meeting in Google Calendar and share the link.

${ctxEntityType && ctxEntityId ? `CURRENT CONTEXT:
The user is viewing a ${ctxEntityType}${ctxEntityName ? ` named "${ctxEntityName}"` : ''} (id: ${ctxEntityId}). When they make ambiguous references like "add a note", "create a task", "send them an email", or "update their info" without naming a target, default to THIS entity. Do NOT ask them to clarify who they mean if it's obvious from context. Only find_entity or re-prompt if they clearly reference a different item.
` : ''}${ctxPathname && !ctxEntityId ? `CURRENT CONTEXT:
The user is on page "${ctxPathname}". Use this as a hint for which area they're working in.
` : ''}
NAME RESOLUTION (CRITICAL):
- Before editing, deleting, or managing any item the user references by name ("delete the Acme deal", "edit Maria's phone number", "unpublish the pricing page"), call find_entity FIRST to resolve the ID.
- find_entity returns zero, one, or multiple candidates. If zero — tell the user you couldn't find it. If one — use its id in the next tool call. If multiple — briefly list them and ask which one.
- Do NOT guess an ID from the CRM data block above unless you are 100% sure the item is listed there and the user named it unambiguously. When in doubt, find_entity first.
- find_entity is NOT needed for create actions or read-only queries.

TOOL CALL DISCIPLINE (CRITICAL — read carefully):
- Any action that MODIFIES the CRM (create, update, delete, send, enroll, publish, assign, move, schedule) requires a function_call. NEVER describe such an action as completed without emitting its function_call first.
- For MULTI-STEP requests ("add Maria as a contact then create a deal for her"), emit each function_call SEPARATELY and IN ORDER. After you receive a function_call_output, check what remains and emit the NEXT function_call BEFORE you speak.
- Narrate in the present tense BEFORE each tool call ("Adding Maria now...", "Now creating the deal..."). Do NOT summarize actions in past tense unless you have actually emitted tool calls for every action you mention.
- If the user asks for N actions, you must emit N function_calls. Saying "I added X and created Y and sent Z" while only calling one tool is a serious error.
- If a tool call fails mid-chain, STOP the chain, tell the user what failed, and wait for instructions. Do not skip ahead or pretend later steps succeeded.
- Read-only queries (summaries, reports, searches) do NOT each need a function_call — speak naturally about retrieved data. This rule applies only to state-changing actions.`

    // Create ephemeral client secret with OpenAI GA endpoint
    const sessionRes = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    })

    if (!sessionRes.ok) {
      const err = await sessionRes.text().catch(() => '')
      console.error('[realtime.session] OpenAI error:', sessionRes.status, err)
      return NextResponse.json({ ok: false, error: 'Failed to create realtime session' }, { status: 500 })
    }

    const sessionData = await sessionRes.json()

    // Voice sessions don't expose token counts at mint time; charge a flat
    // per-session estimate toward the cap so voice isn't free. Billed at the
    // audio-weighted realtime rate (see PRICING) — precise metering would need
    // the client to report usage post-session.
    void meterCustomersAi(auth, {
      model: 'gpt-4o-realtime-preview-2024-12-17',
      tokensIn: 3000,
      tokensOut: 3000,
      feature: 'realtime-voice',
      byoKey: !!gate.byoApiKey,
    })

    // Return the ephemeral key + session config (client will send session.update after connecting)
    return NextResponse.json({
      ok: true,
      data: {
        clientSecret: sessionData.value,
        model: 'gpt-4o-realtime-preview-2024-12-17',
        voice,
        personaName,
        // Session config to be sent via session.update after WebSocket connects
        sessionConfig: {
          type: 'realtime',
          instructions,
          tools: CRM_TOOLS,
          tool_choice: 'auto',
          audio: {
            input: {
              transcription: { model: 'gpt-4o-mini-transcribe' },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 500,
                create_response: true,
                interrupt_response: true,
              },
            },
            output: {
              voice,
            },
          },
        },
      },
    })
  } catch (error) {
    console.error('[realtime.session]', error)
    return NextResponse.json({ ok: false, error: 'Failed to create session' }, { status: 500 })
  }
}
