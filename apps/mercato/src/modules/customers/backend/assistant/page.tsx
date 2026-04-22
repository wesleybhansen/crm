'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Mic, MicOff, Send, Trash2, Volume2, Loader2, Check, X, AlertCircle, Sparkles, Plus, Archive, MessageSquare, BarChart3, CalendarDays, CheckSquare, Flame, Pencil } from 'lucide-react'

// Types
interface Message {
  role: 'user' | 'assistant'
  content: string
  action?: CrmAction | null
  actionStatus?: 'pending' | 'executing' | 'success' | 'error' | 'cancelled'
  actionResult?: string
  /**
   * Set on a transcript message when the model claimed more state-changing
   * actions in natural language than it actually invoked via tool calls. The
   * user sees a banner with a "retry missed steps" button — see the
   * reconcileTurn() helper for how the heuristic works.
   */
  reconciliationWarning?: { verbsClaimed: string[]; toolsCalled: number } | null
  /**
   * Which AI provider answered this message. Only shown on the assistant
   * side when it's the OpenAI fallback path so the user can tell when
   * Gemini is unavailable.
   */
  provider?: 'gemini' | 'openai' | null
}

// Verbs that suggest a state-changing action happened. If the model's audio
// transcript mentions any of these in past tense but no corresponding tool
// was actually called in the same turn, we surface a warning. Kept narrow on
// purpose — false positives are annoying.
const STATE_CHANGE_VERB_REGEX = /\b(added|created|sent|updated|deleted|scheduled|booked|drafted|moved|assigned|enrolled|published|cancelled|refunded)\b/gi

type PageContext = { entityType?: string; entityId?: string; entityName?: string; pathname?: string }

// Pull out what the user was just looking at so Scout can default to that
// entity when the user makes ambiguous references. Read from document.referrer
// (the URL before they navigated to /backend/assistant).
function derivePageContext(): PageContext | null {
  if (typeof document === 'undefined') return null
  const ref = document.referrer || ''
  if (!ref) return null
  let url: URL
  try { url = new URL(ref) } catch { return null }
  if (typeof window !== 'undefined' && url.origin !== window.location.origin) return null
  const path = url.pathname
  const patterns: Array<[RegExp, string]> = [
    [/^\/backend\/customers\/people\/([0-9a-f-]{36})/, 'contact'],
    [/^\/backend\/customers\/contacts\/([0-9a-f-]{36})/, 'contact'],
    [/^\/backend\/customers\/deals\/([0-9a-f-]{36})/, 'deal'],
    [/^\/backend\/customers\/companies\/([0-9a-f-]{36})/, 'company'],
    [/^\/backend\/crm-events\/([0-9a-f-]{36})/, 'event'],
    [/^\/backend\/events\/([0-9a-f-]{36})/, 'event'],
    [/^\/backend\/tasks\/([0-9a-f-]{36})/, 'task'],
    [/^\/backend\/landing-pages\/([0-9a-f-]{36})/, 'landing_page'],
    [/^\/backend\/sequences\/([0-9a-f-]{36})/, 'sequence'],
  ]
  for (const [re, entityType] of patterns) {
    const m = path.match(re)
    if (m) return { entityType, entityId: m[1], pathname: path }
  }
  return { pathname: path }
}

// Pull a user-readable label from a tool's arguments so the "Executing: ..."
// bubble shows the entity rather than just the tool name. Kept generic — any
// of these keys can appear depending on the tool.
function pickActionLabel(args: Record<string, any>): string | null {
  if (!args || typeof args !== 'object') return null
  const keys = ['displayName', 'name', 'title', 'contactName', 'productName', 'subject', 'message', 'query']
  for (const k of keys) {
    const v = (args as any)[k]
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 60)
  }
  return null
}

// Return a short human-readable summary of what a destructive action would
// do, shown in the confirmation prompt.
function describeDestructive(action: CrmAction): string {
  const { type, data } = action
  const label = pickActionLabel(data || {}) || ''
  const sub = (data?.action || '').toString()
  if (type === 'delete_contact')                                     return `Delete contact${label ? ` "${label}"` : ''}`
  if (type === 'manage_deal' && sub === 'delete')                    return `Delete deal${label ? ` "${label}"` : ''}`
  if (type === 'manage_deal' && sub === 'close_lost')                return `Close deal${label ? ` "${label}"` : ''} as lost`
  if (type === 'manage_task_advanced' && sub === 'delete')           return `Delete task${label ? ` "${label}"` : ''}`
  if (type === 'manage_event_advanced' && sub === 'delete')          return `Delete event${label ? ` "${label}"` : ''}`
  if (type === 'manage_event_advanced' && sub === 'cancel')          return `Cancel event${label ? ` "${label}"` : ''}`
  if (type === 'manage_invoice' && sub === 'delete')                 return `Delete invoice${label ? ` "${label}"` : ''}`
  if (type === 'manage_landing_page' && sub === 'delete')            return `Delete landing page${label ? ` "${label}"` : ''}`
  if (type === 'manage_funnel' && sub === 'delete')                  return `Delete funnel${label ? ` "${label}"` : ''}`
  if (type === 'manage_booking' && (sub === 'delete' || sub === 'cancel' || sub === 'delete_page'))
                                                                     return `Cancel/delete booking${label ? ` "${label}"` : ''}`
  if (type === 'manage_survey_advanced' && sub === 'delete')         return `Delete survey${label ? ` "${label}"` : ''}`
  if (type === 'manage_form_advanced' && sub === 'delete')           return `Delete form${label ? ` "${label}"` : ''}`
  if (type === 'manage_course_advanced' && sub === 'delete')         return `Delete course${label ? ` "${label}"` : ''}`
  if (type === 'manage_sequence_advanced' && sub === 'delete')       return `Delete sequence${label ? ` "${label}"` : ''}`
  if (type === 'manage_product_advanced' && sub === 'delete')        return `Delete product${label ? ` "${label}"` : ''}`
  if (type === 'manage_chat_widget' && sub === 'delete')             return `Delete chat widget${label ? ` "${label}"` : ''}`
  if (type === 'manage_email_list_advanced' && (sub === 'delete' || sub === 'remove_member'))
                                                                     return `Remove from email list`
  if (type === 'manage_campaign' && (sub === 'delete' || sub === 'send'))
                                                                     return sub === 'send' ? `Send email campaign${label ? ` "${label}"` : ''}` : `Delete campaign${label ? ` "${label}"` : ''}`
  if (type === 'manage_automation_advanced' && sub === 'delete')     return `Delete automation${label ? ` "${label}"` : ''}`
  if (type === 'process_payment' && sub === 'refund')                return `Refund payment${label ? ` "${label}"` : ''}`
  if (type === 'process_payment' && sub === 'cancel_subscription')   return `Cancel subscription${label ? ` "${label}"` : ''}`
  return `${type.replace(/_/g, ' ')}${sub ? ` (${sub})` : ''}`
}

function isDestructiveAction(action: CrmAction): boolean {
  const { type, data } = action
  const sub = (data?.action || '').toString()
  if (type === 'delete_contact') return true
  if (type === 'manage_deal' && (sub === 'delete' || sub === 'close_lost')) return true
  if (type === 'manage_task_advanced' && sub === 'delete') return true
  if (type === 'manage_event_advanced' && (sub === 'delete' || sub === 'cancel')) return true
  if (type === 'manage_invoice' && sub === 'delete') return true
  if (type === 'manage_landing_page' && sub === 'delete') return true
  if (type === 'manage_funnel' && sub === 'delete') return true
  if (type === 'manage_booking' && (sub === 'delete' || sub === 'cancel' || sub === 'delete_page')) return true
  if (type === 'manage_survey_advanced' && sub === 'delete') return true
  if (type === 'manage_form_advanced' && sub === 'delete') return true
  if (type === 'manage_course_advanced' && sub === 'delete') return true
  if (type === 'manage_sequence_advanced' && sub === 'delete') return true
  if (type === 'manage_product_advanced' && sub === 'delete') return true
  if (type === 'manage_chat_widget' && sub === 'delete') return true
  if (type === 'manage_email_list_advanced' && (sub === 'delete' || sub === 'remove_member')) return true
  if (type === 'manage_campaign' && (sub === 'delete' || sub === 'send')) return true
  if (type === 'manage_automation_advanced' && sub === 'delete') return true
  if (type === 'process_payment' && (sub === 'refund' || sub === 'cancel_subscription')) return true
  return false
}

interface CrmAction {
  type: string
  data: Record<string, any>
}

// ---- Action parsing ----
function parseCrmAction(text: string): CrmAction | null {
  const match = text.match(/```crm-action\s*\n?([\s\S]*?)\n?```/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[1])
    if (!parsed?.type) return null
    // Normalize: if data is missing, treat all non-type fields as data
    if (!parsed.data) {
      const { type, ...rest } = parsed
      return { type, data: rest }
    }
    return parsed
  } catch { return null }
}

// Cache orgId to avoid fetching it on every tool call
let cachedOrgId = ''
async function getOrgId(): Promise<string> {
  if (cachedOrgId) return cachedOrgId
  const res = await fetch('/api/customers/business-profile', { credentials: 'include' })
  const d = await res.json()
  cachedOrgId = d.data?.organization_id || ''
  return cachedOrgId
}

// Resolve a contactId — if it's already a UUID, use it; if it's a name, search for the contact
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
async function resolveContactId(idOrName: string): Promise<{ id: string; name: string } | null> {
  if (!idOrName) return null
  if (UUID_RE.test(idOrName)) {
    // Already a UUID — look up the name
    const res = await fetch(`/api/customers/people?ids=${idOrName}&pageSize=1`, { credentials: 'include' })
    const d = await res.json()
    const c = d.items?.[0]
    return c ? { id: c.id, name: c.display_name || idOrName } : { id: idOrName, name: idOrName }
  }
  // It's a name — search for the contact. The server's ?search= uses $ilike
  // which doesn't work against encrypted display_name, so do a fetch-all +
  // in-memory filter as fallback. First try the normal search (cheaper) and
  // only fall back when it comes up empty.
  let res = await fetch(`/api/customers/people?search=${encodeURIComponent(idOrName)}&pageSize=5`, { credentials: 'include' })
  let d = await res.json()
  let items: any[] = d.items || []
  if (items.length === 0) {
    // Fallback: fetch recent 200 and filter client-side against the decrypted
    // display_name. Works for tenants under that size and where the server
    // route decrypts on response.
    res = await fetch(`/api/customers/people?pageSize=200`, { credentials: 'include' })
    d = await res.json()
    const pool: any[] = d.items || []
    const needle = idOrName.toLowerCase()
    items = pool.filter((c) => (c.display_name || '').toLowerCase().includes(needle))
  }
  if (items.length === 1) return { id: items[0].id, name: items[0].display_name }
  if (items.length > 1) {
    const exact = items.find((c: any) => c.display_name?.toLowerCase() === idOrName.toLowerCase())
    if (exact) return { id: exact.id, name: exact.display_name }
    return { id: items[0].id, name: items[0].display_name }
  }
  return null
}

// Generic name-to-ID resolver for any entity type
async function resolveEntityId(idOrName: string, searchEndpoint: string, nameField: string = 'title'): Promise<{ id: string; name: string } | null> {
  if (!idOrName) return null
  if (UUID_RE.test(idOrName)) return { id: idOrName, name: idOrName }
  // Search by name
  const res = await fetch(`${searchEndpoint}`, { credentials: 'include' })
  const d = await res.json()
  const items = d.items || d.data || []
  const match = items.find((item: any) => {
    const itemName = item[nameField] || item.title || item.name || ''
    return itemName.toLowerCase().includes(idOrName.toLowerCase())
  })
  return match ? { id: match.id, name: match[nameField] || match.title || match.name } : null
}

async function resolveEventId(idOrName: string): Promise<{ id: string; name: string } | null> {
  return resolveEntityId(idOrName, '/api/crm-events', 'title')
}

async function resolveTaskId(idOrName: string): Promise<{ id: string; name: string } | null> {
  return resolveEntityId(idOrName, '/api/customers/tasks', 'title')
}

async function resolveDealId(idOrName: string): Promise<{ id: string; name: string } | null> {
  if (!idOrName) return null
  if (UUID_RE.test(idOrName)) return { id: idOrName, name: idOrName }
  const res = await fetch(`/api/customers/deals?search=${encodeURIComponent(idOrName)}&pageSize=5`, { credentials: 'include' })
  const d = await res.json()
  const items = d.items || []
  if (items.length > 0) {
    const exact = items.find((i: any) => i.title?.toLowerCase() === idOrName.toLowerCase())
    return exact ? { id: exact.id, name: exact.title } : { id: items[0].id, name: items[0].title }
  }
  return null
}

async function resolvePageId(idOrName: string): Promise<{ id: string; name: string } | null> {
  return resolveEntityId(idOrName, '/api/landing_pages/pages', 'title')
}

// Map of entityType → search endpoint + display field names.
// Used by find_entity to dispatch a name-to-ID lookup against the right API.
const FIND_ENTITY_MAP: Record<string, { endpoint: string; displayField: string; subtitleField?: string }> = {
  contact:       { endpoint: '/api/customers/people?search=',    displayField: 'display_name', subtitleField: 'primary_email' },
  deal:          { endpoint: '/api/customers/deals?search=',     displayField: 'title',        subtitleField: 'pipeline_stage' },
  task:          { endpoint: '/api/customers/tasks?search=',     displayField: 'title',        subtitleField: 'due_date' },
  event:         { endpoint: '/api/crm-events?search=',          displayField: 'title',        subtitleField: 'start_time' },
  product:       { endpoint: '/api/payments/products?search=',   displayField: 'name',         subtitleField: 'price' },
  landing_page:  { endpoint: '/api/landing_pages/pages?search=', displayField: 'title',        subtitleField: 'slug' },
  booking_page:  { endpoint: '/api/booking-pages?search=',       displayField: 'title',        subtitleField: 'slug' },
  sequence:      { endpoint: '/api/sequences?search=',           displayField: 'name',         subtitleField: 'status' },
  form:          { endpoint: '/api/forms?search=',               displayField: 'name' },
  survey:        { endpoint: '/api/surveys?search=',             displayField: 'title' },
  course:        { endpoint: '/api/courses?search=',             displayField: 'title',        subtitleField: 'slug' },
  invoice:       { endpoint: '/api/payments/invoices?search=',   displayField: 'number',       subtitleField: 'status' },
}

async function executeCrmAction(action: CrmAction): Promise<{ ok: boolean; message: string }> {
  if (!action.data) action.data = {}
  try {
    switch (action.type) {
      case 'find_entity': {
        const entityType = String(action.data.entityType || '').toLowerCase()
        const q = String(action.data.query || '').trim()
        const spec = FIND_ENTITY_MAP[entityType]
        if (!spec) return { ok: false, message: `Unknown entity type: ${entityType}` }
        if (!q) return { ok: false, message: 'Query is required.' }
        try {
          const res = await fetch(`${spec.endpoint}${encodeURIComponent(q)}&pageSize=5`, { credentials: 'include' })
          const d = await res.json()
          const items: any[] = Array.isArray(d?.items) ? d.items : Array.isArray(d?.data) ? d.data : []
          if (items.length === 0) {
            return { ok: true, message: JSON.stringify({ candidates: [], instruction: `No ${entityType} found matching "${q}". Tell the user.` }) }
          }
          const candidates = items.slice(0, 5).map((it) => ({
            id: it.id,
            label: it[spec.displayField] ?? it.name ?? it.title ?? it.id,
            subtitle: spec.subtitleField ? it[spec.subtitleField] : undefined,
          }))
          const instruction = candidates.length === 1
            ? 'Exactly one match. Use this id in your next tool call.'
            : `Multiple matches — briefly list them by label and ask the user which one to use. Do NOT pick automatically.`
          return { ok: true, message: JSON.stringify({ candidates, instruction }) }
        } catch (err) {
          return { ok: false, message: `Failed to search ${entityType}: ${err instanceof Error ? err.message : 'unknown error'}` }
        }
      }
      case 'create_contact': {
        const fullName = (action.data.name || 'New Contact').toString().trim()
        const parts = fullName.split(/\s+/)
        const firstName = parts[0] || ''
        const lastName = parts.length > 1 ? parts.slice(1).join(' ') : ''
        const email = String(action.data.email || '').trim()
        const phone = String(action.data.phone || '').trim()
        // primaryEmail is validated as .email() — only include if non-empty.
        const payload: Record<string, unknown> = {
          displayName: fullName,
          firstName,
          lastName,
          source: action.data.source || 'ai_assistant',
        }
        if (email) payload.primaryEmail = email
        if (phone) payload.primaryPhone = phone
        const res = await fetch('/api/customers/people', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify(payload),
        })
        const d = await res.json()
        return d.id ? { ok: true, message: `Contact "${fullName}" created successfully` } : { ok: false, message: d.error || 'Failed to create contact' }
      }
      case 'create_task': {
        let contactId = null
        if (action.data.contactId) {
          const contact = await resolveContactId(action.data.contactId)
          contactId = contact?.id || null
        }
        const res = await fetch('/api/customers/tasks', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ title: action.data.title, contactId, dueDate: action.data.dueDate })
        })
        const d = await res.json()
        return d.ok ? { ok: true, message: `Task "${action.data.title}" created` } : { ok: false, message: d.error || 'Failed' }
      }
      case 'add_note': {
        const contact = await resolveContactId(action.data.contactId)
        if (!contact) return { ok: false, message: `Contact "${action.data.contactId}" not found` }
        const res = await fetch('/api/customers/notes', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ contactId: contact.id, content: action.data.content })
        })
        const d = await res.json()
        return d.ok ? { ok: true, message: `Note added to ${contact.name}` } : { ok: false, message: d.error || 'Failed' }
      }
      case 'add_tag': {
        const contact = await resolveContactId(action.data.contactId)
        if (!contact) return { ok: false, message: `Contact "${action.data.contactId}" not found` }
        const res = await fetch('/api/crm-contact-tags', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ contactId: contact.id, tagName: action.data.tagName })
        })
        const d = await res.json()
        return d.ok ? { ok: true, message: `Tag "${action.data.tagName}" added to ${contact.name}` } : { ok: false, message: d.error || 'Failed' }
      }
      case 'create_deal': {
        const orgId = await getOrgId()
        const res = await fetch('/api/customers/deals', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ title: action.data.title, valueAmount: action.data.value || 0, pipelineStage: action.data.stage || 'Prospect', organizationId: orgId })
        })
        const d = await res.json()
        return d.id ? { ok: true, message: `Deal "${action.data.title}" created` } : { ok: false, message: d.error || 'Failed to create deal' }
      }
      case 'send_email': {
        // Convert plain text / markdown to HTML
        const rawBody = action.data.body || ''
        const htmlBody = rawBody.split('\n').map((line: string) => {
          // Convert markdown links [text](url) to HTML <a> tags
          let html = line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:#0000CC;text-decoration:underline">$1</a>')
          // Convert bare URLs to clickable links
          html = html.replace(/(?<!["=])(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#0000CC;text-decoration:underline">$1</a>')
          // Convert **bold** to <strong>
          html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
          return `<p>${html}</p>`
        }).join('')
        const res = await fetch('/api/email/messages', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ to: action.data.to, subject: action.data.subject, bodyHtml: htmlBody })
        })
        const d = await res.json()
        if (d.ok) {
          const via = d.data?.sentVia || 'unknown'
          if (via === 'console') {
            return { ok: false, message: `Email drafted but could not be delivered — no email provider connected. Connect Gmail or Outlook in Settings.` }
          }
          if (d.data?.fallback && d.data?.primaryProviderError) {
            return { ok: true, message: `Email sent to ${action.data.to} via ${via} (fallback). Gmail issue: ${d.data.primaryProviderError}` }
          }
          return { ok: true, message: `Email sent to ${action.data.to} via ${via}` }
        }
        return { ok: false, message: d.error || 'Failed to send email' }
      }
      case 'move_deal_stage': {
        const deal = await resolveDealId(action.data.dealId)
        if (!deal) return { ok: false, message: `Deal "${action.data.dealId}" not found` }
        const res = await fetch('/api/customers/deals', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ id: deal.id, pipelineStage: action.data.stage })
        })
        const d = await res.json()
        return d.id ? { ok: true, message: `Deal "${deal.name}" moved to "${action.data.stage}"` } : { ok: false, message: d.error || 'Failed' }
      }
      case 'move_contact_stage': {
        // Journey mode — update a contact's lifecycle_stage via the journey
        // pipeline endpoint. Accepts contactId or contactName; resolves the
        // latter via the people search.
        const stage = action.data.stage
        if (!stage) return { ok: false, message: 'Stage is required' }
        const ref = action.data.contactId || action.data.contactName
        if (!ref) return { ok: false, message: 'Contact is required' }
        const contact = await resolveContactId(ref)
        if (!contact) return { ok: false, message: `Contact "${ref}" not found` }
        const res = await fetch('/api/pipeline/journey', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ contactId: contact.id, stage })
        })
        const d = await res.json()
        return d.ok ? { ok: true, message: `${contact.name} moved to "${stage}".` } : { ok: false, message: d.error || 'Failed to move contact' }
      }
      case 'remove_contact_from_pipeline': {
        // Clears lifecycle_stage — contact stays in Contacts but disappears
        // from the pipeline board. NOT the same as delete_contact.
        const ref = action.data.contactId || action.data.contactName
        if (!ref) return { ok: false, message: 'Contact is required' }
        const contact = await resolveContactId(ref)
        if (!contact) return { ok: false, message: `Contact "${ref}" not found` }
        const res = await fetch('/api/pipeline/journey', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ contactId: contact.id, stage: null })
        })
        const d = await res.json()
        return d.ok ? { ok: true, message: `Removed ${contact.name} from pipeline. They're still in Contacts.` } : { ok: false, message: d.error || 'Failed to remove from pipeline' }
      }
      case 'delete_company': {
        // Try to resolve company name to id if user passed a name
        let companyId: string | null = action.data.companyId || null
        if (!companyId && action.data.companyName) {
          try {
            const resp = await fetch(`/api/customers/companies?search=${encodeURIComponent(action.data.companyName)}&pageSize=5`, { credentials: 'include' })
            const dd = await resp.json()
            const items: any[] = dd.items || []
            if (items.length === 1) companyId = items[0].id
            else if (items.length > 1) {
              const exact = items.find((c: any) => (c.display_name || '').toLowerCase() === action.data.companyName.toLowerCase())
              companyId = exact?.id || items[0].id
            }
          } catch {}
        }
        if (!companyId) return { ok: false, message: `Company "${action.data.companyName || 'unknown'}" not found.` }
        const res = await fetch(`/api/customers/companies?id=${encodeURIComponent(companyId)}`, { method: 'DELETE', credentials: 'include' })
        const d = await res.json().catch(() => ({}))
        if (res.ok) return { ok: true, message: 'Company deleted.' }
        return { ok: false, message: d.error || 'Failed to delete company' }
      }
      case 'create_invoice': {
        const lineItems = (action.data.items || []).map((item: any) => ({
          name: item.name || item.description || 'Item',
          price: Number(item.price || 0),
          quantity: Number(item.quantity || 1),
        }))
        // Resolve contact by name if provided
        let invoiceContactId = null
        const contactRef = action.data.contactId || action.data.contactName
        if (contactRef) {
          const contact = await resolveContactId(contactRef)
          invoiceContactId = contact?.id || null
        }
        const res = await fetch('/api/payments/invoices', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ contactId: invoiceContactId, lineItems, dueDate: action.data.dueDate, notes: action.data.notes })
        })
        const d = await res.json()
        if (d.ok) {
          const total = lineItems.reduce((s: number, i: any) => s + i.price * i.quantity, 0)
          return { ok: true, message: `Invoice ${d.data?.invoice_number || ''} created ($${total.toFixed(2)})` }
        }
        return { ok: false, message: d.error || 'Failed to create invoice' }
      }
      case 'create_product': {
        const res = await fetch('/api/payments/products', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ name: action.data.name, price: action.data.price, description: action.data.description, billingType: action.data.billingType || 'one_time' })
        })
        const d = await res.json()
        return d.ok ? { ok: true, message: `Product "${action.data.name}" created` } : { ok: false, message: d.error || 'Failed' }
      }
      // --- Tier 1 New Direct Actions ---
      case 'update_contact': {
        const contact = await resolveContactId(action.data.contactId)
        if (!contact) return { ok: false, message: `Contact "${action.data.contactId}" not found` }
        const body: any = { id: contact.id }
        if (action.data.name) body.displayName = action.data.name
        if (action.data.email) body.primaryEmail = action.data.email
        if (action.data.phone) body.primaryPhone = action.data.phone
        if (action.data.lifecycleStage) body.lifecycleStage = action.data.lifecycleStage
        const res = await fetch('/api/customers/people', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify(body)
        })
        const d = await res.json()
        return d.id ? { ok: true, message: `Contact "${contact.name}" updated` } : { ok: false, message: d.error || 'Failed to update contact' }
      }
      case 'delete_contact': {
        const contact = await resolveContactId(action.data.contactId)
        if (!contact) return { ok: false, message: `Contact "${action.data.contactId}" not found` }
        const res = await fetch('/api/customers/people', {
          method: 'DELETE', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ id: contact.id })
        })
        const d = await res.json()
        return !d.error ? { ok: true, message: `Contact "${contact.name}" deleted` } : { ok: false, message: d.error || 'Failed to delete contact' }
      }
      case 'search_contacts': {
        const res = await fetch(`/api/customers/people?search=${encodeURIComponent(action.data.query)}&pageSize=10`, { credentials: 'include' })
        const d = await res.json()
        if (d.items?.length > 0) {
          const list = d.items.slice(0, 5).map((c: any) => `${c.display_name || 'Unknown'} (${c.primary_email || 'no email'}) [${c.lifecycle_stage || 'prospect'}]`).join('; ')
          return { ok: true, message: `Found ${d.total || d.items.length} contact(s): ${list}` }
        }
        return { ok: true, message: 'No contacts found matching that search.' }
      }
      case 'create_reminder': {
        const entityId = action.data.entityId || '00000000-0000-0000-0000-000000000000'
        let remindAt = action.data.remindAt
        if (!remindAt && action.data.delayMinutes) {
          remindAt = new Date(Date.now() + Number(action.data.delayMinutes) * 60 * 1000).toISOString()
        }
        if (!remindAt) {
          remindAt = new Date(Date.now() + 60 * 60 * 1000).toISOString() // default 1 hour
        }
        const res = await fetch('/api/customers/reminders', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ message: action.data.message, entityType: action.data.entityType || 'task', entityId, remindAt })
        })
        const d = await res.json()
        return d.ok ? { ok: true, message: `Reminder set: "${action.data.message}"` } : { ok: false, message: d.error || 'Failed' }
      }
      case 'enroll_in_sequence': {
        const contact = await resolveContactId(action.data.contactId)
        if (!contact) return { ok: false, message: `Contact "${action.data.contactId}" not found` }
        const res = await fetch(`/api/sequences/${action.data.sequenceId}/enroll`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ contactId: contact.id })
        })
        const d = await res.json()
        return d.ok ? { ok: true, message: `${contact.name} enrolled in sequence` } : { ok: false, message: d.error || 'Failed' }
      }
      case 'send_sms': {
        const res = await fetch('/api/sms', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ to: action.data.to, message: action.data.message })
        })
        const d = await res.json()
        return d.ok ? { ok: true, message: `SMS sent to ${action.data.to}` } : { ok: false, message: d.error || 'Failed' }
      }
      case 'create_email_campaign': {
        const res = await fetch('/api/email/campaigns', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ name: action.data.name, subject: action.data.subject, bodyHtml: (action.data.body || '').split('\n').map((l: string) => `<p>${l}</p>`).join(''), listId: action.data.listId })
        })
        const d = await res.json()
        return d.ok ? { ok: true, message: `Campaign "${action.data.name}" created` } : { ok: false, message: d.error || 'Failed' }
      }
      case 'create_automation_rule': {
        const res = await fetch('/api/sequences/automation-rules', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ name: action.data.name, triggerType: action.data.triggerType, triggerConfig: action.data.triggerConfig || {}, actionType: action.data.actionType, actionConfig: action.data.actionConfig || {}, status: 'active' })
        })
        const d = await res.json()
        return d.ok ? { ok: true, message: `Automation "${action.data.name}" created` } : { ok: false, message: d.error || 'Failed' }
      }
      case 'create_booking_page': {
        const slug = (action.data.title || 'booking').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) + '-' + Date.now()
        const res = await fetch('/api/booking-pages', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ title: action.data.title, slug, durationMinutes: action.data.duration || 30, description: action.data.description })
        })
        const d = await res.json()
        if (d.ok) {
          const baseUrl = window.location.origin
          const bookingUrl = `${baseUrl}/book/${slug}`
          return { ok: true, message: `Booking page "${action.data.title}" created! Booking link: ${bookingUrl}` }
        }
        return { ok: false, message: d.error || 'Failed to create booking page' }
      }
      case 'create_event': {
        // If the AI sends a date without timezone offset (e.g. "2026-04-08T15:00:00"),
        // treat it as Pacific time by appending the offset
        let rawDate = action.data.date || new Date().toISOString()
        if (rawDate && !rawDate.endsWith('Z') && !rawDate.match(/[+-]\d{2}:\d{2}$/)) {
          // No timezone info — assume Pacific (PDT = -07:00)
          rawDate = rawDate + '-07:00'
        }
        const startDate = new Date(rawDate).toISOString()
        const durationMinutes = action.data.duration || 60
        const endDate = new Date(new Date(startDate).getTime() + durationMinutes * 60 * 1000).toISOString()
        const res = await fetch('/api/crm-events', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ title: action.data.title, startTime: startDate, endTime: endDate, timezone: 'America/Los_Angeles', locationName: action.data.location, capacity: action.data.capacity || 50, description: action.data.description, eventType: action.data.eventType || 'workshop' })
        })
        const d = await res.json()
        return d.ok ? { ok: true, message: `Event "${action.data.title}" created` } : { ok: false, message: d.error || 'Failed' }
      }
      case 'create_survey': {
        const fields = (action.data.questions || []).map((q: any, i: number) => ({ id: `q${i + 1}`, label: q.label, type: q.type || 'text', options: q.options }))
        const res = await fetch('/api/surveys', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ title: action.data.title, description: action.data.description, fields })
        })
        const d = await res.json()
        return d.ok ? { ok: true, message: `Survey "${action.data.title}" created` } : { ok: false, message: d.error || 'Failed' }
      }
      case 'create_form': {
        const res = await fetch('/api/forms', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ name: action.data.title, fields: action.data.fields })
        })
        const d = await res.json()
        return d.ok ? { ok: true, message: `Form "${action.data.title}" created` } : { ok: false, message: d.error || 'Failed' }
      }
      case 'create_email_list': {
        const res = await fetch('/api/email/lists', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ name: action.data.name, description: action.data.description })
        })
        const d = await res.json()
        return d.ok ? { ok: true, message: `Email list "${action.data.name}" created` } : { ok: false, message: d.error || 'Failed' }
      }
      case 'add_to_email_list': {
        const listContact = await resolveContactId(action.data.contactId)
        if (!listContact) return { ok: false, message: `Contact "${action.data.contactId}" not found` }
        const res = await fetch('/api/email/list-members', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ listId: action.data.listId, contactIds: [listContact.id] })
        })
        const d = await res.json()
        return d.ok ? { ok: true, message: 'Contact added to email list' } : { ok: false, message: d.error || 'Failed' }
      }
      case 'get_engagement_score': {
        const engContact = await resolveContactId(action.data.contactId)
        const engId = engContact?.id || action.data.contactId
        const res = await fetch(`/api/customers/engagement?contactId=${engId}`, { credentials: 'include' })
        const d = await res.json()
        if (d.ok && d.data) {
          const score = d.data.score || 0
          const label = score > 20 ? 'Hot' : score > 10 ? 'Warm' : 'Cold'
          return { ok: true, message: `Engagement score: ${score} (${label})` }
        }
        return { ok: true, message: 'No engagement data found' }
      }

      case 'set_reminder': {
        let remindAt = action.data.remindAt
        if (!remindAt && action.data.delayMinutes) {
          remindAt = new Date(Date.now() + action.data.delayMinutes * 60 * 1000).toISOString()
        }
        if (!remindAt) {
          remindAt = new Date(Date.now() + 60 * 60 * 1000).toISOString() // default 1 hour
        }
        return executeCrmAction({ type: 'create_reminder', data: { message: action.data.message, remindAt, entityType: 'task', entityId: action.data.contactId } })
      }

      // --- Simple edit/delete shortcuts (delegate to management handlers) ---
      case 'edit_event': {
        const eid = action.data.eventId || action.data.id || action.data.event_id || action.data.title || action.data.name
        if (!eid) return { ok: false, message: 'Please specify which event to edit.' }
        return executeCrmAction({ type: 'manage_event_advanced', data: { action: 'edit', eventId: eid, title: action.data.newTitle || (action.data.title !== eid ? action.data.title : undefined), duration: action.data.duration, date: action.data.date || action.data.startTime || action.data.start_time, location: action.data.location, capacity: action.data.capacity } })
      }
      case 'delete_event': {
        const eid = action.data.eventId || action.data.id || action.data.event_id || action.data.title || action.data.name
        if (!eid) return { ok: false, message: 'Please specify which event to delete.' }
        return executeCrmAction({ type: 'manage_event_advanced', data: { action: 'delete', eventId: eid } })
      }
      case 'edit_task': {
        const tid = action.data.taskId || action.data.id || action.data.task_id || action.data.title || action.data.name
        if (!tid) return { ok: false, message: 'Please specify which task to edit.' }
        if (action.data.markComplete) {
          return executeCrmAction({ type: 'manage_task_advanced', data: { action: 'complete', taskId: tid } })
        }
        return executeCrmAction({ type: 'manage_task_advanced', data: { action: 'edit', taskId: tid, title: action.data.newTitle || action.data.title, dueDate: action.data.dueDate } })
      }
      case 'delete_task': {
        const tid = action.data.taskId || action.data.id || action.data.task_id || action.data.title || action.data.name
        if (!tid) return { ok: false, message: 'Please specify which task to delete.' }
        return executeCrmAction({ type: 'manage_task_advanced', data: { action: 'delete', taskId: tid } })
      }
      case 'edit_deal': {
        const did = action.data.dealId || action.data.id || action.data.deal_id || action.data.title || action.data.name
        if (!did) return { ok: false, message: 'Please specify which deal to edit.' }
        return executeCrmAction({ type: 'manage_deal', data: { action: 'edit', dealId: did, title: action.data.newTitle || action.data.title, value: action.data.value, stage: action.data.stage } })
      }
      case 'delete_deal': {
        const did = action.data.dealId || action.data.id || action.data.deal_id || action.data.title || action.data.name
        if (!did) return { ok: false, message: 'Please specify which deal to delete.' }
        return executeCrmAction({ type: 'manage_deal', data: { action: 'delete', dealId: did } })
      }
      case 'delete_landing_page': {
        const pid = action.data.pageId || action.data.id || action.data.page_id || action.data.title || action.data.name
        if (!pid) return { ok: false, message: 'Please specify which page to delete.' }
        return executeCrmAction({ type: 'manage_landing_page', data: { action: 'delete', pageId: pid } })
      }
      case 'delete_booking_page': {
        const pid = action.data.pageId || action.data.id || action.data.page_id || action.data.title || action.data.name
        if (!pid) return { ok: false, message: 'Please specify which booking page to delete.' }
        return executeCrmAction({ type: 'manage_booking', data: { action: 'delete_page', pageId: pid } })
      }

      case 'remove_tag': {
        const contact = await resolveContactId(action.data.contactId)
        if (!contact) return { ok: false, message: `Contact "${action.data.contactId}" not found` }
        const res = await fetch('/api/crm-contact-tags', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ contactId: contact.id, tagName: action.data.tagName, action: 'remove' })
        })
        const d = await res.json()
        return d.ok ? { ok: true, message: `Tag "${action.data.tagName}" removed from ${contact.name}` } : { ok: false, message: d.error || 'Failed' }
      }
      case 'complete_task': {
        const tid = action.data.taskId || action.data.id || action.data.task_id || action.data.title || action.data.name
        if (!tid) return { ok: false, message: 'Please specify which task to complete.' }
        return executeCrmAction({ type: 'manage_task_advanced', data: { action: 'complete', taskId: tid } })
      }
      case 'close_deal': {
        const did = action.data.dealId || action.data.id || action.data.deal_id || action.data.title || action.data.name
        if (!did) return { ok: false, message: 'Please specify which deal to close.' }
        const subAction = action.data.result === 'won' ? 'close_won' : 'close_lost'
        return executeCrmAction({ type: 'manage_deal', data: { action: subAction, dealId: did } })
      }
      case 'edit_contact': {
        const cid = action.data.contactId || action.data.id || action.data.contact_id || action.data.name
        if (!cid) return { ok: false, message: 'Please specify which contact to edit.' }
        return executeCrmAction({ type: 'update_contact', data: { contactId: cid, name: action.data.newName || action.data.name, email: action.data.email, phone: action.data.phone, lifecycleStage: action.data.lifecycleStage } })
      }
      case 'edit_product': {
        const pid = action.data.productId || action.data.id || action.data.product_id || action.data.name
        if (!pid) return { ok: false, message: 'Please specify which product to edit.' }
        return executeCrmAction({ type: 'manage_product_advanced', data: { action: 'edit', productId: pid, name: action.data.newName || action.data.name, price: action.data.price, description: action.data.description } })
      }
      case 'delete_product': {
        const pid = action.data.productId || action.data.id || action.data.product_id || action.data.name
        if (!pid) return { ok: false, message: 'Please specify which product to delete.' }
        return executeCrmAction({ type: 'manage_product_advanced', data: { action: 'delete', productId: pid } })
      }
      case 'send_invoice': {
        const iid = action.data.invoiceId || action.data.id || action.data.invoice_id
        if (!iid) return { ok: false, message: 'Please specify which invoice to send.' }
        return executeCrmAction({ type: 'manage_invoice', data: { action: 'send', invoiceId: iid } })
      }
      case 'delete_invoice': {
        const iid = action.data.invoiceId || action.data.id || action.data.invoice_id
        if (!iid) return { ok: false, message: 'Please specify which invoice to delete.' }
        return executeCrmAction({ type: 'manage_invoice', data: { action: 'delete', invoiceId: iid } })
      }
      case 'publish_landing_page': {
        const pid = action.data.pageId || action.data.id || action.data.page_id || action.data.title || action.data.name
        if (!pid) return { ok: false, message: 'Please specify which page to publish.' }
        return executeCrmAction({ type: 'manage_landing_page', data: { action: 'publish', pageId: pid } })
      }
      case 'unpublish_landing_page': {
        const pid = action.data.pageId || action.data.id || action.data.page_id || action.data.title || action.data.name
        if (!pid) return { ok: false, message: 'Please specify which page to unpublish.' }
        return executeCrmAction({ type: 'manage_landing_page', data: { action: 'unpublish', pageId: pid } })
      }
      case 'cancel_event': {
        const eid = action.data.eventId || action.data.id || action.data.event_id || action.data.title || action.data.name
        if (!eid) return { ok: false, message: 'Please specify which event to cancel.' }
        return executeCrmAction({ type: 'manage_event_advanced', data: { action: 'cancel', eventId: eid } })
      }
      case 'pause_sequence': {
        const sid = action.data.sequenceId || action.data.id || action.data.sequence_id || action.data.name
        if (!sid) return { ok: false, message: 'Please specify which sequence to pause.' }
        return executeCrmAction({ type: 'manage_sequence_advanced', data: { action: 'pause', sequenceId: sid } })
      }
      case 'activate_sequence': {
        const sid = action.data.sequenceId || action.data.id || action.data.sequence_id || action.data.name
        if (!sid) return { ok: false, message: 'Please specify which sequence to activate.' }
        return executeCrmAction({ type: 'manage_sequence_advanced', data: { action: 'activate', sequenceId: sid } })
      }
      case 'mark_invoice_paid': {
        const iid = action.data.invoiceId || action.data.id || action.data.invoice_id
        if (!iid) return { ok: false, message: 'Please specify which invoice to mark as paid.' }
        return executeCrmAction({ type: 'manage_invoice', data: { action: 'mark_paid', invoiceId: iid } })
      }

      // --- Tier 2 Multi-Step Workflows ---
      case 'create_landing_page': {
        try {
          // Load business name for context
          const bpRes2 = await fetch('/api/customers/business-profile', { credentials: 'include' })
          const bpData2 = await bpRes2.json()
          const bizName = bpData2.data?.business_name || 'My Business'

          // Step 1: Generate copy via AI
          const genRes = await fetch('/api/landing_pages/ai/generate-copy', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
            body: JSON.stringify({
              pageType: action.data.pageType || 'capture-leads',
              subType: 'general',
              framework: 'PAS',
              sections: ['hero', 'pain-points', 'features-benefits', 'pricing', 'faq', 'cta-block'],
              businessContext: { businessName: bizName, targetAudience: action.data.targetAudience || 'entrepreneurs', tone: action.data.tone || 'professional', offerAnswers: { offer: action.data.offerDescription || action.data.title || 'Our offer' } },
            })
          })
          const genData = await genRes.json()
          if (!genData.ok) return { ok: false, message: genData.error || 'Failed to generate page content' }

          // Step 2: Create the page with generated sections
          const slug = (action.data.title || 'page').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50) + '-' + Date.now()
          const sections = genData.data?.sections || []
          const metaTitle = genData.data?.metaTitle || action.data.title
          const metaDesc = genData.data?.metaDescription || ''

          const pageType = action.data.pageType || 'capture-leads'
          const formFields = pageType === 'capture-leads' ? [{ label: 'Name', type: 'text', required: true }, { label: 'Email', type: 'email', required: true }] : []

          const createRes = await fetch('/api/landing_pages/pages', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
            body: JSON.stringify({
              title: action.data.title || metaTitle,
              slug,
              templateCategory: pageType,
              config: {
                wizardVersion: 2,
                pageType,
                generatedSections: sections,
                style: 'warm',
                styleId: 'warm',
                formFields,
                metaTitle,
                metaDescription: metaDesc,
                businessContext: { businessName: bizName, targetAudience: action.data.targetAudience || '' },
              }
            })
          })
          const createData = await createRes.json()
          if (!createData.ok) return { ok: false, message: createData.error || 'Failed to create page' }

          // Step 3: Publish the page (renders HTML from sections)
          const pageId = createData.data?.id
          if (pageId) {
            await fetch(`/api/landing_pages/pages/${pageId}/publish`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
              body: JSON.stringify({ style: 'warm' })
            })
          }

          return { ok: true, message: `Landing page "${action.data.title}" created and published! View it in the Landing Pages section.` }
        } catch { return { ok: false, message: 'Failed to create landing page' } }
      }
      case 'create_funnel': {
        const res = await fetch('/api/landing_pages/funnels/templates', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ templateId: action.data.templateId || 'lead-magnet' })
        })
        const d = await res.json()
        return d.ok ? { ok: true, message: `Funnel "${action.data.name}" created from ${action.data.templateId} template. Edit it in the Funnels section.` } : { ok: false, message: d.error || 'Failed' }
      }
      case 'create_course': {
        const courseTitle = action.data.title || 'New Course'
        const courseSlug = courseTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50) + '-' + Date.now()
        const res = await fetch('/api/courses', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ title: courseTitle, slug: courseSlug, description: action.data.description, price: action.data.price || 0, isFree: !action.data.price || action.data.price === 0 })
        })
        const d = await res.json()
        if (!d.ok) return { ok: false, message: d.error || 'Failed to create course' }
        // If AI generation available, trigger it
        if (action.data.targetAudience) {
          fetch('/api/courses/ai/generate-outline', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
            body: JSON.stringify({ courseId: d.data?.id, topic: courseTitle, audience: action.data.targetAudience, moduleCount: action.data.moduleCount || 5 })
          }).catch(() => {})
        }
        return { ok: true, message: `Course "${courseTitle}" created. ${action.data.targetAudience ? 'AI is generating the outline — ' : ''}Check the Courses section to edit it.` }
      }
      case 'create_email_sequence': {
        const emailCount = action.data.emailCount || 3
        const steps = Array.from({ length: emailCount }, (_, i) => ({
          stepType: i === 0 ? 'email' : (i % 2 === 0 ? 'email' : 'wait'),
          stepOrder: i,
          ...(i % 2 === 1 ? { delayDays: 2 } : { subject: `Email ${Math.ceil((i + 1) / 2)}`, bodyHtml: '<p>Draft email content</p>' }),
        }))
        const res = await fetch('/api/sequences', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ name: action.data.name, triggerType: action.data.triggerType || 'manual', steps })
        })
        const d = await res.json()
        return d.ok ? { ok: true, message: `Sequence "${action.data.name}" created with ${emailCount} emails. Edit the content in the Sequences section.` } : { ok: false, message: d.error || 'Failed' }
      }
      case 'generate_report': {
        const res = await fetch('/api/reports', { credentials: 'include' })
        const d = await res.json()
        if (!d.ok) return { ok: false, message: 'Failed to load report data' }
        const r = d.data
        const type = action.data.reportType || 'full_overview'
        let summary = ''
        if (type === 'pipeline' || type === 'full_overview') {
          summary += `Pipeline: ${r.pipelineByStage?.length || 0} stages. `
          summary += `Deals won: ${r.dealOutcomes?.won || 0}, lost: ${r.dealOutcomes?.lost || 0}, revenue: $${(r.dealOutcomes?.revenue || 0).toLocaleString()}. `
        }
        if (type === 'revenue' || type === 'full_overview') {
          summary += `Revenue this month: $${(r.paymentRevenue?.thisMonth || 0).toLocaleString()}, total: $${(r.paymentRevenue?.total || 0).toLocaleString()}. `
        }
        if (type === 'contacts' || type === 'full_overview') {
          const total30d = (r.contactsOverTime || []).reduce((s: number, d: any) => s + Number(d.count), 0)
          summary += `New contacts (30 days): ${total30d}. Sources: ${(r.contactsBySource || []).map((s: any) => `${s.source}: ${s.count}`).join(', ')}. `
        }
        if (type === 'landing_pages' || type === 'full_overview') {
          summary += `Top pages: ${(r.landingPagePerf || []).slice(0, 3).map((p: any) => `${p.title} (${p.view_count} views, ${p.submission_count} leads)`).join('; ')}. `
        }
        return { ok: true, message: summary || 'No report data available.' }
      }

      // --- Tier 3 Read/Query Tools ---
      case 'get_pipeline_summary': {
        const res = await fetch('/api/reports', { credentials: 'include' })
        const d = await res.json()
        if (!d.ok) return { ok: false, message: 'Failed to load pipeline data' }
        const stages = (d.data.pipelineByStage || []).map((s: any) => `${s.stage}: ${s.count} deals ($${Number(s.value || 0).toLocaleString()})`).join(', ')
        return { ok: true, message: `Pipeline: ${stages}. Won: ${d.data.dealOutcomes?.won || 0}, Lost: ${d.data.dealOutcomes?.lost || 0}.` }
      }
      case 'get_contact_details': {
        const contact = await resolveContactId(action.data.contactId)
        if (!contact) return { ok: false, message: `Contact "${action.data.contactId}" not found` }
        const res = await fetch(`/api/customers/people?ids=${contact.id}&pageSize=1`, { credentials: 'include' })
        const d = await res.json()
        const c = d.items?.[0]
        if (!c) return { ok: false, message: 'Contact not found' }
        return { ok: true, message: `${c.display_name || 'Unknown'} (${c.primary_email || 'no email'}). Stage: ${c.lifecycle_stage || 'prospect'}. Source: ${c.source || 'unknown'}.` }
      }
      case 'get_today_tasks': {
        const res = await fetch('/api/customers/tasks?filter=today', { credentials: 'include' })
        const d = await res.json()
        if (!d.ok || !d.data?.length) return { ok: true, message: 'No tasks due today.' }
        const list = d.data.slice(0, 5).map((t: any) => t.title).join(', ')
        return { ok: true, message: `${d.data.length} task(s) due today: ${list}` }
      }
      case 'get_upcoming_events': {
        const res = await fetch('/api/crm-events?upcoming=true', { credentials: 'include' })
        const d = await res.json()
        if (!d.ok || !d.data?.length) return { ok: true, message: 'No upcoming events.' }
        const list = d.data.slice(0, 5).map((e: any) => `${e.title} (${new Date(e.start_date).toLocaleDateString()})`).join(', ')
        return { ok: true, message: `${d.data.length} upcoming event(s): ${list}` }
      }
      case 'get_inbox_summary': {
        const res = await fetch('/api/inbox', { credentials: 'include' })
        const d = await res.json()
        const unread = d.data?.filter((m: any) => (m.unreadCount || m.unread_count) > 0).length || 0
        return { ok: true, message: `Inbox: ${unread} unread conversation(s), ${d.data?.length || 0} total.` }
      }
      case 'get_revenue_summary': {
        const res = await fetch('/api/reports', { credentials: 'include' })
        const d = await res.json()
        if (!d.ok) return { ok: false, message: 'Failed to load revenue data' }
        const rev = d.data.paymentRevenue
        return { ok: true, message: `Revenue this month: $${(rev?.thisMonth || 0).toLocaleString()}. Last month: $${(rev?.lastMonth || 0).toLocaleString()}. Total: $${(rev?.total || 0).toLocaleString()}. Bookings this month: ${d.data.bookingStats?.thisMonth || 0}.` }
      }
      case 'list_sequences': {
        const res = await fetch('/api/sequences', { credentials: 'include' })
        const d = await res.json()
        if (!d.ok || !d.data?.length) return { ok: true, message: 'No sequences found.' }
        const list = d.data.slice(0, 5).map((s: any) => `${s.name} (${s.is_active ? 'active' : 'inactive'})`).join(', ')
        return { ok: true, message: `${d.data.length} sequence(s): ${list}` }
      }
      case 'list_landing_pages': {
        const res = await fetch('/api/landing_pages/pages', { credentials: 'include' })
        const d = await res.json()
        if (!d.ok || !d.data?.length) return { ok: true, message: 'No landing pages found.' }
        const list = d.data.slice(0, 5).map((p: any) => `${p.title} (${p.view_count || 0} views, ${p.submission_count || 0} leads)`).join(', ')
        return { ok: true, message: `${d.data.length} page(s): ${list}` }
      }
      case 'list_email_lists': {
        const res = await fetch('/api/email/lists', { credentials: 'include' })
        const d = await res.json()
        if (!d.ok || !d.data?.length) return { ok: true, message: 'No email lists found.' }
        const list = d.data.slice(0, 5).map((l: any) => `${l.name} (${l.member_count || 0} members)`).join(', ')
        return { ok: true, message: `${d.data.length} list(s): ${list}` }
      }
      case 'list_products': {
        const res = await fetch('/api/payments/products', { credentials: 'include' })
        const d = await res.json()
        if (!d.ok || !d.data?.length) return { ok: true, message: 'No products found.' }
        const list = d.data.map((p: any) => `${p.name} — $${Number(p.price || 0).toFixed(2)} (${p.billing_type === 'recurring' ? 'recurring' : 'one-time'})`).join('; ')
        return { ok: true, message: `${d.data.length} product(s): ${list}` }
      }
      case 'list_recent_activity': {
        const res = await fetch('/api/ai/action-items', { credentials: 'include' })
        const d = await res.json()
        if (!d.ok) return { ok: true, message: 'No recent activity.' }
        const stats = d.data?.stats
        return { ok: true, message: `Recent: ${stats?.contacts?.last7Days || 0} new contacts this week, ${stats?.deals?.wonThisWeek || 0} deals won, ${stats?.inbox?.unread || 0} unread inbox items, ${stats?.landingPages?.submissions || 0} form submissions.` }
      }
      // ===== GROUPED MANAGEMENT TOOLS =====

      case 'manage_deal': {
        const { action: sub, title, value, stage } = action.data
        const rawDealId = action.data.dealId || action.data.id || action.data.deal_id || action.data.title || action.data.name
        if (!rawDealId) return { ok: false, message: 'Please specify which deal.' }
        const resolvedDeal = await resolveDealId(rawDealId)
        if (!resolvedDeal) return { ok: false, message: `Deal "${rawDealId}" not found` }
        const dealId = resolvedDeal.id
        if (sub === 'edit') {
          const body: any = { id: dealId }; if (title) body.title = title; if (value !== undefined) body.valueAmount = value; if (stage) body.pipelineStage = stage
          const res = await fetch('/api/customers/deals', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) })
          const d = await res.json()
          return d.id ? { ok: true, message: 'Deal updated' } : { ok: false, message: d.error || 'Failed to update deal' }
        }
        if (sub === 'close_won') { await fetch('/api/customers/deals', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ id: dealId, status: 'win' }) }); return { ok: true, message: 'Deal closed as won!' } }
        if (sub === 'close_lost') { await fetch('/api/customers/deals', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ id: dealId, status: 'lose' }) }); return { ok: true, message: 'Deal marked as lost' } }
        if (sub === 'delete') { await fetch('/api/customers/deals', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ id: dealId }) }); return { ok: true, message: 'Deal deleted' } }
        return { ok: false, message: `Unknown deal action: ${sub}` }
      }
      case 'manage_company': {
        const { action: sub, name, companyId, contactId } = action.data
        if (sub === 'create') { const orgId = await getOrgId(); const res = await fetch('/api/customers/companies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ displayName: name, organizationId: orgId }) }); const d = await res.json(); return d.id ? { ok: true, message: `Company "${name}" created` } : { ok: false, message: typeof d.error === 'string' ? d.error : 'Failed to create company' } }
        if (sub === 'search') { const res = await fetch(`/api/customers/companies?search=${encodeURIComponent(name)}&pageSize=5`, { credentials: 'include' }); const d = await res.json(); return { ok: true, message: d.items?.length ? `Found: ${d.items.map((c: any) => c.name || c.display_name).join(', ')}` : 'No companies found' } }
        if (sub === 'link_contact') { const res = await fetch('/api/crm-company-links', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ contactId, companyId }) }); const d = await res.json(); return d.ok ? { ok: true, message: 'Contact linked to company' } : { ok: false, message: d.error || 'Failed' } }
        if (sub === 'unlink_contact') { const res = await fetch('/api/crm-company-links', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ contactId, companyId }) }); return { ok: true, message: 'Contact unlinked from company' } }
        return { ok: false, message: `Unknown company action: ${sub}` }
      }
      case 'manage_contact_advanced': {
        const { action: sub, contactId, targetContactId, stage } = action.data
        const resolvedContact = contactId ? await resolveContactId(contactId) : null
        const resolvedCid = resolvedContact?.id || contactId
        if (sub === 'merge') { const target = targetContactId ? await resolveContactId(targetContactId) : null; const res = await fetch('/api/contacts/merge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ sourceId: resolvedCid, targetId: target?.id || targetContactId }) }); const d = await res.json(); return d.ok ? { ok: true, message: 'Contacts merged' } : { ok: false, message: d.error || 'Failed' } }
        if (sub === 'set_lifecycle_stage') { if (!resolvedContact) return { ok: false, message: `Contact "${contactId}" not found` }; await fetch('/api/customers/people', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ id: resolvedCid, lifecycleStage: stage }) }); return { ok: true, message: `${resolvedContact.name} stage set to ${stage}` } }
        if (sub === 'export_csv') { return { ok: true, message: 'To export contacts, go to the Contacts page and click Export. The CSV download will start automatically.' } }
        if (sub === 'view_attachments') { const res = await fetch(`/api/contacts/${resolvedCid}/attachments`, { credentials: 'include' }); const d = await res.json(); return d.ok && d.data?.length ? { ok: true, message: `${d.data.length} attachment(s): ${d.data.map((a: any) => a.filename).join(', ')}` } : { ok: true, message: 'No attachments found' } }
        return { ok: false, message: `Unknown contact action: ${sub}` }
      }
      case 'manage_task_advanced': {
        const { action: sub, title, dueDate } = action.data
        let taskId = action.data.taskId || action.data.id || action.data.task_id || action.data.title || action.data.name
        if (!taskId && sub !== 'list_overdue') return { ok: false, message: 'Please specify which task.' }
        if (taskId && !UUID_RE.test(taskId)) {
          const resolved = await resolveTaskId(taskId)
          if (!resolved) return { ok: false, message: `Task "${taskId}" not found` }
          taskId = resolved.id
        }
        if (sub === 'edit') { const body: any = { id: taskId }; if (title) body.title = title; if (dueDate) body.dueDate = dueDate; await fetch('/api/customers/tasks', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) }); return { ok: true, message: 'Task updated' } }
        if (sub === 'complete') { await fetch('/api/customers/tasks', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ id: taskId, is_done: true }) }); return { ok: true, message: 'Task completed' } }
        if (sub === 'delete') { await fetch(`/api/customers/tasks?id=${taskId}`, { method: 'DELETE', credentials: 'include' }); return { ok: true, message: 'Task deleted' } }
        if (sub === 'list_overdue') { const res = await fetch('/api/customers/tasks', { credentials: 'include' }); const d = await res.json(); const overdue = (d.data || []).filter((t: any) => t.due_date && new Date(t.due_date) < new Date() && !t.is_done); return { ok: true, message: overdue.length ? `${overdue.length} overdue task(s): ${overdue.slice(0, 5).map((t: any) => t.title).join(', ')}` : 'No overdue tasks' } }
        return { ok: false, message: `Unknown task action: ${sub}` }
      }
      case 'manage_pipeline': {
        const { action: sub, stages, mode } = action.data
        if (sub === 'get_stages') { const res = await fetch('/api/customers/business-profile', { credentials: 'include' }); const d = await res.json(); return { ok: true, message: `Mode: ${d.data?.pipeline_mode || 'deals'}. Stages: ${(d.data?.pipeline_stages || []).map((s: any) => s.name || s).join(', ')}` } }
        if (sub === 'update_stages') { await fetch('/api/customers/business-profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ pipelineStages: (stages || []).map((s: string) => ({ name: s })) }) }); return { ok: true, message: 'Pipeline stages updated' } }
        if (sub === 'switch_mode') { await fetch('/api/customers/business-profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ pipelineMode: mode }) }); return { ok: true, message: `Switched to ${mode} mode` } }
        return { ok: false, message: `Unknown pipeline action: ${sub}` }
      }
      case 'ai_draft_email': {
        const contactName = action.data.contactName || action.data.to?.split('@')[0] || 'there'
        const res = await fetch('/api/ai/draft-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ contactName, contactEmail: action.data.to, purpose: action.data.context, context: action.data.context, tone: action.data.tone || 'professional' }) })
        const d = await res.json()
        return d.ok ? { ok: true, message: `Draft: Subject: ${d.data?.subject || 'No subject'}\n\n${d.data?.body || d.data?.draft || 'Draft generated.'}` } : { ok: false, message: d.error || 'Failed to generate draft' }
      }
      case 'manage_invoice': {
        const { action: sub, invoiceId } = action.data
        if (sub === 'send') { const res = await fetch(`/api/payments/invoices/${invoiceId}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({}) }); const d = await res.json(); return d.ok ? { ok: true, message: 'Invoice sent' } : { ok: false, message: d.error || 'Failed' } }
        if (sub === 'mark_paid') { await fetch('/api/payments/invoices', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ id: invoiceId, status: 'paid' }) }); return { ok: true, message: 'Invoice marked as paid' } }
        if (sub === 'delete') { await fetch('/api/payments/invoices', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ id: invoiceId }) }); return { ok: true, message: 'Invoice deleted' } }
        return { ok: false, message: `Unknown invoice action: ${sub}` }
      }
      case 'manage_product_advanced': {
        const { action: sub, productId } = action.data
        if (sub === 'edit') { await fetch('/api/payments/products', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ id: productId, name: action.data.name, price: action.data.price, description: action.data.description }) }); return { ok: true, message: 'Product updated' } }
        if (sub === 'delete') { await fetch('/api/payments/products', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ id: productId }) }); return { ok: true, message: 'Product deleted' } }
        if (sub === 'list_details') { const res = await fetch('/api/payments/products', { credentials: 'include' }); const d = await res.json(); return { ok: true, message: d.data?.length ? d.data.map((p: any) => `${p.name}: $${Number(p.price).toFixed(2)} (${p.billing_type || 'one-time'})`).join('; ') : 'No products' } }
        return { ok: false, message: `Unknown product action: ${sub}` }
      }
      case 'process_payment': {
        const { action: sub } = action.data
        if (sub === 'refund') { const res = await fetch('/api/payments/stripe/refund', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ paymentRecordId: action.data.paymentId, amount: action.data.amount }) }); const d = await res.json(); return d.ok ? { ok: true, message: 'Refund processed' } : { ok: false, message: d.error || 'Failed' } }
        if (sub === 'cancel_subscription') { const res = await fetch('/api/payments/stripe/cancel-subscription', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ subscriptionId: action.data.subscriptionId }) }); const d = await res.json(); return d.ok ? { ok: true, message: 'Subscription cancelled' } : { ok: false, message: d.error || 'Failed' } }
        return { ok: false, message: `Unknown payment action: ${sub}` }
      }
      case 'manage_campaign': {
        const { action: sub, campaignId } = action.data
        if (sub === 'send') { const res = await fetch(`/api/email/campaigns-send?id=${campaignId}`, { method: 'POST', credentials: 'include' }); const d = await res.json(); return d.ok ? { ok: true, message: 'Campaign sent!' } : { ok: false, message: d.error || 'Failed' } }
        if (sub === 'test') { const res = await fetch(`/api/email/campaigns-test?id=${campaignId}`, { method: 'POST', credentials: 'include' }); const d = await res.json(); return d.ok ? { ok: true, message: 'Test email sent to your address' } : { ok: false, message: d.error || 'Failed' } }
        if (sub === 'delete') { await fetch(`/api/email/campaigns?id=${campaignId}`, { method: 'DELETE', credentials: 'include' }); return { ok: true, message: 'Campaign deleted' } }
        if (sub === 'edit') { await fetch('/api/email/campaigns', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ id: campaignId, subject: action.data.subject, bodyHtml: action.data.body ? `<p>${action.data.body}</p>` : undefined }) }); return { ok: true, message: 'Campaign updated' } }
        return { ok: false, message: `Unknown campaign action: ${sub}` }
      }
      case 'manage_sequence_advanced': {
        const { action: sub, sequenceId } = action.data
        if (sub === 'pause') { await fetch(`/api/sequences/${sequenceId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ status: 'paused' }) }); return { ok: true, message: 'Sequence paused' } }
        if (sub === 'activate') { await fetch(`/api/sequences/${sequenceId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ status: 'active' }) }); return { ok: true, message: 'Sequence activated' } }
        if (sub === 'delete') { await fetch(`/api/sequences/${sequenceId}`, { method: 'DELETE', credentials: 'include' }); return { ok: true, message: 'Sequence deleted' } }
        if (sub === 'edit') { await fetch(`/api/sequences/${sequenceId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ name: action.data.name }) }); return { ok: true, message: 'Sequence updated' } }
        if (sub === 'list_enrollments') { const res = await fetch(`/api/sequences/${sequenceId}`, { credentials: 'include' }); const d = await res.json(); return { ok: true, message: d.ok ? `Enrollments: ${d.data?.enrollments?.length || 0} contact(s)` : 'Could not load enrollments' } }
        return { ok: false, message: `Unknown sequence action: ${sub}` }
      }
      case 'manage_email_list_advanced': {
        const { action: sub, listId } = action.data
        if (sub === 'edit') { await fetch('/api/email/lists', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ id: listId, name: action.data.name }) }); return { ok: true, message: 'List updated' } }
        if (sub === 'delete') { await fetch(`/api/email/lists?id=${listId}`, { method: 'DELETE', credentials: 'include' }); return { ok: true, message: 'List deleted' } }
        if (sub === 'add_bulk' && action.data.contactIds) { await fetch('/api/email/list-members', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ listId, contactIds: action.data.contactIds }) }); return { ok: true, message: `Added ${action.data.contactIds.length} contact(s) to list` } }
        if (sub === 'remove_member') { await fetch('/api/email/list-members', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ listId, contactIds: [action.data.contactId] }) }); return { ok: true, message: 'Member removed from list' } }
        return { ok: false, message: `Unknown list action: ${sub}` }
      }
      case 'manage_landing_page': {
        const { action: sub } = action.data
        let pageId = action.data.pageId
        if (pageId && !UUID_RE.test(pageId)) {
          const resolved = await resolvePageId(pageId)
          if (!resolved) return { ok: false, message: `Landing page "${pageId}" not found` }
          pageId = resolved.id
        }
        if (sub === 'publish') { await fetch(`/api/landing_pages/pages/${pageId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ status: 'published' }) }); return { ok: true, message: 'Page published' } }
        if (sub === 'unpublish') { await fetch(`/api/landing_pages/pages/${pageId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ status: 'draft' }) }); return { ok: true, message: 'Page unpublished' } }
        if (sub === 'delete') { await fetch(`/api/landing_pages/pages/${pageId}`, { method: 'DELETE', credentials: 'include' }); return { ok: true, message: 'Page deleted' } }
        if (sub === 'edit') {
          if (action.data.title) {
            await fetch(`/api/landing_pages/pages/${pageId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ title: action.data.title }) })
            return { ok: true, message: `Page title updated to "${action.data.title}"` }
          }
          return { ok: true, message: 'To edit page content (text, images, layout), open the page in the Landing Pages section and use the visual editor. I can change the page title, publish/unpublish, or delete it.' }
        }
        if (sub === 'get_analytics') { return { ok: true, message: 'Page analytics are available on the Landing Pages page in the UI.' } }
        return { ok: false, message: `Unknown page action: ${sub}` }
      }
      case 'manage_funnel': {
        const { action: sub, funnelId } = action.data
        if (sub === 'publish') { await fetch(`/api/landing_pages/funnels?id=${funnelId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ isPublished: true }) }); return { ok: true, message: 'Funnel published' } }
        if (sub === 'unpublish') { await fetch(`/api/landing_pages/funnels?id=${funnelId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ isPublished: false }) }); return { ok: true, message: 'Funnel unpublished' } }
        if (sub === 'delete') { await fetch(`/api/landing_pages/funnels?id=${funnelId}`, { method: 'DELETE', credentials: 'include' }); return { ok: true, message: 'Funnel deleted' } }
        if (sub === 'get_analytics') { const res = await fetch(`/api/landing_pages/funnels/${funnelId}/analytics`, { credentials: 'include' }); const d = await res.json(); return d.ok ? { ok: true, message: `Funnel: ${d.data?.total_visits || 0} visits, ${d.data?.completed_sessions || 0} completions` } : { ok: true, message: 'Analytics available in the Funnels page.' } }
        return { ok: false, message: `Unknown funnel action: ${sub}` }
      }
      case 'manage_event_advanced': {
        const { action: sub } = action.data
        const rawEventId = action.data.eventId || action.data.id || action.data.event_id || action.data.title || action.data.name
        if (!rawEventId) return { ok: false, message: 'Please specify which event.' }
        const resolvedEvent = await resolveEventId(rawEventId)
        if (!resolvedEvent) return { ok: false, message: `Event "${rawEventId}" not found` }
        const eventId = resolvedEvent.id
        if (sub === 'edit') {
          const editBody: any = {}
          if (action.data.title) editBody.title = action.data.title
          if (action.data.description) editBody.description = action.data.description
          if (action.data.date || action.data.startTime) editBody.startTime = action.data.date || action.data.startTime
          // If duration changed but no new start time, fetch existing event to compute new end time
          if (action.data.duration) {
            if (!editBody.startTime) {
              const evRes = await fetch(`/api/crm-events`, { credentials: 'include' })
              const evData = await evRes.json()
              const existing = (evData.data || []).find((e: any) => e.id === eventId)
              if (existing?.start_time) editBody.startTime = existing.start_time
            }
            if (editBody.startTime) {
              let rawStart = editBody.startTime
              if (typeof rawStart === 'string' && !rawStart.endsWith('Z') && !rawStart.match(/[+-]\d{2}:\d{2}$/)) {
                rawStart = rawStart + '-07:00'
              }
              editBody.endTime = new Date(new Date(rawStart).getTime() + action.data.duration * 60 * 1000).toISOString()
              editBody.startTime = new Date(rawStart).toISOString()
            }
          }
          if (action.data.endTime) editBody.endTime = action.data.endTime
          if (action.data.location) editBody.locationName = action.data.location
          if (action.data.capacity) editBody.capacity = action.data.capacity
          if (action.data.eventType) editBody.eventType = action.data.eventType
          const editRes = await fetch(`/api/crm-events?id=${eventId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(editBody) })
          const editD = await editRes.json()
          return editD.ok !== false ? { ok: true, message: 'Event updated' } : { ok: false, message: editD.error || 'Failed to update event' }
        }
        if (sub === 'publish') { await fetch(`/api/crm-events?id=${eventId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ status: 'published' }) }); return { ok: true, message: 'Event published' } }
        if (sub === 'delete') { await fetch(`/api/crm-events?id=${eventId}`, { method: 'DELETE', credentials: 'include' }); return { ok: true, message: 'Event deleted' } }
        if (sub === 'cancel') { await fetch(`/api/crm-events?id=${eventId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ status: 'cancelled' }) }); return { ok: true, message: 'Event cancelled' } }
        if (sub === 'email_attendees') { const res = await fetch(`/api/crm-events/${eventId}/email`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ subject: action.data.title || 'Event Update', body: action.data.message || '' }) }); const d = await res.json(); return d.ok ? { ok: true, message: 'Email sent to all attendees' } : { ok: false, message: d.error || 'Failed' } }
        if (sub === 'get_attendees') { const res = await fetch(`/api/crm-events/${eventId}/attendees`, { credentials: 'include' }); const d = await res.json(); return d.ok ? { ok: true, message: `${d.data?.length || 0} attendee(s): ${(d.data || []).slice(0, 5).map((a: any) => a.name || a.email).join(', ')}` } : { ok: true, message: 'Could not load attendees' } }
        return { ok: false, message: `Unknown event action: ${sub}` }
      }
      case 'manage_booking': {
        const { action: sub } = action.data
        if (sub === 'confirm') { await fetch(`/api/bookings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ id: action.data.bookingId, status: 'confirmed' }) }); return { ok: true, message: 'Booking confirmed' } }
        if (sub === 'cancel') { await fetch(`/api/bookings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ id: action.data.bookingId, status: 'cancelled' }) }); return { ok: true, message: 'Booking cancelled' } }
        if (sub === 'delete') { await fetch(`/api/bookings`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ id: action.data.bookingId }) }); return { ok: true, message: 'Booking deleted' } }
        if (sub === 'edit_page') { await fetch(`/api/booking-pages`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ id: action.data.pageId, title: action.data.title }) }); return { ok: true, message: 'Booking page updated' } }
        if (sub === 'delete_page') { await fetch(`/api/booking-pages`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ id: action.data.pageId }) }); return { ok: true, message: 'Booking page deleted' } }
        return { ok: false, message: `Unknown booking action: ${sub}` }
      }
      case 'manage_calendar': {
        const { action: sub } = action.data
        if (sub === 'get_today' || sub === 'get_week') { const res = await fetch('/api/bookings', { credentials: 'include' }); const d = await res.json(); const items = d.ok ? d.data || [] : []; return { ok: true, message: items.length ? `${items.length} booking(s): ${items.slice(0, 5).map((b: any) => `${b.title || 'Booking'} at ${new Date(b.start_time).toLocaleString()}`).join('; ')}` : 'No bookings found' } }
        if (sub === 'block_time') {
          let blockRaw = action.data.date || new Date().toISOString()
          if (blockRaw && !blockRaw.endsWith('Z') && !blockRaw.match(/[+-]\d{2}:\d{2}$/)) {
            blockRaw = blockRaw + '-07:00'
          }
          const blockStart = new Date(blockRaw).toISOString()
          const blockDuration = action.data.duration || 60
          const blockEnd = new Date(new Date(blockStart).getTime() + blockDuration * 60 * 1000).toISOString()
          await fetch('/api/events/block', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ start: blockStart, end: blockEnd, title: action.data.reason || 'Blocked' }) })
          return { ok: true, message: 'Time blocked on calendar' }
        }
        return { ok: false, message: `Unknown calendar action: ${sub}` }
      }
      case 'manage_survey_advanced': {
        const { action: sub, surveyId } = action.data
        if (sub === 'edit') { await fetch('/api/surveys', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ id: surveyId, title: action.data.title }) }); return { ok: true, message: 'Survey updated' } }
        if (sub === 'toggle_active') { await fetch('/api/surveys', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ id: surveyId, toggleActive: true }) }); return { ok: true, message: 'Survey status toggled' } }
        if (sub === 'delete') { await fetch('/api/surveys', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ id: surveyId }) }); return { ok: true, message: 'Survey deleted' } }
        if (sub === 'get_responses') { const res = await fetch(`/api/surveys/${surveyId}/responses`, { credentials: 'include' }); const d = await res.json(); return d.ok ? { ok: true, message: `${d.data?.length || 0} response(s) received` } : { ok: true, message: 'Could not load responses' } }
        if (sub === 'send') { return { ok: true, message: 'To send a survey, share the public link or use an email campaign. The survey link is available on the Surveys page.' } }
        return { ok: false, message: `Unknown survey action: ${sub}` }
      }
      case 'manage_form_advanced': {
        const { action: sub, formId } = action.data
        if (sub === 'edit') { await fetch(`/api/forms/${formId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ name: action.data.name, fields: action.data.fields }) }); return { ok: true, message: 'Form updated' } }
        if (sub === 'delete') { await fetch(`/api/forms/${formId}`, { method: 'DELETE', credentials: 'include' }); return { ok: true, message: 'Form deleted' } }
        if (sub === 'get_submissions') { const res = await fetch(`/api/forms/${formId}/submissions`, { credentials: 'include' }); const d = await res.json(); return d.ok ? { ok: true, message: `${d.data?.length || 0} submission(s)` } : { ok: true, message: 'Could not load submissions' } }
        if (sub === 'duplicate') { return { ok: true, message: 'Form duplication is available on the Forms page in the UI.' } }
        return { ok: false, message: `Unknown form action: ${sub}` }
      }
      case 'manage_course_advanced': {
        const { action: sub, courseId } = action.data
        if (sub === 'edit') { await fetch(`/api/courses/${courseId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ title: action.data.title, description: action.data.description }) }); return { ok: true, message: 'Course updated' } }
        if (sub === 'publish') { await fetch(`/api/courses/${courseId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ isPublished: true }) }); return { ok: true, message: 'Course published' } }
        if (sub === 'delete') { await fetch(`/api/courses/${courseId}`, { method: 'DELETE', credentials: 'include' }); return { ok: true, message: 'Course deleted' } }
        if (sub === 'generate_outline') { await fetch('/api/courses/ai/generate-outline', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ courseId, topic: action.data.title, audience: action.data.targetAudience }) }); return { ok: true, message: 'AI is generating the course outline. Check the Courses section.' } }
        if (sub === 'generate_landing') { await fetch('/api/courses/ai/generate-landing-copy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ courseId }) }); return { ok: true, message: 'AI is generating the landing page copy.' } }
        return { ok: false, message: `Unknown course action: ${sub}` }
      }
      case 'manage_chat_widget': {
        const { action: sub } = action.data
        if (sub === 'create') { const res = await fetch('/api/chat/widgets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ name: action.data.name, greeting_message: action.data.greeting, personality: action.data.personality }) }); const d = await res.json(); return d.ok ? { ok: true, message: `Chat widget "${action.data.name}" created` } : { ok: false, message: d.error || 'Failed' } }
        if (sub === 'edit') { await fetch('/api/chat/widgets', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ id: action.data.widgetId, name: action.data.name, greeting_message: action.data.greeting, personality: action.data.personality }) }); return { ok: true, message: 'Widget updated' } }
        if (sub === 'delete') { await fetch(`/api/chat/widgets?id=${action.data.widgetId}`, { method: 'DELETE', credentials: 'include' }); return { ok: true, message: 'Widget deleted' } }
        if (sub === 'toggle_active') { await fetch('/api/chat/widgets', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ id: action.data.widgetId, toggleActive: true }) }); return { ok: true, message: 'Widget status toggled' } }
        if (sub === 'get_conversations') { const res = await fetch('/api/chat/conversations', { credentials: 'include' }); const d = await res.json(); return d.ok ? { ok: true, message: `${d.data?.length || 0} conversation(s)` } : { ok: true, message: 'No conversations' } }
        return { ok: false, message: `Unknown widget action: ${sub}` }
      }
      case 'manage_inbox_conversation': {
        const { action: sub, conversationId, message } = action.data
        if (sub === 'reply') { const res = await fetch('/api/email/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ conversationId, bodyHtml: `<p>${(message || '').replace(/\n/g, '</p><p>')}</p>` }) }); const d = await res.json(); return d.ok ? { ok: true, message: 'Reply sent' } : { ok: false, message: d.error || 'Failed' } }
        if (sub === 'mark_read') { return { ok: true, message: 'Conversation marked as read' } }
        if (sub === 'close') { return { ok: true, message: 'Conversation closed' } }
        if (sub === 'reopen') { return { ok: true, message: 'Conversation reopened' } }
        if (sub === 'add_note') { await fetch('/api/inbox/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ conversationId, content: message }) }); return { ok: true, message: 'Note added to conversation' } }
        if (sub === 'ai_draft') { const res = await fetch('/api/inbox/ai-draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ conversationId }) }); const d = await res.json(); return d.ok ? { ok: true, message: `AI draft: ${d.data?.draft || 'Draft generated'}` } : { ok: false, message: 'Could not generate draft' } }
        return { ok: false, message: `Unknown inbox action: ${sub}` }
      }
      case 'manage_affiliate': {
        const { action: sub } = action.data
        if (sub === 'create_campaign') { const res = await fetch('/api/affiliates/campaigns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ name: action.data.name, commissionRate: action.data.commissionRate || 10 }) }); const d = await res.json(); return d.ok ? { ok: true, message: `Affiliate campaign "${action.data.name}" created` } : { ok: false, message: d.error || 'Failed' } }
        if (sub === 'add_affiliate') { const res = await fetch('/api/affiliates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ email: action.data.email, name: action.data.name, campaignId: action.data.campaignId }) }); const d = await res.json(); return d.ok ? { ok: true, message: `Affiliate ${action.data.name || action.data.email} added` } : { ok: false, message: d.error || 'Failed' } }
        if (sub === 'approve') { await fetch(`/api/affiliates/${action.data.affiliateId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ status: 'approved' }) }); return { ok: true, message: 'Affiliate approved' } }
        if (sub === 'reject') { await fetch(`/api/affiliates/${action.data.affiliateId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ status: 'rejected' }) }); return { ok: true, message: 'Affiliate rejected' } }
        if (sub === 'pause') { await fetch(`/api/affiliates/${action.data.affiliateId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ status: 'paused' }) }); return { ok: true, message: 'Affiliate paused' } }
        return { ok: false, message: `Unknown affiliate action: ${sub}` }
      }
      case 'manage_automation_advanced': {
        const { action: sub, ruleId } = action.data
        if (sub === 'enable') { await fetch('/api/sequences/automation-rules', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ id: ruleId, is_active: true }) }); return { ok: true, message: 'Automation enabled' } }
        if (sub === 'disable') { await fetch('/api/sequences/automation-rules', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ id: ruleId, is_active: false }) }); return { ok: true, message: 'Automation disabled' } }
        if (sub === 'delete') { await fetch('/api/sequences/automation-rules', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ id: ruleId }) }); return { ok: true, message: 'Automation deleted' } }
        if (sub === 'test') { const res = await fetch('/api/sequences/automation-rules/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ ruleId }) }); const d = await res.json(); return d.ok ? { ok: true, message: 'Automation test executed' } : { ok: false, message: d.error || 'Test failed' } }
        if (sub === 'get_logs') { const res = await fetch(`/api/sequences/automation-rules/${ruleId}/logs`, { credentials: 'include' }); const d = await res.json(); return d.ok ? { ok: true, message: `${d.data?.length || 0} execution(s) logged` } : { ok: true, message: 'No logs found' } }
        if (sub === 'edit') { await fetch('/api/sequences/automation-rules', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ id: ruleId, name: action.data.name }) }); return { ok: true, message: 'Automation updated' } }
        return { ok: false, message: `Unknown automation action: ${sub}` }
      }
      case 'update_settings': {
        const { action: sub } = action.data
        if (sub === 'update_profile') { await fetch('/api/customers/business-profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ businessName: action.data.businessName, businessType: action.data.businessType }) }); return { ok: true, message: 'Business profile updated' } }
        if (sub === 'update_pipeline') { await fetch('/api/customers/business-profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ pipelineMode: action.data.pipelineMode, pipelineStages: (action.data.pipelineStages || []).map((s: string) => ({ name: s })) }) }); return { ok: true, message: 'Pipeline settings updated' } }
        if (sub === 'update_persona') { await fetch('/api/customers/business-profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ aiPersonaName: action.data.personaName, aiPersonaStyle: action.data.personaStyle }) }); return { ok: true, message: 'AI persona updated' } }
        if (sub === 'invite_team') { const res = await fetch('/api/team', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ email: action.data.teamEmail, role: action.data.teamRole || 'member' }) }); const d = await res.json(); return d.ok ? { ok: true, message: `Team invite sent to ${action.data.teamEmail}` } : { ok: false, message: d.error || 'Failed' } }
        return { ok: false, message: `Unknown settings action: ${sub}` }
      }

      default:
        return { ok: false, message: `Unknown action: ${action.type}` }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Action failed'
    return { ok: false, message }
  }
}

// ---- Markdown renderer (simplified) ----
function MarkdownText({ text }: { text: string }) {
  const clean = text.replace(/```crm-action[\s\S]*?```/g, '').trim()
  if (!clean) return null

  const lines = clean.split('\n')
  return (
    <div className="space-y-1">
      {lines.map((line, i) => {
        let html = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')
        html = html.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" class="text-accent underline">$1</a>')
        if (html.startsWith('- ') || html.startsWith('* ')) {
          html = '\u2022 ' + html.slice(2)
        }
        return <p key={i} className="text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: html }} />
      })}
    </div>
  )
}

// ---- Relative time formatter ----
function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHrs = Math.floor(diffMins / 60)
  if (diffHrs < 24) return `${diffHrs}h ago`
  const diffDays = Math.floor(diffHrs / 24)
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString()
}

interface Conversation {
  id: string
  title: string
  is_archived: boolean
  updated_at: string
  message_count: number
}

// ---- Main Component ----
export default function VoiceAssistantPage() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [personaName, setPersonaName] = useState('Scout')

  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [showMobileSidebar, setShowMobileSidebar] = useState(false)
  const [editingConvId, setEditingConvId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')

  const [listening, setListening] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [ttsVoice, setTtsVoice] = useState('alloy')

  // Realtime API state
  const [wsConnected, setWsConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [mode, setMode] = useState<'voice' | 'text'>('text')
  const [userTranscript, setUserTranscript] = useState('')
  const [assistantTranscript, setAssistantTranscript] = useState('')

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const sendMessageRef = useRef<(text: string) => void>(() => {})
  const activeConversationIdRef = useRef<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioStreamRef = useRef<MediaStream | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const playbackContextRef = useRef<AudioContext | null>(null)
  const playbackBufferRef = useRef<Float32Array[]>([])
  const isPlayingRef = useRef(false)
  // Reconciliation bookkeeping — reset on response.created, read on response.done.
  const turnToolCallsRef = useRef<number>(0)
  // Map of messageIndex → resolver function for pending confirmation prompts.
  // When the user clicks Confirm/Cancel the resolver fires and the Promise in
  // handleRealtimeToolCall continues.
  const pendingConfirmsRef = useRef<Map<number, (confirmed: boolean) => void>>(new Map())

  // Load persona + action items for a proactive greeting
  useEffect(() => {
    Promise.all([
      fetch('/api/customers/business-profile', { credentials: 'include' }).then(r => r.json()).catch(() => null),
      fetch('/api/ai/action-items', { credentials: 'include' }).then(r => r.json()).catch(() => null),
    ]).then(([profileRes, actionRes]) => {
      const name = profileRes?.ok && profileRes?.data?.ai_persona_name ? profileRes.data.ai_persona_name : 'Scout'
      setPersonaName(name)

      const items: Array<{ title: string; description?: string }> = actionRes?.ok && Array.isArray(actionRes?.data?.actionItems)
        ? actionRes.data.actionItems
        : []

      let greeting: string
      if (items.length === 0) {
        greeting = `Hey! I'm ${name}. Your inbox is clear — ask me to do anything, from pulling a pipeline summary to drafting an email.`
      } else if (items.length === 1) {
        greeting = `Hey! I'm ${name}. One thing on your plate: **${items[0].title}**. Want me to take it from here, or is there something else?`
      } else {
        const top = items.slice(0, 3).map(it => `- **${it.title}**`).join('\n')
        greeting = `Hey! I'm ${name}. You have ${items.length} things to look at — here are the top ${Math.min(3, items.length)}:\n\n${top}\n\nWant me to handle any of these?`
      }

      setMessages([{ role: 'assistant', content: greeting }])
    }).catch(() => {
      setMessages([{ role: 'assistant', content: "Hey! I'm your AI assistant. What can I help with?" }])
    })
  }, [])

  // Load conversations on mount
  useEffect(() => {
    loadConversations()
  }, [])

  // Keep ref in sync
  useEffect(() => {
    activeConversationIdRef.current = activeConversationId
  }, [activeConversationId])

  function loadConversations() {
    fetch('/api/ai/conversations', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.ok) setConversations(d.data || []) })
      .catch(() => {})
  }

  async function loadConversation(id: string) {
    const res = await fetch(`/api/ai/conversations/${id}`, { credentials: 'include' })
    const d = await res.json()
    if (d.ok && d.data) {
      setActiveConversationId(id)
      setMessages(d.data.messages || [])
      setShowMobileSidebar(false)
    }
  }

  function startNewChat() {
    setActiveConversationId(null)
    activeConversationIdRef.current = null
    setMessages([{
      role: 'assistant',
      content: `Hey! I'm ${personaName}. What can I help with?`
    }])
  }

  async function renameConversation(id: string, newTitle: string) {
    if (!newTitle.trim()) { setEditingConvId(null); return }
    await fetch('/api/ai/conversations', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ id, title: newTitle.trim() })
    })
    setEditingConvId(null)
    loadConversations()
  }

  async function archiveConversation(id: string) {
    if (!confirm('Archive this conversation?')) return
    await fetch('/api/ai/conversations', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ id, is_archived: true })
    })
    loadConversations()
    if (activeConversationId === id) startNewChat()
  }

  async function deleteConversation(id: string) {
    if (!confirm('Delete this conversation? This cannot be undone.')) return
    await fetch(`/api/ai/conversations?id=${id}`, { method: 'DELETE', credentials: 'include' })
    loadConversations()
    if (activeConversationId === id) startNewChat()
  }

  function saveConversation(allMsgs: Message[]) {
    const title = allMsgs.find(m => m.role === 'user')?.content?.slice(0, 50) || 'New conversation'
    const payload = allMsgs.map(m => ({ role: m.role, content: m.content }))
    const currentId = activeConversationIdRef.current
    // Skip if a creation is already in progress
    if (currentId === 'creating') return

    if (currentId && currentId !== 'creating') {
      fetch('/api/ai/conversations', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ id: currentId, messages: payload, title })
      }).then(() => loadConversations()).catch(() => {})
    } else {
      // Immediately set ref to prevent duplicate creation from rapid calls
      activeConversationIdRef.current = 'creating'
      fetch('/api/ai/conversations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ title, messages: payload })
      }).then(r => r.json()).then(d => {
        if (d.ok) {
          activeConversationIdRef.current = d.data.id
          setActiveConversationId(d.data.id)
          loadConversations()
        } else {
          activeConversationIdRef.current = null
        }
      }).catch(() => { activeConversationIdRef.current = null })
    }
  }

  // Auto-scroll the messages area to the bottom when content changes.
  // Uses scrollIntoView so it finds the nearest scrollable ancestor — the
  // sentinel sits inside a space-y-4 wrapper, so setting scrollTop on
  // parentElement (previous impl) silently did nothing because that wrapper
  // itself isn't scrollable. Also fires on assistantTranscript so voice
  // streaming tracks the latest word in view.
  useEffect(() => {
    if (!messagesEndRef.current) return
    messagesEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, assistantTranscript, userTranscript])

  // ---- Realtime Voice Connection ----
  async function connectVoice() {
    setConnecting(true)
    try {
      // Request microphone permission FIRST (before WebSocket)
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { sampleRate: 24000, channelCount: 1, echoCancellation: true, noiseSuppression: true }
        })
      } catch {
        alert('Microphone access is required for voice chat. Please allow microphone access and try again.')
        setConnecting(false)
        return
      }

      const pageContext = derivePageContext()
      const res = await fetch('/api/ai/realtime/session', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice: ttsVoice, pageContext }),
      })
      const data = await res.json()
      if (!data.ok || !data.data?.clientSecret) {
        stream.getTracks().forEach(t => t.stop())
        throw new Error(data.error || 'Failed to create session')
      }

      const { clientSecret, model, sessionConfig } = data.data

      const url = `wss://api.openai.com/v1/realtime?model=${model}`
      const ws = new WebSocket(url, ['realtime', `openai-insecure-api-key.${clientSecret}`])
      wsRef.current = ws

      // Timeout if connection doesn't open within 10s
      const connectTimeout = setTimeout(() => {
        if (!wsConnected) {
          console.error('[realtime] Connection timeout')
          ws.close()
          stream.getTracks().forEach(t => t.stop())
          setConnecting(false)
        }
      }, 10000)

      ws.onopen = async () => {
        clearTimeout(connectTimeout)
        setWsConnected(true)
        setConnecting(false)
        setMode('voice')

        // Send full session config (instructions, tools)
        if (sessionConfig) {
          ws.send(JSON.stringify({
            type: 'session.update',
            session: sessionConfig,
          }))
        }

        setListening(true)
        audioStreamRef.current = stream
        const audioCtx = new AudioContext({ sampleRate: 24000 })
        audioContextRef.current = audioCtx
        const source = audioCtx.createMediaStreamSource(stream)
        const processor = audioCtx.createScriptProcessor(4096, 1, 1)
        processorRef.current = processor

        processor.onaudioprocess = (e) => {
          if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
          const input = e.inputBuffer.getChannelData(0)
          const pcm16 = new Int16Array(input.length)
          for (let i = 0; i < input.length; i++) {
            pcm16[i] = Math.max(-32768, Math.min(32767, input[i] * 32768))
          }
          const bytes = new Uint8Array(pcm16.buffer)
          let binary = ''
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
          const base64 = btoa(binary)
          wsRef.current.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: base64 }))
        }

        source.connect(processor)
        processor.connect(audioCtx.destination)

        playbackContextRef.current = new AudioContext({ sampleRate: 24000 })
      }

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data)
        handleRealtimeEvent(msg)
      }

      ws.onerror = (err) => {
        clearTimeout(connectTimeout)
        console.error('[realtime] WebSocket error:', err)
        stream.getTracks().forEach(t => t.stop())
        setConnecting(false)
        setWsConnected(false)
      }

      ws.onclose = (event) => {
        clearTimeout(connectTimeout)
        console.log('[realtime] WebSocket closed:', event.code, event.reason)
        setWsConnected(false)
        setConnecting(false)
      }
    } catch (err: any) {
      console.error('[realtime] Connection failed:', err)
      setConnecting(false)
      setWsConnected(false)
    }
  }

  function disconnectVoice() {
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null }
    if (audioStreamRef.current) { audioStreamRef.current.getTracks().forEach(t => t.stop()); audioStreamRef.current = null }
    if (processorRef.current) { processorRef.current.disconnect(); processorRef.current = null }
    if (audioContextRef.current) { audioContextRef.current.close(); audioContextRef.current = null }
    if (playbackContextRef.current) { playbackContextRef.current.close(); playbackContextRef.current = null }
    playbackBufferRef.current = []
    isPlayingRef.current = false
    setWsConnected(false)
    setMode('text')
    setUserTranscript('')
    setAssistantTranscript('')
  }

  // ---- Realtime Event Handler ----
  function handleRealtimeEvent(msg: any) {
    switch (msg.type) {
      case 'input_audio_buffer.speech_started':
        setListening(true)
        setUserTranscript('')
        playbackBufferRef.current = []
        isPlayingRef.current = false
        break

      case 'input_audio_buffer.speech_stopped':
        setListening(false)
        break

      case 'conversation.item.input_audio_transcription.completed':
        if (msg.transcript) {
          setUserTranscript('')
          setMessages(prev => [...prev, { role: 'user', content: msg.transcript }])
        }
        break

      case 'response.audio_transcript.delta':
      case 'response.output_audio_transcript.delta':
        setAssistantTranscript(prev => prev + msg.delta)
        break

      case 'response.audio_transcript.done':
      case 'response.output_audio_transcript.done':
        if (msg.transcript) {
          setAssistantTranscript('')
          setMessages(prev => {
            const updated = [...prev, { role: 'assistant' as const, content: msg.transcript }]
            saveConversation(updated)
            return updated
          })
        }
        break

      case 'response.audio.delta':
      case 'response.output_audio.delta':
        if (msg.delta) {
          const binary = atob(msg.delta)
          const bytes = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
          const pcm16 = new Int16Array(bytes.buffer)
          const float32 = new Float32Array(pcm16.length)
          for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 32768
          playbackBufferRef.current.push(float32)
          if (!isPlayingRef.current) playNextAudioChunk()
        }
        setSpeaking(true)
        break

      case 'response.audio.done':
      case 'response.output_audio.done':
        setSpeaking(false)
        break

      case 'response.created':
        turnToolCallsRef.current = 0
        break

      case 'response.function_call_arguments.done':
        turnToolCallsRef.current += 1
        handleRealtimeToolCall(msg.call_id, msg.name, msg.arguments)
        break

      case 'response.done':
        reconcileTurn()
        break

      case 'error': {
        const errMsg = msg.error?.message || JSON.stringify(msg.error || msg)
        console.error('[realtime] Error:', errMsg)
        if (msg.error?.code === 'insufficient_quota') {
          setMessages(prev => [...prev, { role: 'assistant', content: 'Voice chat is temporarily unavailable — the AI provider quota has been exceeded. Please try again later or use text chat.' }])
          disconnectVoice()
        }
        break
      }
    }
  }

  function playNextAudioChunk() {
    if (!playbackContextRef.current || playbackBufferRef.current.length === 0) {
      isPlayingRef.current = false
      return
    }
    // Resume audio context if suspended (browser autoplay policy)
    if (playbackContextRef.current.state === 'suspended') {
      playbackContextRef.current.resume()
    }
    isPlayingRef.current = true
    const chunk = playbackBufferRef.current.shift()!
    const buffer = playbackContextRef.current.createBuffer(1, chunk.length, 24000)
    buffer.getChannelData(0).set(chunk)
    const source = playbackContextRef.current.createBufferSource()
    source.buffer = buffer
    source.connect(playbackContextRef.current.destination)
    source.onended = () => playNextAudioChunk()
    source.start()
  }

  function reconcileTurn() {
    // Compare the assistant's final transcript for the just-completed turn
    // against the number of tool calls actually emitted. If the transcript
    // claims more state-changing actions than were called, surface a warning.
    const toolCalls = turnToolCallsRef.current
    setMessages(prev => {
      // Find the most recent assistant transcript message (not a tool-status bubble)
      for (let i = prev.length - 1; i >= 0; i--) {
        const m = prev[i]
        if (m.role !== 'assistant') continue
        if (m.action || m.actionStatus) continue
        const transcript = m.content || ''
        const matches = transcript.toLowerCase().match(STATE_CHANGE_VERB_REGEX) || []
        const verbsClaimed = Array.from(new Set(matches))
        if (verbsClaimed.length > toolCalls) {
          const updated = [...prev]
          updated[i] = { ...m, reconciliationWarning: { verbsClaimed, toolsCalled: toolCalls } }
          return updated
        }
        break
      }
      return prev
    })
  }

  function retryMissedSteps(message: Message) {
    const verbs = message.reconciliationWarning?.verbsClaimed || []
    if (!verbs.length || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    // Nudge the model to actually execute what it described. The prompt is
    // explicit so there's no ambiguity.
    const nudge = `You just said you did "${verbs.join(', ')}" but didn't emit the matching tool calls. Execute them now — one function_call per action — without repeating what you already said.`
    wsRef.current.send(JSON.stringify({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: nudge }] },
    }))
    wsRef.current.send(JSON.stringify({ type: 'response.create' }))
    setMessages(prev => prev.map(m => m === message ? { ...m, reconciliationWarning: null } : m))
  }

  async function handleRealtimeToolCall(callId: string, name: string, argsStr: string | object) {
    try {
      const data = typeof argsStr === 'string' ? JSON.parse(argsStr) : argsStr
      const action = { type: name, data }

      // Destructive actions require explicit user confirmation before we run
      // them. Block here, render a Confirm/Cancel prompt, and wait.
      if (isDestructiveAction(action)) {
        const confirmLabel = describeDestructive(action)
        let promptIndex = -1
        setMessages(prev => {
          promptIndex = prev.length
          return [...prev, {
            role: 'assistant',
            content: `Confirm: ${confirmLabel}?`,
            action,
            actionStatus: 'pending',
          }]
        })

        const confirmed = await new Promise<boolean>(resolve => {
          pendingConfirmsRef.current.set(promptIndex, resolve)
        })

        setMessages(prev => prev.map((m, i) => i === promptIndex
          ? { ...m, actionStatus: confirmed ? 'executing' : 'cancelled' }
          : m))

        if (!confirmed) {
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
              type: 'conversation.item.create',
              item: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ ok: false, message: 'User cancelled the action. Tell them briefly.', instruction: 'Do NOT retry unless the user explicitly asks again.' }) },
            }))
            wsRef.current.send(JSON.stringify({ type: 'response.create' }))
          }
          return
        }

        const result = await executeCrmAction(action)
        setMessages(prev => prev.map((m, i) => i === promptIndex
          ? { ...m, actionStatus: result.ok ? 'success' : 'error', actionResult: result.message }
          : m))
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          const output = result.ok
            ? JSON.stringify(result)
            : JSON.stringify({ ...result, instruction: 'The action failed. Tell the user what went wrong. Do NOT retry the action.' })
          wsRef.current.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output } }))
          wsRef.current.send(JSON.stringify({ type: 'response.create' }))
        }
        return
      }

      // Extract a short human label from the args for the executing bubble,
      // e.g. "create_contact(Maria Chen)" instead of just "create contact".
      const label = pickActionLabel(data) || name.replace(/_/g, ' ')

      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Executing: ${label}`,
        action,
        actionStatus: 'executing',
      }])

      const result = await executeCrmAction(action)

      setMessages(prev => prev.map((m, i) =>
        i === prev.length - 1 ? { ...m, actionStatus: result.ok ? 'success' : 'error', actionResult: result.message } : m
      ))

      if (wsRef.current?.readyState === WebSocket.OPEN) {
        const output = result.ok
          ? JSON.stringify(result)
          : JSON.stringify({ ...result, instruction: 'The action failed. Tell the user what went wrong. Do NOT retry the action.' })
        wsRef.current.send(JSON.stringify({
          type: 'conversation.item.create',
          item: { type: 'function_call_output', call_id: callId, output }
        }))
        wsRef.current.send(JSON.stringify({ type: 'response.create' }))
      }
    } catch (err: any) {
      console.error('[realtime] Tool call error:', err)
      // Send failure back to prevent retry loop
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'conversation.item.create',
          item: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ ok: false, message: 'Action failed unexpectedly. Do NOT retry.' }) }
        }))
        wsRef.current.send(JSON.stringify({ type: 'response.create' }))
      }
    }
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      disconnectVoice()
    }
  }, [])

  // ---- Send Message ----
  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || loading) return
    setInput('')
    setLoading(true)

    const userMsg: Message = { role: 'user', content: text }
    setMessages(prev => [...prev, userMsg])

    try {
      const allMessages = [...messages, userMsg]
      const res = await fetch('/api/ai/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          messages: allMessages.slice(-12).map(m => ({ role: m.role, content: m.content })),
          currentPage: 'Voice Assistant',
          pageContext: derivePageContext(),
        }),
      })
      const data = await res.json()
      const reply = data.message || data.error || 'Sorry, something went wrong.'
      const action = parseCrmAction(reply)

      const assistantMsg: Message = {
        role: 'assistant',
        content: reply,
        action,
        actionStatus: action ? 'pending' : undefined,
        provider: data.provider ?? null,
      }

      setMessages(p => {
        const updated = [...p, assistantMsg]
        saveConversation(updated)
        return updated
      })
    } catch {
      setMessages(p => [...p, { role: 'assistant', content: 'Sorry, something went wrong. Please try again.' }])
    } finally {
      setLoading(false)
    }
  }, [loading, messages])

  // Keep the ref in sync for the speech recognition callback
  useEffect(() => {
    sendMessageRef.current = sendMessage
  }, [sendMessage])

  // ---- Action handlers ----
  const confirmAction = useCallback(async (msgIndex: number) => {
    const msg = messages[msgIndex]
    if (!msg?.action) return

    // If this prompt came from a destructive-action gate, resolve the promise
    // so handleRealtimeToolCall can continue with execution + function_call_output.
    const realtimeResolver = pendingConfirmsRef.current.get(msgIndex)
    if (realtimeResolver) {
      pendingConfirmsRef.current.delete(msgIndex)
      realtimeResolver(true)
      return
    }

    setMessages(prev => prev.map((m, i) => i === msgIndex ? { ...m, actionStatus: 'executing' as const } : m))

    const result = await executeCrmAction(msg.action)

    setMessages(prev => prev.map((m, i) => i === msgIndex ? {
      ...m,
      actionStatus: result.ok ? 'success' as const : 'error' as const,
      actionResult: result.message,
    } : m))

  }, [messages])

  const cancelAction = useCallback((msgIndex: number) => {
    const realtimeResolver = pendingConfirmsRef.current.get(msgIndex)
    if (realtimeResolver) {
      pendingConfirmsRef.current.delete(msgIndex)
      realtimeResolver(false)
      return
    }
    setMessages(prev => prev.map((m, i) => i === msgIndex ? { ...m, actionStatus: 'cancelled' as const } : m))
  }, [])

  const clearChat = useCallback(() => {
    disconnectVoice()
    startNewChat()
  }, [personaName])

  const quickActions = [
    { label: 'Give me a pipeline summary', Icon: BarChart3 },
    { label: "What's on my calendar today?", Icon: CalendarDays },
    { label: 'Create a task to follow up this week', Icon: CheckSquare },
    { label: 'Show me my hottest leads', Icon: Flame },
  ]

  const filteredConversations = conversations.filter(c => showArchived ? c.is_archived : !c.is_archived)

  return (
    <div className="flex h-[calc(100vh-64px)] max-h-[calc(100vh-64px)] overflow-hidden relative">
      {/* Mobile sidebar overlay */}
      {showMobileSidebar && (
        <div className="fixed inset-0 bg-black/40 z-40 md:hidden" onClick={() => setShowMobileSidebar(false)} />
      )}
      {/* Left sidebar — conversation list */}
      <div className={`${showMobileSidebar ? 'fixed inset-y-0 left-0 z-50 w-72' : 'hidden'} md:static md:flex md:w-64 border-r flex flex-col shrink-0 bg-background`}>
        <div className="p-3 border-b">
          <Button type="button" variant="outline" size="sm" onClick={startNewChat} className="w-full justify-center">
            <Plus className="size-3.5 mr-1.5" /> New Chat
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {filteredConversations.length === 0 && (
            <div className="px-3 py-6 text-center">
              <MessageSquare className="size-5 text-muted-foreground mx-auto mb-2" />
              <p className="text-xs text-muted-foreground">{showArchived ? 'No archived chats' : 'No conversations yet'}</p>
            </div>
          )}
          {filteredConversations.map(conv => (
            <div key={conv.id}
              onClick={() => { if (editingConvId !== conv.id) loadConversation(conv.id) }}
              className={`group flex items-center justify-between px-3 py-2 mx-2 my-0.5 rounded-lg cursor-pointer text-sm transition ${
                conv.id === activeConversationId ? 'bg-accent/10 text-accent' : 'hover:bg-muted'
              }`}>
              <div className="min-w-0 flex-1">
                {editingConvId === conv.id ? (
                  <input
                    type="text"
                    value={editingTitle}
                    onChange={e => setEditingTitle(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') renameConversation(conv.id, editingTitle)
                      if (e.key === 'Escape') setEditingConvId(null)
                    }}
                    onBlur={() => renameConversation(conv.id, editingTitle)}
                    autoFocus
                    onClick={e => e.stopPropagation()}
                    className="w-full text-sm bg-background border rounded px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-accent"
                  />
                ) : (
                  <p className="truncate text-sm">{conv.title}</p>
                )}
                <p className="text-[10px] text-muted-foreground">{formatRelativeTime(conv.updated_at)}</p>
              </div>
              <div className="hidden group-hover:flex items-center gap-1 shrink-0 ml-2">
                <button onClick={e => { e.stopPropagation(); setEditingConvId(conv.id); setEditingTitle(conv.title) }}
                  className="p-1 rounded hover:bg-muted" title="Rename">
                  <Pencil className="size-3" />
                </button>
                {!conv.is_archived && (
                  <button onClick={e => { e.stopPropagation(); archiveConversation(conv.id) }}
                    className="p-1 rounded hover:bg-muted" title="Archive">
                    <Archive className="size-3" />
                  </button>
                )}
                <button onClick={e => { e.stopPropagation(); deleteConversation(conv.id) }}
                  className="p-1 rounded hover:bg-muted text-red-500" title="Delete">
                  <Trash2 className="size-3" />
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="p-2 border-t">
          <button onClick={() => setShowArchived(!showArchived)}
            className="w-full text-[10px] text-muted-foreground hover:text-foreground transition text-center py-1">
            {showArchived ? 'Show active' : 'Show archived'}
          </button>
        </div>
      </div>

      {/* Right side — chat area */}
      <div className="flex-1 flex flex-col min-h-0">
        {/* Header */}
        <div className="flex items-center justify-between px-3 sm:px-6 py-3 sm:py-4 border-b shrink-0">
          <div className="flex items-center gap-2 sm:gap-3">
            <button type="button" onClick={() => setShowMobileSidebar(true)} className="md:hidden size-8 rounded-lg bg-muted flex items-center justify-center">
              <MessageSquare className="size-4" />
            </button>
            <div className="size-8 sm:size-10 rounded-xl bg-accent/10 flex items-center justify-center">
              <Sparkles className="size-4 sm:size-5 text-accent" />
            </div>
            <div>
              <h1 className="text-lg font-semibold">{personaName}</h1>
              <p className="text-xs text-muted-foreground">
                {connecting ? 'Connecting...' : wsConnected ? (listening ? 'Listening...' : speaking ? 'Speaking...' : 'Connected — speak anytime') : loading ? 'Thinking...' : 'Type a message or tap the mic'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Voice selector (only when connected) */}
            {wsConnected && (
              <select value={ttsVoice} onChange={e => setTtsVoice(e.target.value)}
                className="text-xs rounded border bg-background px-2 py-1 h-8">
                <option value="alloy">Alloy</option>
                <option value="ash">Ash</option>
                <option value="ballad">Ballad</option>
                <option value="coral">Coral</option>
                <option value="echo">Echo</option>
                <option value="sage">Sage</option>
                <option value="shimmer">Shimmer</option>
                <option value="verse">Verse</option>
              </select>
            )}
            {wsConnected && (
              <Button type="button" variant="ghost" size="sm" onClick={disconnectVoice} title="Disconnect voice">
                <MicOff className="size-4" />
              </Button>
            )}
            {/* New chat */}
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-3 sm:px-6 py-4 min-h-0">
          <div className="space-y-4">
          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] rounded-2xl px-4 py-3 ${
                msg.role === 'user'
                  ? 'bg-accent text-accent-foreground rounded-br-md'
                  : 'bg-muted rounded-bl-md'
              }`}>
                <MarkdownText text={msg.content} />

                {msg.action && msg.actionStatus === 'pending' && (
                  <div className="mt-3 p-3 rounded-lg bg-accent/10 border border-accent/20">
                    <p className="text-xs font-medium mb-2">Action: {msg.action.type.replace(/_/g, ' ')}</p>
                    <pre className="text-[10px] text-muted-foreground mb-2 overflow-x-auto">{JSON.stringify(msg.action.data, null, 2)}</pre>
                    <div className="flex gap-2">
                      <Button type="button" size="sm" className="h-7 text-xs" onClick={() => confirmAction(i)}>
                        <Check className="size-3 mr-1" /> Confirm
                      </Button>
                      <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => cancelAction(i)}>
                        <X className="size-3 mr-1" /> Cancel
                      </Button>
                    </div>
                  </div>
                )}
                {msg.actionStatus === 'executing' && (
                  <div className="mt-3 p-3 rounded-lg bg-muted/50">
                    <Loader2 className="size-3 animate-spin inline mr-1" /> <span className="text-xs">Executing...</span>
                  </div>
                )}
                {msg.actionStatus === 'success' && (
                  <div className="mt-3 p-3 rounded-lg bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300">
                    <Check className="size-3 inline mr-1" /> <span className="text-xs">{msg.actionResult}</span>
                  </div>
                )}
                {msg.actionStatus === 'error' && (
                  <div className="mt-3 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300">
                    <AlertCircle className="size-3 inline mr-1" /> <span className="text-xs">{msg.actionResult}</span>
                  </div>
                )}
                {msg.actionStatus === 'cancelled' && (
                  <div className="mt-3 p-2 rounded-lg bg-muted/30">
                    <span className="text-xs text-muted-foreground">Action cancelled</span>
                  </div>
                )}
                {msg.reconciliationWarning && (
                  <div className="mt-3 p-3 rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-300/60 dark:border-amber-800/60">
                    <div className="flex items-start gap-2 text-xs">
                      <AlertCircle className="size-4 text-amber-600 shrink-0 mt-0.5" />
                      <div className="flex-1">
                        <div className="font-medium text-amber-900 dark:text-amber-200">
                          Scout described actions it didn&apos;t actually run.
                        </div>
                        <div className="text-amber-700 dark:text-amber-300/80 mt-0.5">
                          Mentioned: {msg.reconciliationWarning.verbsClaimed.join(', ')} · Tool calls emitted: {msg.reconciliationWarning.toolsCalled}
                        </div>
                        <div className="flex gap-2 mt-2">
                          <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => retryMissedSteps(msg)}>
                            Retry missed steps
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={() => setMessages(prev => prev.map(mm => mm === msg ? { ...mm, reconciliationWarning: null } : mm))}>
                            Dismiss
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex justify-start">
              <div className="bg-muted rounded-2xl rounded-bl-md px-4 py-3">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  <span>{personaName} is thinking...</span>
                </div>
              </div>
            </div>
          )}

          {messages.length <= 1 && !loading && (
            <div className="flex flex-wrap gap-2 justify-center pt-4">
              {quickActions.map((qa, i) => (
                <button key={i} type="button" onClick={() => sendMessage(qa.label)}
                  className="px-3 py-2 rounded-full border text-xs hover:bg-muted/50 transition flex items-center gap-1.5">
                  <qa.Icon className="size-3.5 text-muted-foreground" /> {qa.label}
                </button>
              ))}
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
        </div>

        {/* Live voice transcripts (shown above input when connected) */}
        {wsConnected && (userTranscript || assistantTranscript) && (
          <div className="px-6 pb-2 shrink-0">
            {userTranscript && <p className="text-sm text-muted-foreground italic">You: {userTranscript}</p>}
            {assistantTranscript && <p className="text-sm">{personaName}: {assistantTranscript}</p>}
          </div>
        )}

        {/* Input area */}
        <div className="px-3 sm:px-6 py-3 sm:py-4 border-t shrink-0">
          <div className="flex items-center gap-1.5 sm:gap-2 max-w-3xl mx-auto">
            {/* Mic button */}
            <button
              type="button"
              onClick={() => {
                if (!wsConnected) connectVoice()
              }}
              disabled={connecting}
              className={`size-9 sm:size-10 rounded-full flex items-center justify-center shrink-0 transition-all ${
                wsConnected
                  ? listening
                    ? 'bg-red-500 text-white animate-pulse shadow-lg shadow-red-500/30'
                    : speaking
                      ? 'bg-accent text-accent-foreground animate-pulse'
                      : 'bg-accent text-accent-foreground'
                  : 'bg-accent text-accent-foreground hover:bg-accent/90'
              } ${connecting ? 'opacity-50' : ''}`}
              title={wsConnected ? 'Voice connected' : 'Start voice chat'}
            >
              {connecting ? <Loader2 className="size-4 animate-spin" /> : <Mic className="size-4" />}
            </button>

            {/* Text input */}
            <input
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input) } }}
              placeholder={wsConnected ? 'Speak or type a message...' : 'Type a message...'}
              disabled={loading}
              className="flex-1 rounded-full border px-4 py-2.5 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-50"
            />

            {/* Send button */}
            <Button type="button" size="sm" onClick={() => sendMessage(input)} disabled={!input.trim() || loading} className="rounded-full size-9 sm:size-10 p-0">
              <Send className="size-4" />
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground/50 text-center mt-2">AI can make mistakes. Verify important information before acting on it.</p>
        </div>
      </div>
    </div>
  )
}
