'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { translateWithFallback } from '@open-mercato/shared/lib/i18n/translate'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { Mail, MessageSquare, Send, Search, User, ArrowUpRight, Circle } from 'lucide-react'

type Conversation = {
  contactId: string
  contactName: string
  contactEmail: string | null
  contactPhone: string | null
  lastMessage: {
    channel: 'email' | 'sms'
    preview: string
    timestamp: string
    direction: string
    isRead: boolean
  }
  unreadCount: number
  messageCount: number
}

type Message = {
  id: string
  channel: 'email' | 'sms'
  direction: string
  subject: string | null
  body: string
  bodyText: string | null
  fromAddress: string
  toAddress: string
  status: string
  openedAt: string | null
  clickedAt: string | null
  createdAt: string
}

type ContactDetail = {
  id: string
  displayName: string
  email: string | null
  phone: string | null
}

type ConversationDetail = {
  contact: ContactDetail
  messages: Message[]
}

function stripHtml(html: string): string {
  if (typeof document !== 'undefined') {
    const div = document.createElement('div')
    div.innerHTML = html
    return div.textContent || div.innerText || ''
  }
  return html.replace(/<[^>]*>/g, '')
}

function relativeTime(dateStr: string): string {
  const now = new Date()
  const date = new Date(dateStr)
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 1) return 'now'
  if (diffMins < 60) return `${diffMins}m`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 7) return `${diffDays}d`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export default function InboxPage() {
  const t = useT()
  const translate = (key: string, fallback: string) => translateWithFallback(t, key, fallback)

  const [conversations, setConversations] = useState<Conversation[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [channelFilter, setChannelFilter] = useState<'all' | 'email' | 'sms'>('all')
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ConversationDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  // Reply state
  const [replyChannel, setReplyChannel] = useState<'email' | 'sms'>('email')
  const [replySubject, setReplySubject] = useState('')
  const [replyBody, setReplyBody] = useState('')
  const [sending, setSending] = useState(false)

  const messagesEndRef = useRef<HTMLDivElement>(null)

  const loadConversations = useCallback(() => {
    const params = new URLSearchParams()
    if (search) params.set('search', search)
    if (channelFilter !== 'all') params.set('channel', channelFilter)
    const qs = params.toString()
    fetch(`/api/inbox${qs ? `?${qs}` : ''}`, { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) setConversations(d.data)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [search, channelFilter])

  useEffect(() => {
    setLoading(true)
    const timeout = setTimeout(loadConversations, 300)
    return () => clearTimeout(timeout)
  }, [loadConversations])

  useEffect(() => {
    if (!selectedContactId) return
    setDetailLoading(true)
    fetch(`/api/inbox/${selectedContactId}`, { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          setDetail(d.data)
          const lastMsg = d.data.messages[d.data.messages.length - 1]
          if (lastMsg) {
            setReplyChannel(lastMsg.channel)
            if (lastMsg.channel === 'email' && lastMsg.subject) {
              setReplySubject(lastMsg.subject.startsWith('Re: ') ? lastMsg.subject : `Re: ${lastMsg.subject}`)
            }
          }
        }
        setDetailLoading(false)
      })
      .catch(() => setDetailLoading(false))
  }, [selectedContactId])

  useEffect(() => {
    if (detail && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [detail])

  async function handleSend() {
    if (!detail) return
    if (replyChannel === 'email' && (!replySubject.trim() || !replyBody.trim())) return
    if (replyChannel === 'sms' && !replyBody.trim()) return

    setSending(true)
    try {
      if (replyChannel === 'email') {
        const res = await fetch('/api/email/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            to: detail.contact.email,
            subject: replySubject,
            bodyHtml: `<p>${replyBody.replace(/\n/g, '<br>')}</p>`,
            bodyText: replyBody,
            contactId: detail.contact.id,
          }),
        })
        await res.json()
      } else {
        const res = await fetch('/api/sms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            to: detail.contact.phone,
            message: replyBody,
            contactId: detail.contact.id,
          }),
        })
        await res.json()
      }
      setReplyBody('')
      setReplySubject('')
      // Reload conversation
      setSelectedContactId(detail.contact.id)
      loadConversations()
    } catch (error) {
      console.error('[inbox.send]', error)
    } finally {
      setSending(false)
    }
  }

  const selectedConversation = conversations.find((c) => c.contactId === selectedContactId)

  return (
    <div className="flex h-[calc(100vh-64px)] overflow-hidden">
      {/* LEFT PANEL — Conversation List */}
      <div className="w-[350px] flex-shrink-0 border-r flex flex-col bg-background">
        {/* Search */}
        <div className="p-3 border-b space-y-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input
              placeholder={translate('inbox.search', 'Search conversations...')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-9"
            />
          </div>
          {/* Channel filter tabs */}
          <div className="flex gap-1">
            {(['all', 'email', 'sms'] as const).map((ch) => (
              <button
                key={ch}
                type="button"
                onClick={() => setChannelFilter(ch)}
                className={`flex-1 px-2 py-1 rounded text-xs font-medium transition ${
                  channelFilter === ch
                    ? 'bg-accent/10 text-accent border border-accent/30'
                    : 'text-muted-foreground hover:text-foreground border border-transparent'
                }`}
              >
                {ch === 'all' && translate('inbox.filter.all', 'All')}
                {ch === 'email' && translate('inbox.filter.email', 'Email')}
                {ch === 'sms' && translate('inbox.filter.sms', 'SMS')}
              </button>
            ))}
          </div>
        </div>

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-4 text-sm text-muted-foreground">
              {translate('inbox.loading', 'Loading...')}
            </div>
          ) : conversations.length === 0 ? (
            <div className="p-8 text-center">
              <Mail className="size-8 mx-auto mb-2 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">
                {translate('inbox.empty', 'No conversations yet')}
              </p>
            </div>
          ) : (
            conversations.map((conv) => (
              <button
                key={conv.contactId}
                type="button"
                onClick={() => setSelectedContactId(conv.contactId)}
                className={`w-full text-left px-3 py-3 border-b transition hover:bg-muted/50 ${
                  selectedContactId === conv.contactId ? 'bg-muted/70' : ''
                }`}
              >
                <div className="flex items-start gap-2.5">
                  {/* Unread indicator */}
                  <div className="mt-1.5 w-2 flex-shrink-0">
                    {conv.unreadCount > 0 && (
                      <Circle className="size-2 fill-accent text-accent" />
                    )}
                  </div>
                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`text-sm truncate ${
                          conv.unreadCount > 0 ? 'font-semibold' : 'font-medium'
                        }`}
                      >
                        {conv.contactName}
                      </span>
                      <span className="text-[11px] text-muted-foreground whitespace-nowrap flex-shrink-0">
                        {relativeTime(conv.lastMessage.timestamp)}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {conv.lastMessage.channel === 'email' ? (
                        <Mail className="size-3 text-muted-foreground flex-shrink-0" />
                      ) : (
                        <MessageSquare className="size-3 text-muted-foreground flex-shrink-0" />
                      )}
                      <span className="text-xs text-muted-foreground truncate">
                        {conv.lastMessage.direction === 'outbound' ? 'You: ' : ''}
                        {stripHtml(conv.lastMessage.preview || '')}
                      </span>
                    </div>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* RIGHT PANEL — Conversation Detail */}
      <div className="flex-1 flex flex-col bg-background">
        {!selectedContactId ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <Mail className="size-12 mx-auto mb-3 text-muted-foreground/30" />
              <p className="text-sm">{translate('inbox.selectConversation', 'Select a conversation to view messages')}</p>
            </div>
          </div>
        ) : detailLoading ? (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
            {translate('inbox.loadingMessages', 'Loading messages...')}
          </div>
        ) : detail ? (
          <>
            {/* Contact header */}
            <div className="px-4 py-3 border-b flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="size-9 rounded-full bg-muted flex items-center justify-center">
                  <User className="size-4 text-muted-foreground" />
                </div>
                <div>
                  <div className="text-sm font-semibold">{detail.contact.displayName}</div>
                  <div className="text-xs text-muted-foreground">
                    {[detail.contact.email, detail.contact.phone].filter(Boolean).join(' · ')}
                  </div>
                </div>
              </div>
              <a
                href={`/backend/contacts/${detail.contact.id}`}
                className="flex items-center gap-1 text-xs text-accent hover:underline"
              >
                {translate('inbox.viewProfile', 'View profile')}
                <ArrowUpRight className="size-3" />
              </a>
            </div>

            {/* Message thread */}
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
              {detail.messages.map((msg) => {
                const isOutbound = msg.direction === 'outbound'
                return (
                  <div
                    key={msg.id}
                    className={`flex ${isOutbound ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[70%] rounded-lg px-3 py-2 ${
                        isOutbound
                          ? 'bg-accent/10 border border-accent/20'
                          : 'bg-muted border border-border'
                      }`}
                    >
                      {/* Channel + direction badge */}
                      <div className="flex items-center gap-1.5 mb-1">
                        {msg.channel === 'email' ? (
                          <Mail className="size-3 text-muted-foreground" />
                        ) : (
                          <MessageSquare className="size-3 text-muted-foreground" />
                        )}
                        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                          {msg.channel} · {isOutbound ? 'Sent' : 'Received'}
                        </span>
                      </div>
                      {/* Subject for emails */}
                      {msg.channel === 'email' && msg.subject && (
                        <div className="text-xs font-semibold mb-1">{msg.subject}</div>
                      )}
                      {/* Body */}
                      <div className="text-sm leading-relaxed">
                        {msg.channel === 'email' ? (
                          <div
                            className="prose prose-sm dark:prose-invert max-w-none [&_*]:text-sm"
                            dangerouslySetInnerHTML={{ __html: msg.body }}
                          />
                        ) : (
                          <p className="whitespace-pre-wrap">{msg.body}</p>
                        )}
                      </div>
                      {/* Timestamp + status */}
                      <div className="flex items-center gap-2 mt-1.5 text-[10px] text-muted-foreground">
                        <span>
                          {new Date(msg.createdAt).toLocaleString(undefined, {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                        {msg.channel === 'email' && isOutbound && (
                          <>
                            <span className="text-muted-foreground/50">·</span>
                            <span>{msg.status}</span>
                            {msg.openedAt && <span>· opened</span>}
                            {msg.clickedAt && <span>· clicked</span>}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
              <div ref={messagesEndRef} />
            </div>

            {/* Quick reply bar */}
            <div className="border-t px-4 py-3 space-y-2">
              {/* Channel toggle */}
              <div className="flex items-center gap-2">
                <div className="flex gap-1 rounded border p-0.5">
                  <button
                    type="button"
                    onClick={() => setReplyChannel('email')}
                    className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition ${
                      replyChannel === 'email'
                        ? 'bg-accent/10 text-accent'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                    disabled={!detail.contact.email}
                    title={detail.contact.email ? undefined : 'No email on file'}
                  >
                    <Mail className="size-3" />
                    Email
                  </button>
                  <button
                    type="button"
                    onClick={() => setReplyChannel('sms')}
                    className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition ${
                      replyChannel === 'sms'
                        ? 'bg-accent/10 text-accent'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                    disabled={!detail.contact.phone}
                    title={detail.contact.phone ? undefined : 'No phone on file'}
                  >
                    <MessageSquare className="size-3" />
                    SMS
                  </button>
                </div>
                {replyChannel === 'sms' && (
                  <span className="text-[11px] text-muted-foreground ml-auto">
                    {replyBody.length}/160
                  </span>
                )}
              </div>
              {/* Subject (email only) */}
              {replyChannel === 'email' && (
                <Input
                  placeholder={translate('inbox.reply.subject', 'Subject')}
                  value={replySubject}
                  onChange={(e) => setReplySubject(e.target.value)}
                  className="h-8 text-sm"
                />
              )}
              {/* Message input + send */}
              <div className="flex gap-2">
                <Textarea
                  placeholder={
                    replyChannel === 'email'
                      ? translate('inbox.reply.emailPlaceholder', 'Write your reply...')
                      : translate('inbox.reply.smsPlaceholder', 'Type a message...')
                  }
                  value={replyBody}
                  onChange={(e) => setReplyBody(e.target.value)}
                  className="flex-1 min-h-[60px] max-h-[120px] text-sm resize-none"
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                      e.preventDefault()
                      handleSend()
                    }
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  onClick={handleSend}
                  disabled={sending || !replyBody.trim() || (replyChannel === 'email' && !replySubject.trim())}
                  className="self-end"
                >
                  <Send className="size-4" />
                </Button>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
