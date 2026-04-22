'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { X, Send, Loader2, Sparkles, Check, XCircle, Trash2, Maximize2, Minimize2, BarChart3, Calendar, CheckSquare, Zap } from 'lucide-react'
import { useRouter } from 'next/navigation'

type CrmAction = {
  type: string
  data: Record<string, any>
}

// Parse window.location.pathname for known entity detail URLs so the
// assistant can default to the entity the user is currently looking at.
function derivePageContextFromCurrent(): { entityType?: string; entityId?: string; pathname?: string } | null {
  if (typeof window === 'undefined') return null
  const path = window.location.pathname
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

type Message = {
  role: 'user' | 'assistant'
  content: string
  action?: CrmAction
  actionStatus?: 'pending' | 'executing' | 'success' | 'error'
  actionResult?: string
}

// Extract ALL crm-action code blocks from the assistant's response so a
// multi-step request ("add Maria then create a deal") can render each step
// as its own pending confirmation instead of losing steps after the first.
// Accepts both the canonical {"type":"X","data":{...}} shape and the flat
// form Gemini sometimes emits ({"type":"X","contactId":"...","content":"..."})
// because a strict check drops valid actions silently.
function parseCrmActions(text: string): { cleanText: string; actions: CrmAction[] } {
  const actionRegex = /```crm-action\s*\n?([\s\S]*?)\n?```/g
  const actions: CrmAction[] = []
  let cleanText = text
  const matches = text.matchAll(actionRegex)
  for (const match of matches) {
    try {
      const parsed = JSON.parse(match[1].trim())
      if (!parsed?.type) continue
      if (parsed.data && typeof parsed.data === 'object') {
        actions.push({ type: parsed.type, data: parsed.data })
      } else {
        // Flatten the non-type fields into data — Gemini occasionally drops
        // the nesting even though the prompt specifies it.
        const { type, ...rest } = parsed
        actions.push({ type, data: rest })
      }
    } catch {}
  }
  if (actions.length > 0) {
    cleanText = text.replace(actionRegex, '').trim()
  }
  return { cleanText, actions }
}

// Back-compat wrapper — some callers only need the first action
function parseCrmAction(text: string): { cleanText: string; action: CrmAction | null } {
  const { cleanText, actions } = parseCrmActions(text)
  return { cleanText, action: actions[0] || null }
}

function getActionLabel(action: CrmAction): string {
  switch (action.type) {
    case 'create_contact':
      return `Create contact: ${action.data.name || 'Unknown'}${action.data.email ? ` (${action.data.email})` : ''}`
    case 'create_task':
      return `Create task: ${action.data.title || 'Untitled'}`
    case 'add_note':
      return `Add note to contact`
    case 'add_tag':
      return `Add tag: ${action.data.tagName || 'Unknown'}`
    case 'create_deal':
      return `Create deal: ${action.data.title || 'Untitled'}${action.data.value ? ` ($${action.data.value})` : ''}`
    case 'send_email':
      return `Send email to ${action.data.to || 'Unknown'}: ${action.data.subject || 'No subject'}`
    case 'move_deal_stage':
      return `Move deal to stage: ${action.data.stage || 'Unknown'}`
    case 'move_contact_stage':
      return `Move ${action.data.contactName || 'contact'} to "${action.data.stage || 'Unknown'}" stage`
    case 'remove_contact_from_pipeline':
      return `Remove ${action.data.contactName || 'contact'} from pipeline (keeps contact)`
    case 'create_invoice':
      return `Create invoice${action.data.contactName ? ` for ${action.data.contactName}` : ''}: ${action.data.items?.length || 0} item(s)`
    case 'create_product':
      return `Create product: ${action.data.name || 'Untitled'} ($${action.data.price || 0})`
    default:
      return `Action: ${action.type}`
  }
}

type ActionResult = { success: boolean; message: string; contactId?: string; contactName?: string }

// Resolve a contact name to its UUID. display_name is encrypted in the DB, so
// the server-side ILIKE search returns nothing — fetch the first 100 contacts
// (the CRUD factory decrypts them in the response) and filter in memory.
async function resolveContactIdByName(name: string): Promise<string | null> {
  if (!name) return null
  const needle = name.toLowerCase().trim()
  // Try the cheap server search first in case decrypted query indexes land
  try {
    const r = await fetch(`/api/customers/people?search=${encodeURIComponent(name)}&pageSize=5`, { credentials: 'include' })
    const d = await r.json()
    const items: any[] = d.items || []
    if (items.length) {
      const exact = items.find((c: any) => (c.display_name || '').toLowerCase() === needle)
      return exact?.id || items[0].id
    }
  } catch {}
  // Fallback: full fetch + in-memory filter
  try {
    const r = await fetch('/api/customers/people?pageSize=100', { credentials: 'include' })
    const d = await r.json()
    const pool: any[] = d.items || []
    const exact = pool.find((c) => (c.display_name || '').toLowerCase() === needle)
    if (exact) return exact.id
    const partial = pool.find((c) => (c.display_name || '').toLowerCase().includes(needle))
    return partial?.id || null
  } catch {
    return null
  }
}

async function executeCrmAction(action: CrmAction): Promise<ActionResult> {
  try {
    switch (action.type) {
      case 'create_contact': {
        const fullName = String(action.data.name || 'New Contact').trim()
        const parts = fullName.split(/\s+/)
        const firstName = parts[0] || ''
        const lastName = parts.length > 1 ? parts.slice(1).join(' ') : ''
        const email = String(action.data.email || '').trim()
        const phone = String(action.data.phone || '').trim()
        // primaryEmail is validated as .email() — only send if non-empty.
        // Same for phone to avoid triggering overly-strict validators.
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
        const data = await res.json().catch(() => ({}))
        if (data.id) {
          return { success: true, message: `Contact "${fullName}" created!`, contactId: data.id, contactName: fullName }
        }
        return { success: false, message: data.error || 'Failed to create contact' }
      }
      case 'create_task': {
        const res = await fetch('/api/customers/tasks', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ title: action.data.title, contactId: action.data.contactId || null, dueDate: action.data.dueDate || null }),
        })
        const data = await res.json()
        if (data.ok) return { success: true, message: `Task "${action.data.title}" created!` }
        return { success: false, message: data.error || 'Failed to create task' }
      }
      case 'add_note': {
        if (!action.data.contactId) return { success: false, message: 'Contact ID required for adding a note' }
        const res = await fetch('/api/customers/notes', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ contactId: action.data.contactId, content: action.data.content }),
        })
        const data = await res.json()
        if (data.ok) return { success: true, message: 'Note added!' }
        return { success: false, message: data.error || 'Failed to add note' }
      }
      case 'add_tag': {
        if (!action.data.contactId) return { success: false, message: 'Contact ID required for adding a tag' }
        const res = await fetch('/api/crm-contact-tags', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ contactId: action.data.contactId, tagName: action.data.tagName }),
        })
        const data = await res.json()
        if (data.ok) return { success: true, message: `Tag "${action.data.tagName}" added!` }
        return { success: false, message: data.error || 'Failed to add tag' }
      }
      case 'create_deal': {
        const res = await fetch('/api/pipeline/journey', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ title: action.data.title, contactId: action.data.contactId || null, value: action.data.value || null }),
        })
        const data = await res.json()
        if (data.ok) return { success: true, message: `Deal "${action.data.title}" created!` }
        return { success: false, message: data.error || 'Failed to create deal' }
      }
      case 'send_email': {
        const res = await fetch('/api/email/smtp', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ to: action.data.to, subject: action.data.subject, body: action.data.body }),
        })
        const data = await res.json()
        if (data.ok) return { success: true, message: `Email sent to ${action.data.to}!` }
        return { success: false, message: data.error || 'Failed to send email' }
      }
      case 'move_deal_stage': {
        if (!action.data.dealId) return { success: false, message: 'Deal ID required' }
        const res = await fetch('/api/customers/deals', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ id: action.data.dealId, pipelineStage: action.data.stage }),
        })
        const data = await res.json()
        if (data.id || data.ok) return { success: true, message: `Deal moved to "${action.data.stage}"!` }
        return { success: false, message: data.error || 'Failed to move deal' }
      }
      case 'move_contact_stage': {
        // Journey mode — update a CONTACT's lifecycle_stage. Accepts a
        // contactId or a contactName we resolve via the people search.
        let contactId: string | null = action.data.contactId || null
        const stage = action.data.stage
        if (!stage) return { success: false, message: 'Stage is required' }
        if (!contactId && action.data.contactName) {
          contactId = await resolveContactIdByName(action.data.contactName)
        }
        if (!contactId) return { success: false, message: `Contact "${action.data.contactName || action.data.contactId || 'unknown'}" not found.` }
        const res = await fetch('/api/pipeline/journey', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ contactId, stage }),
        })
        const data = await res.json()
        if (data.ok) return { success: true, message: `Moved to "${stage}".` }
        return { success: false, message: data.error || 'Failed to move contact' }
      }
      case 'create_invoice': {
        const items = action.data.items || []
        if (items.length === 0) return { success: false, message: 'At least one line item is required' }
        const res = await fetch('/api/payments/invoices', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ lineItems: items.map((i: any) => ({ name: i.name, price: Number(i.price), quantity: Number(i.quantity) || 1 })), notes: action.data.notes || undefined, dueDate: action.data.dueDate || undefined }),
        })
        const data = await res.json()
        if (data.ok) return { success: true, message: `Invoice created! (${data.data?.invoice_number || 'New'})` }
        return { success: false, message: data.error || 'Failed to create invoice' }
      }
      case 'create_product': {
        if (!action.data.name || !action.data.price) return { success: false, message: 'Product name and price are required' }
        const res = await fetch('/api/payments/products', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ name: action.data.name, description: action.data.description || undefined, price: Number(action.data.price), billingType: action.data.billingType || 'one_time', trialDays: action.data.trialDays ? Number(action.data.trialDays) : undefined }),
        })
        const data = await res.json()
        if (data.ok) return { success: true, message: `Product "${action.data.name}" created!` }
        return { success: false, message: data.error || 'Failed to create product' }
      }
      case 'remove_contact_from_pipeline': {
        // Journey-mode "remove X from pipeline" — clears lifecycle_stage so
        // the contact disappears from the pipeline board but stays in
        // Contacts. NOT the same as delete_contact.
        let contactId: string | null = action.data.contactId || null
        if (!contactId && action.data.contactName) {
          contactId = await resolveContactIdByName(action.data.contactName)
        }
        if (!contactId) return { success: false, message: `Contact "${action.data.contactName || 'unknown'}" not found.` }
        const res = await fetch('/api/pipeline/journey', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ contactId, stage: null }),
        })
        const data = await res.json()
        if (data.ok) return { success: true, message: `Removed from pipeline. Contact is still in your Contacts list.` }
        return { success: false, message: data.error || 'Failed to remove from pipeline' }
      }
      case 'delete_contact': {
        if (!action.data.contactId) return { success: false, message: 'Contact ID required' }
        const res = await fetch(`/api/customers/people?id=${encodeURIComponent(action.data.contactId)}`, { method: 'DELETE', credentials: 'include' })
        const data = await res.json().catch(() => ({}))
        if (res.ok) return { success: true, message: 'Contact deleted.' }
        return { success: false, message: data.error || 'Failed to delete contact' }
      }
      case 'delete_company': {
        // Resolve by name if no ID given. Company display_name may be
        // encrypted too, so fetch-and-filter just like contacts.
        let companyId: string | null = action.data.companyId || null
        const name = String(action.data.companyName || action.data.name || '').trim()
        if (!companyId && name) {
          try {
            const r = await fetch('/api/customers/companies?pageSize=100', { credentials: 'include' })
            const d = await r.json()
            const pool: any[] = d.items || []
            const needle = name.toLowerCase()
            const exact = pool.find((c: any) => (c.display_name || c.name || '').toLowerCase() === needle)
            companyId = exact?.id || pool.find((c: any) => (c.display_name || c.name || '').toLowerCase().includes(needle))?.id || null
          } catch {}
        }
        if (!companyId) return { success: false, message: `Company "${name || 'unknown'}" not found.` }
        const res = await fetch(`/api/customers/companies?id=${encodeURIComponent(companyId)}`, { method: 'DELETE', credentials: 'include' })
        const data = await res.json().catch(() => ({}))
        if (res.ok) return { success: true, message: 'Company deleted.' }
        return { success: false, message: data.error || 'Failed to delete company' }
      }
      case 'delete_deal': {
        if (!action.data.dealId) return { success: false, message: 'Deal ID required' }
        const res = await fetch(`/api/customers/deals?id=${encodeURIComponent(action.data.dealId)}`, { method: 'DELETE', credentials: 'include' })
        const data = await res.json().catch(() => ({}))
        if (res.ok) return { success: true, message: 'Deal deleted.' }
        return { success: false, message: data.error || 'Failed to delete deal' }
      }
      case 'delete_task': {
        if (!action.data.taskId) return { success: false, message: 'Task ID required' }
        const res = await fetch(`/api/customers/tasks?id=${encodeURIComponent(action.data.taskId)}`, { method: 'DELETE', credentials: 'include' })
        const data = await res.json().catch(() => ({}))
        if (res.ok) return { success: true, message: 'Task deleted.' }
        return { success: false, message: data.error || 'Failed to delete task' }
      }
      case 'delete_product': {
        if (!action.data.productId) return { success: false, message: 'Product ID required' }
        const res = await fetch(`/api/payments/products?id=${encodeURIComponent(action.data.productId)}`, { method: 'DELETE', credentials: 'include' })
        const data = await res.json().catch(() => ({}))
        if (res.ok) return { success: true, message: 'Product deleted.' }
        return { success: false, message: data.error || 'Failed to delete product' }
      }
      default:
        return { success: false, message: `Unknown action type: ${action.type}` }
    }
  } catch {
    return { success: false, message: 'Network error. Please try again.' }
  }
}

// Render markdown text with bold, italic, links, and lists
function MarkdownText({ text, onNavigate }: { text: string; onNavigate: (path: string) => void }) {
  const lines = text.split('\n')
  return (
    <>
      {lines.map((line, i) => {
        const trimmed = line.trim()
        if (!trimmed) return <div key={i} className="h-1.5" />

        // Bullet list
        const isBullet = /^[-*]\s/.test(trimmed)
        const content = isBullet ? trimmed.replace(/^[-*]\s/, '') : trimmed

        // Process inline markdown: bold, italic, links
        const parts: Array<{ type: 'text' | 'bold' | 'italic' | 'link'; text: string; href?: string }> = []
        let remaining = content
        const inlineRegex = /(\*\*(.+?)\*\*|\*(.+?)\*|\[(.+?)\]\((.+?)\))/
        while (remaining) {
          const match = remaining.match(inlineRegex)
          if (!match || match.index === undefined) {
            if (remaining) parts.push({ type: 'text', text: remaining })
            break
          }
          if (match.index > 0) parts.push({ type: 'text', text: remaining.substring(0, match.index) })
          if (match[2]) parts.push({ type: 'bold', text: match[2] })
          else if (match[3]) parts.push({ type: 'italic', text: match[3] })
          else if (match[4] && match[5]) parts.push({ type: 'link', text: match[4], href: match[5] })
          remaining = remaining.substring(match.index + match[0].length)
        }

        const rendered = parts.map((p, j) => {
          if (p.type === 'bold') return <strong key={j}>{p.text}</strong>
          if (p.type === 'italic') return <em key={j}>{p.text}</em>
          if (p.type === 'link' && p.href) {
            const isInternal = p.href.startsWith('/')
            if (isInternal) {
              return (
                <button key={j} type="button"
                  onClick={() => onNavigate(p.href!)}
                  className="text-accent underline underline-offset-2 hover:text-accent/80 font-medium">
                  {p.text}
                </button>
              )
            }
            return <a key={j} href={p.href} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2 hover:text-accent/80">{p.text}</a>
          }
          return <span key={j}>{p.text}</span>
        })

        if (isBullet) {
          return (
            <div key={i} className={`flex gap-1.5 ${i > 0 ? 'mt-0.5' : ''}`}>
              <span className="text-muted-foreground shrink-0 mt-px">&#8226;</span>
              <span>{rendered}</span>
            </div>
          )
        }

        return <p key={i} className={i > 0 ? 'mt-1' : ''}>{rendered}</p>
      })}
    </>
  )
}

export function AiAssistantWidget() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [personaName, setPersonaName] = useState('Scout')
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const personaLoaded = useRef(false)

  function getGreeting(name: string) {
    return `Hey! I'm ${name}. I can answer questions about your CRM data, help you navigate features, or do things like create contacts, tasks, invoices, and more. What can I help with?`
  }

  useEffect(() => {
    if (personaLoaded.current) return
    personaLoaded.current = true
    fetch('/api/customers/business-profile', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        const name = d.ok && d.data?.ai_persona_name ? d.data.ai_persona_name : 'Scout'
        setPersonaName(name)
        setMessages([{ role: 'assistant', content: getGreeting(name) }])
      })
      .catch(() => {
        setMessages([{ role: 'assistant', content: getGreeting('Scout') }])
      })
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  function clearChat() {
    setMessages([{ role: 'assistant', content: getGreeting(personaName) }])
  }

  function handleNavigate(path: string) {
    router.push(path)
    setOpen(false)
  }

  const handleActionConfirm = useCallback(async (messageIndex: number) => {
    setMessages(prev => {
      const updated = [...prev]
      if (updated[messageIndex]) updated[messageIndex] = { ...updated[messageIndex], actionStatus: 'executing' }
      return updated
    })
    const msg = messages[messageIndex]
    if (!msg?.action) return
    const result = await executeCrmAction(msg.action)
    setMessages(prev => {
      const updated = [...prev]
      if (updated[messageIndex]) updated[messageIndex] = { ...updated[messageIndex], actionStatus: result.success ? 'success' : 'error', actionResult: result.message }

      // If we just created a contact, patch any later pending actions that
      // reference this contact by name — otherwise the second step's
      // search-by-name often fails because the new record isn't indexed
      // yet, or Gemini emitted a slightly different name in the second
      // block ("Brian Johnson" → "Brian Howard").
      if (result.success && msg.action?.type === 'create_contact' && result.contactId) {
        const createdFirstName = String(result.contactName || '').split(/\s+/)[0]?.toLowerCase() || ''
        for (let i = messageIndex + 1; i < updated.length; i++) {
          const m = updated[i]
          if (m.actionStatus !== 'pending' || !m.action) continue
          const { type, data } = m.action
          if (type === 'move_contact_stage' || type === 'add_note' || type === 'add_tag' || type === 'remove_tag' || type === 'create_task' || type === 'create_deal' || type === 'delete_contact' || type === 'update_contact') {
            const hasId = !!(data?.contactId)
            if (hasId) continue
            const targetName = String(data?.contactName || data?.name || '').trim()
            const targetFirst = targetName.split(/\s+/)[0]?.toLowerCase() || ''
            // Patch if no contactId is set AND either the target name matches
            // or has no name at all (relying on chain context).
            if (!targetName || !createdFirstName || targetFirst === createdFirstName) {
              updated[i] = { ...m, action: { ...m.action, data: { ...m.action.data, contactId: result.contactId, contactName: result.contactName } } }
            }
          }
        }
      }
      return updated
    })
  }, [messages])

  const handleActionCancel = useCallback((messageIndex: number) => {
    setMessages(prev => {
      const updated = [...prev]
      if (updated[messageIndex]) updated[messageIndex] = { ...updated[messageIndex], action: undefined, actionStatus: undefined, actionResult: 'Action cancelled.' }
      return updated
    })
  }, [])

  async function sendMessage(text: string) {
    if (!text.trim() || loading) return
    const userMsg: Message = { role: 'user', content: text.trim() }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    setInput('')
    setLoading(true)

    try {
      // Derive context from the current URL so Scout knows which entity the
      // user is looking at — "add a note" with no name attached defaults to
      // the contact/deal on screen instead of asking "which one?".
      const pageContext = derivePageContextFromCurrent()
      const res = await fetch('/api/ai/assistant', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({
          messages: newMessages.slice(-12).map(m => ({ role: m.role, content: m.content })),
          currentPage: document.title,
          pageContext,
        }),
      })
      const data = await res.json()
      const rawMessage = data.message || data.error || 'Something went wrong.'
      const { cleanText, actions } = parseCrmActions(rawMessage)
      const next: Message[] = [...newMessages]
      if (actions.length === 0) {
        next.push({ role: 'assistant', content: cleanText })
      } else {
        // Narrative first (if any), then one pending-confirmation message per action
        if (cleanText) next.push({ role: 'assistant', content: cleanText })
        for (const action of actions) {
          next.push({ role: 'assistant', content: '', action, actionStatus: 'pending' })
        }
      }
      setMessages(next)
    } catch {
      setMessages([...newMessages, { role: 'assistant', content: 'Connection error. Please try again.' }])
    } finally {
      setLoading(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage(input)
    }
  }

  const quickActions = [
    { label: 'Give me an overview of my CRM', Icon: BarChart3 },
    { label: 'How do I create an event?', Icon: Calendar },
    { label: 'Create a task to follow up this week', Icon: CheckSquare },
    { label: 'What features does this CRM have?', Icon: Zap },
  ]

  const panelSize = expanded
    ? 'w-[520px] h-[680px]'
    : 'w-[400px] h-[540px]'

  return (
    <>
      {/* Toggle button */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-5 right-5 z-50 w-12 h-12 rounded-full bg-accent text-white shadow-lg hover:shadow-xl transition-all hover:scale-105 flex items-center justify-center"
          aria-label={`Open ${personaName}`}
          title={personaName}
        >
          <Sparkles className="size-5" />
        </button>
      )}

      {/* Chat panel */}
      {open && (
        <div className={`fixed bottom-5 right-5 z-50 ${panelSize} rounded-2xl border bg-background shadow-2xl flex flex-col overflow-hidden transition-all duration-200`}>
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-2.5 border-b bg-card shrink-0">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-accent/10 flex items-center justify-center">
                <Sparkles className="size-3.5 text-accent" />
              </div>
              <div>
                <p className="text-sm font-semibold">{personaName}</p>
                <p className="text-[10px] text-muted-foreground">Ask me anything or give me a command</p>
              </div>
            </div>
            <div className="flex items-center gap-0.5">
              <button type="button" onClick={clearChat} title="Clear chat"
                className="w-7 h-7 rounded-md hover:bg-muted flex items-center justify-center text-muted-foreground hover:text-foreground transition">
                <Trash2 className="size-3.5" />
              </button>
              <button type="button" onClick={() => setExpanded(!expanded)} title={expanded ? 'Minimize' : 'Expand'}
                className="w-7 h-7 rounded-md hover:bg-muted flex items-center justify-center text-muted-foreground hover:text-foreground transition">
                {expanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
              </button>
              <button type="button" onClick={() => setOpen(false)} title="Close"
                className="w-7 h-7 rounded-md hover:bg-muted flex items-center justify-center text-muted-foreground hover:text-foreground transition">
                <X className="size-4" />
              </button>
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {msg.role === 'assistant' && (
                  <div className="max-w-[90%]">
                    <p className="text-[10px] text-muted-foreground mb-0.5 ml-1">{personaName}</p>
                    <div className="px-3 py-2 text-[13px] leading-relaxed bg-muted rounded-2xl rounded-bl-sm">
                      <MarkdownText text={msg.content} onNavigate={handleNavigate} />
                    </div>

                    {/* CRM Action Card */}
                    {msg.action && msg.actionStatus === 'pending' && (
                      <div className="mt-2 border rounded-lg px-3 py-2.5 bg-accent/5">
                        <p className="text-xs font-medium mb-2">{getActionLabel(msg.action)}</p>
                        <div className="flex gap-2">
                          <button type="button" onClick={() => handleActionConfirm(i)}
                            className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent/90 transition">
                            <Check className="size-3" /> Confirm
                          </button>
                          <button type="button" onClick={() => handleActionCancel(i)}
                            className="flex items-center gap-1 px-2.5 py-1 rounded-md border text-xs font-medium hover:bg-muted transition">
                            <XCircle className="size-3" /> Cancel
                          </button>
                        </div>
                      </div>
                    )}

                    {msg.action && msg.actionStatus === 'executing' && (
                      <div className="mt-2 border rounded-lg px-3 py-2.5 bg-accent/5">
                        <p className="text-xs flex items-center gap-1.5 text-muted-foreground">
                          <Loader2 className="size-3 animate-spin" /> Executing...
                        </p>
                      </div>
                    )}

                    {msg.actionStatus === 'success' && msg.actionResult && (
                      <div className="mt-2 border border-emerald-200 dark:border-emerald-900/50 rounded-lg px-3 py-2 bg-emerald-50 dark:bg-emerald-900/10">
                        <p className="text-xs text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
                          <Check className="size-3" /> {msg.actionResult}
                        </p>
                      </div>
                    )}

                    {msg.actionStatus === 'error' && msg.actionResult && (
                      <div className="mt-2 border border-red-200 dark:border-red-900/50 rounded-lg px-3 py-2 bg-red-50 dark:bg-red-900/10">
                        <p className="text-xs text-red-700 dark:text-red-400 flex items-center gap-1.5">
                          <XCircle className="size-3" /> {msg.actionResult}
                        </p>
                      </div>
                    )}

                    {!msg.action && msg.actionResult && (
                      <div className="mt-2 border rounded-lg px-3 py-2 bg-muted/50">
                        <p className="text-xs text-muted-foreground">{msg.actionResult}</p>
                      </div>
                    )}
                  </div>
                )}
                {msg.role === 'user' && (
                  <div className="max-w-[85%] px-3 py-2 text-[13px] leading-relaxed bg-accent text-white rounded-2xl rounded-br-sm">
                    {msg.content}
                  </div>
                )}
              </div>
            ))}
            {loading && (
              <div className="flex justify-start">
                <div className="bg-muted rounded-2xl rounded-bl-sm px-3 py-2 text-[13px] flex items-center gap-1.5 text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" /> {personaName} is thinking...
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />

            {/* Quick actions (only show when no user messages yet) */}
            {messages.length <= 1 && (
              <div className="space-y-1.5 pt-2">
                <p className="text-[11px] text-muted-foreground font-medium">Try asking:</p>
                {quickActions.map((qa) => (
                  <button key={qa.label} type="button"
                    onClick={() => sendMessage(qa.label)}
                    className="w-full text-left px-3 py-2 rounded-lg border text-xs hover:bg-muted transition flex items-center gap-2">
                    <qa.Icon className="size-3.5 text-accent shrink-0" /> {qa.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Input */}
          <div className="border-t px-3 py-2.5 shrink-0">
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask anything or give a command..."
                disabled={loading}
                className="flex-1 rounded-lg border bg-card px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-accent min-h-[36px] max-h-[80px]"
                rows={1}
              />
              <button type="button" onClick={() => sendMessage(input)} disabled={!input.trim() || loading}
                className="w-8 h-8 rounded-lg bg-accent text-white flex items-center justify-center disabled:opacity-50 shrink-0">
                <Send className="size-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
