'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { X, Send, Loader2, Sparkles, Check, XCircle } from 'lucide-react'

type CrmAction = {
  type: string
  data: Record<string, any>
}

type Message = {
  role: 'user' | 'assistant'
  content: string
  action?: CrmAction
  actionStatus?: 'pending' | 'executing' | 'success' | 'error'
  actionResult?: string
}

function parseCrmAction(text: string): { cleanText: string; action: CrmAction | null } {
  const actionRegex = /```crm-action\s*\n?([\s\S]*?)\n?```/
  const match = text.match(actionRegex)

  if (!match) return { cleanText: text, action: null }

  const cleanText = text.replace(actionRegex, '').trim()

  try {
    const action = JSON.parse(match[1].trim())
    if (action.type && action.data) {
      return { cleanText, action }
    }
  } catch {}

  return { cleanText: text, action: null }
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
    default:
      return `Action: ${action.type}`
  }
}

async function executeCrmAction(action: CrmAction): Promise<{ success: boolean; message: string }> {
  try {
    switch (action.type) {
      case 'create_contact': {
        const res = await fetch('/api/contacts/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            contacts: [{
              display_name: action.data.name,
              primary_email: action.data.email,
              primary_phone: action.data.phone || null,
              source: action.data.source || 'ai_assistant',
            }],
          }),
        })
        const data = await res.json()
        if (data.ok) return { success: true, message: `Contact "${action.data.name}" created successfully!` }
        return { success: false, message: data.error || 'Failed to create contact' }
      }

      case 'create_task': {
        const res = await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            title: action.data.title,
            contactId: action.data.contactId || null,
            dueDate: action.data.dueDate || null,
          }),
        })
        const data = await res.json()
        if (data.ok) return { success: true, message: `Task "${action.data.title}" created!` }
        return { success: false, message: data.error || 'Failed to create task' }
      }

      case 'add_note': {
        if (!action.data.contactId) return { success: false, message: 'Contact ID required for adding a note' }
        const res = await fetch('/api/notes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            contactId: action.data.contactId,
            content: action.data.content,
          }),
        })
        const data = await res.json()
        if (data.ok) return { success: true, message: 'Note added successfully!' }
        return { success: false, message: data.error || 'Failed to add note' }
      }

      case 'add_tag': {
        if (!action.data.contactId) return { success: false, message: 'Contact ID required for adding a tag' }
        const res = await fetch('/api/contact-tags', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            contactId: action.data.contactId,
            tagName: action.data.tagName,
          }),
        })
        const data = await res.json()
        if (data.ok) return { success: true, message: `Tag "${action.data.tagName}" added!` }
        return { success: false, message: data.error || 'Failed to add tag' }
      }

      case 'create_deal': {
        const res = await fetch('/api/pipeline/journey', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            title: action.data.title,
            contactId: action.data.contactId || null,
            value: action.data.value || null,
          }),
        })
        const data = await res.json()
        if (data.ok) return { success: true, message: `Deal "${action.data.title}" created!` }
        return { success: false, message: data.error || 'Failed to create deal' }
      }

      case 'send_email': {
        const res = await fetch('/api/email/smtp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            to: action.data.to,
            subject: action.data.subject,
            body: action.data.body,
          }),
        })
        const data = await res.json()
        if (data.ok) return { success: true, message: `Email sent to ${action.data.to}!` }
        return { success: false, message: data.error || 'Failed to send email' }
      }

      case 'move_deal_stage': {
        if (!action.data.dealId) return { success: false, message: 'Deal ID required' }
        const res = await fetch('/api/pipeline/journey', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            contactId: action.data.dealId,
            stage: action.data.stage,
          }),
        })
        const data = await res.json()
        if (data.ok) return { success: true, message: `Deal moved to "${action.data.stage}" stage!` }
        return { success: false, message: data.error || 'Failed to move deal' }
      }

      default:
        return { success: false, message: `Unknown action type: ${action.type}` }
    }
  } catch (err) {
    return { success: false, message: 'Network error. Please try again.' }
  }
}

export function AiAssistantWidget() {
  const [open, setOpen] = useState(false)
  const [personaName, setPersonaName] = useState('AI Assistant')
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const personaLoaded = useRef(false)

  useEffect(() => {
    if (personaLoaded.current) return
    personaLoaded.current = true
    fetch('/api/business-profile', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (d.ok && d.data?.ai_persona_name) {
          const name = d.data.ai_persona_name
          setPersonaName(name)
          setMessages([
            { role: 'assistant', content: `Hi! I'm ${name}, your CRM assistant. I can help you navigate the app, create contacts, build landing pages, and more. Try saying "Create a contact for John Smith at john@example.com" and I'll do it for you!` },
          ])
        } else {
          setMessages([
            { role: 'assistant', content: "Hi! I'm your CRM assistant. I can help you navigate the app, create contacts, manage tasks, and more. Try saying \"Create a task to follow up with the client\" and I'll do it for you!" },
          ])
        }
      })
      .catch(() => {
        setMessages([
          { role: 'assistant', content: "Hi! I'm your CRM assistant. I can help you navigate the app, create contacts, build landing pages, and more. What can I help with?" },
        ])
      })
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const handleActionConfirm = useCallback(async (messageIndex: number) => {
    setMessages(prev => {
      const updated = [...prev]
      if (updated[messageIndex]) {
        updated[messageIndex] = { ...updated[messageIndex], actionStatus: 'executing' }
      }
      return updated
    })

    const msg = messages[messageIndex]
    if (!msg?.action) return

    const result = await executeCrmAction(msg.action)

    setMessages(prev => {
      const updated = [...prev]
      if (updated[messageIndex]) {
        updated[messageIndex] = {
          ...updated[messageIndex],
          actionStatus: result.success ? 'success' : 'error',
          actionResult: result.message,
        }
      }
      return updated
    })
  }, [messages])

  const handleActionCancel = useCallback((messageIndex: number) => {
    setMessages(prev => {
      const updated = [...prev]
      if (updated[messageIndex]) {
        updated[messageIndex] = {
          ...updated[messageIndex],
          action: undefined,
          actionStatus: undefined,
          actionResult: 'Action cancelled.',
        }
      }
      return updated
    })
  }, [])

  async function send() {
    if (!input.trim() || loading) return
    const userMsg: Message = { role: 'user', content: input.trim() }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    setInput('')
    setLoading(true)

    try {
      const res = await fetch('/api/ai/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          messages: newMessages.slice(-10).map(m => ({ role: m.role, content: m.content })),
          currentPage: document.title,
        }),
      })
      const data = await res.json()
      const rawMessage = data.message || data.error || 'Something went wrong.'

      const { cleanText, action } = parseCrmAction(rawMessage)

      const assistantMsg: Message = {
        role: 'assistant',
        content: cleanText,
        action: action || undefined,
        actionStatus: action ? 'pending' : undefined,
      }

      setMessages([...newMessages, assistantMsg])
    } catch {
      setMessages([...newMessages, {
        role: 'assistant',
        content: 'Connection error. Please try again.',
      }])
    } finally {
      setLoading(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const quickActions = [
    { label: 'How do I add a contact?', icon: '👤' },
    { label: 'Create a task to follow up this week', icon: '✅' },
    { label: 'How do I create a deal?', icon: '💰' },
    { label: 'What can this CRM do?', icon: '✨' },
  ]

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
        <div className="fixed bottom-5 right-5 z-50 w-[380px] h-[520px] rounded-2xl border bg-background shadow-2xl flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b bg-card">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-accent/10 flex items-center justify-center">
                <Sparkles className="size-3.5 text-accent" />
              </div>
              <div>
                <p className="text-sm font-semibold">{personaName}</p>
                <p className="text-[10px] text-muted-foreground">Ask me anything or give me a command</p>
              </div>
            </div>
            <button type="button" onClick={() => setOpen(false)}
              className="w-7 h-7 rounded-md hover:bg-muted flex items-center justify-center text-muted-foreground hover:text-foreground">
              <X className="size-4" />
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {msg.role === 'assistant' && (
                  <div className="max-w-[85%]">
                    <p className="text-[10px] text-muted-foreground mb-0.5 ml-1">{personaName}</p>
                    <div className="px-3 py-2 text-[13px] leading-relaxed bg-muted rounded-2xl rounded-bl-sm">
                      {msg.content.split('\n').map((line, j) => {
                        const formatted = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                        return <p key={j} className={j > 0 ? 'mt-1' : ''} dangerouslySetInnerHTML={{ __html: formatted }} />
                      })}
                    </div>

                    {/* CRM Action Card */}
                    {msg.action && msg.actionStatus === 'pending' && (
                      <div className="mt-2 border rounded-lg px-3 py-2.5 bg-accent/5">
                        <p className="text-xs font-medium mb-2">{getActionLabel(msg.action)}</p>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => handleActionConfirm(i)}
                            className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent/90 transition"
                          >
                            <Check className="size-3" /> Confirm
                          </button>
                          <button
                            type="button"
                            onClick={() => handleActionCancel(i)}
                            className="flex items-center gap-1 px-2.5 py-1 rounded-md border text-xs font-medium hover:bg-muted transition"
                          >
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
                    {msg.content.split('\n').map((line, j) => {
                      const formatted = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                      return <p key={j} className={j > 0 ? 'mt-1' : ''} dangerouslySetInnerHTML={{ __html: formatted }} />
                    })}
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
                <p className="text-[11px] text-muted-foreground font-medium">Quick questions:</p>
                {quickActions.map((action) => (
                  <button key={action.label} type="button"
                    onClick={async () => {
                      const msg: Message = { role: 'user', content: action.label }
                      const newMsgs = [...messages, msg]
                      setMessages(newMsgs)
                      setLoading(true)
                      try {
                        const res = await fetch('/api/ai/assistant', {
                          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
                          body: JSON.stringify({ messages: newMsgs.slice(-10).map(m => ({ role: m.role, content: m.content })), currentPage: document.title }),
                        })
                        const data = await res.json()
                        const rawMessage = data.message || 'Something went wrong.'
                        const { cleanText, action: crmAction } = parseCrmAction(rawMessage)
                        setMessages([...newMsgs, {
                          role: 'assistant',
                          content: cleanText,
                          action: crmAction || undefined,
                          actionStatus: crmAction ? 'pending' : undefined,
                        }])
                      } catch {
                        setMessages([...newMsgs, { role: 'assistant', content: 'Connection error.' }])
                      }
                      setLoading(false)
                    }}
                    className="w-full text-left px-3 py-2 rounded-lg border text-xs hover:bg-muted transition flex items-center gap-2">
                    <span>{action.icon}</span> {action.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Input */}
          <div className="border-t px-3 py-2.5">
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
              <button type="button" onClick={send} disabled={!input.trim() || loading}
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
