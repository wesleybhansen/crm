'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { MessageCircle, Send, X, Plus, Copy, Check, Settings, ChevronDown } from 'lucide-react'

type Conversation = {
  id: string
  widget_id: string
  contact_id: string | null
  visitor_name: string | null
  visitor_email: string | null
  status: string
  created_at: string
  updated_at: string
  widget_name: string | null
  last_message: string | null
  last_sender_type: string | null
  last_message_at: string | null
  message_count: number
}

type Message = {
  id: string
  conversation_id: string
  sender_type: string
  message: string
  created_at: string
}

type Widget = {
  id: string
  name: string
  greeting_message: string
  config: Record<string, unknown>
  is_active: boolean
  embedCode: string
  created_at: string
}

export default function ChatPage() {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [selectedConvId, setSelectedConvId] = useState<string | null>(null)
  const [selectedConv, setSelectedConv] = useState<Conversation | null>(null)
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('open')
  const [showWidgets, setShowWidgets] = useState(false)
  const [widgets, setWidgets] = useState<Widget[]>([])
  const [widgetName, setWidgetName] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadConversations = useCallback(async () => {
    try {
      const res = await fetch(`/api/chat/conversations?status=${statusFilter}`)
      const data = await res.json()
      if (data.ok) setConversations(data.data)
    } catch {
      // silent
    }
  }, [statusFilter])

  const loadMessages = useCallback(async (convId: string) => {
    try {
      const res = await fetch(`/api/chat/conversations?conversationId=${convId}`)
      const data = await res.json()
      if (data.ok) {
        setMessages(data.data.messages)
        setSelectedConv(data.data.conversation)
      }
    } catch {
      // silent
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    loadConversations().finally(() => setLoading(false))
  }, [loadConversations])

  useEffect(() => {
    if (!selectedConvId) return
    loadMessages(selectedConvId)
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(() => {
      loadMessages(selectedConvId)
      loadConversations()
    }, 5000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [selectedConvId, loadMessages, loadConversations])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const sendReply = async () => {
    if (!reply.trim() || !selectedConvId) return
    setSending(true)
    try {
      const res = await fetch('/api/chat/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: selectedConvId, message: reply.trim() }),
      })
      const data = await res.json()
      if (data.ok) {
        setReply('')
        loadMessages(selectedConvId)
        loadConversations()
      }
    } catch {
      // silent
    } finally {
      setSending(false)
    }
  }

  const closeConversation = async () => {
    if (!selectedConvId) return
    try {
      const container = await fetch('/api/chat/conversations?conversationId=' + selectedConvId)
      const convData = await container.json()
      if (!convData.ok) return

      await fetch(`/api/chat/widgets?id=${convData.data.conversation.widget_id}`, { method: 'PUT' })

      const res = await fetch('/api/chat/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: selectedConvId, message: '[Conversation closed]' }),
      })

      loadConversations()
      loadMessages(selectedConvId)
    } catch {
      // silent
    }
  }

  const loadWidgets = async () => {
    try {
      const res = await fetch('/api/chat/widgets')
      const data = await res.json()
      if (data.ok) setWidgets(data.data)
    } catch {
      // silent
    }
  }

  const createWidget = async () => {
    if (!widgetName.trim()) return
    try {
      const res = await fetch('/api/chat/widgets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: widgetName.trim() }),
      })
      const data = await res.json()
      if (data.ok) {
        setWidgetName('')
        loadWidgets()
      }
    } catch {
      // silent
    }
  }

  const deleteWidget = async (id: string) => {
    try {
      await fetch(`/api/chat/widgets?id=${id}`, { method: 'DELETE' })
      loadWidgets()
    } catch {
      // silent
    }
  }

  const copyEmbed = (widget: Widget) => {
    navigator.clipboard.writeText(widget.embedCode)
    setCopiedId(widget.id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const formatTime = (dateStr: string | null) => {
    if (!dateStr) return ''
    const d = new Date(dateStr)
    const now = new Date()
    const diff = now.getTime() - d.getTime()
    if (diff < 60000) return 'just now'
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago'
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago'
    return d.toLocaleDateString()
  }

  if (showWidgets) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Chat Widgets</h1>
          <Button variant="outline" onClick={() => { setShowWidgets(false) }}>
            Back to Inbox
          </Button>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
          <h2 className="text-lg font-semibold mb-4">Create New Widget</h2>
          <div className="flex gap-3">
            <Input
              value={widgetName}
              onChange={(e) => setWidgetName(e.target.value)}
              placeholder="Widget name (e.g. Main Site Chat)"
              onKeyDown={(e) => e.key === 'Enter' && createWidget()}
            />
            <Button onClick={createWidget} disabled={!widgetName.trim()}>
              <Plus className="size-4 mr-1" /> Create
            </Button>
          </div>
        </div>

        <div className="space-y-4">
          {widgets.map((w) => (
            <div key={w.id} className="bg-white rounded-xl border border-gray-200 p-5">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="font-semibold text-gray-900">{w.name}</h3>
                  <p className="text-sm text-gray-500 mt-1">{w.greeting_message}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${w.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                    {w.is_active ? 'Active' : 'Inactive'}
                  </span>
                  <Button variant="ghost" size="sm" className="text-red-500 hover:text-red-700" onClick={() => deleteWidget(w.id)}>
                    <X className="size-4" />
                  </Button>
                </div>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium text-gray-600">Embed Code</span>
                  <Button variant="ghost" size="sm" onClick={() => copyEmbed(w)}>
                    {copiedId === w.id ? <Check className="size-3 mr-1 text-green-600" /> : <Copy className="size-3 mr-1" />}
                    {copiedId === w.id ? 'Copied!' : 'Copy'}
                  </Button>
                </div>
                <code className="text-xs text-gray-700 break-all block">{w.embedCode}</code>
              </div>
            </div>
          ))}
          {widgets.length === 0 && (
            <div className="text-center py-12 text-gray-500">
              No widgets yet. Create one to start receiving chats.
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="h-[calc(100vh-64px)] flex">
      {/* Left panel - conversations */}
      <div className="w-80 border-r border-gray-200 flex flex-col bg-white">
        <div className="p-4 border-b border-gray-200">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-bold text-gray-900">Chat</h2>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setShowWidgets(true); loadWidgets() }}
              title="Manage widgets"
            >
              <Settings className="size-4" />
            </Button>
          </div>
          <div className="flex gap-1">
            {['open', 'closed', 'all'].map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-3 py-1 text-xs rounded-full capitalize transition-colors ${
                  statusFilter === s
                    ? 'bg-blue-100 text-blue-700 font-medium'
                    : 'text-gray-500 hover:bg-gray-100'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-6 text-center text-gray-400">Loading...</div>
          ) : conversations.length === 0 ? (
            <div className="p-6 text-center text-gray-400">
              <MessageCircle className="size-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No conversations yet</p>
            </div>
          ) : (
            conversations.map((conv) => (
              <button
                key={conv.id}
                onClick={() => setSelectedConvId(conv.id)}
                className={`w-full text-left p-4 border-b border-gray-100 hover:bg-gray-50 transition-colors ${
                  selectedConvId === conv.id ? 'bg-blue-50 border-l-2 border-l-blue-500' : ''
                }`}
              >
                <div className="flex items-start justify-between mb-1">
                  <span className="font-medium text-sm text-gray-900 truncate">
                    {conv.visitor_name || conv.visitor_email || 'Anonymous Visitor'}
                  </span>
                  <span className="text-xs text-gray-400 flex-shrink-0 ml-2">
                    {formatTime(conv.last_message_at || conv.updated_at)}
                  </span>
                </div>
                {conv.visitor_email && conv.visitor_name && (
                  <div className="text-xs text-gray-400 mb-1 truncate">{conv.visitor_email}</div>
                )}
                <div className="text-xs text-gray-500 truncate">
                  {conv.last_sender_type === 'business' && <span className="text-gray-400">You: </span>}
                  {conv.last_message || 'No messages'}
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                    conv.status === 'open' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                  }`}>
                    {conv.status}
                  </span>
                  <span className="text-[10px] text-gray-400">{conv.message_count} msgs</span>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Right panel - messages */}
      <div className="flex-1 flex flex-col bg-gray-50">
        {!selectedConvId ? (
          <div className="flex-1 flex items-center justify-center text-gray-400">
            <div className="text-center">
              <MessageCircle className="size-12 mx-auto mb-3 opacity-30" />
              <p className="text-lg font-medium">Select a conversation</p>
              <p className="text-sm mt-1">Choose a chat from the left to start replying</p>
            </div>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="bg-white border-b border-gray-200 p-4 flex items-center justify-between">
              <div>
                <h3 className="font-semibold text-gray-900">
                  {selectedConv?.visitor_name || selectedConv?.visitor_email || 'Anonymous Visitor'}
                </h3>
                <div className="flex items-center gap-3 mt-0.5">
                  {selectedConv?.visitor_email && (
                    <span className="text-xs text-gray-500">{selectedConv.visitor_email}</span>
                  )}
                  <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                    selectedConv?.status === 'open' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                  }`}>
                    {selectedConv?.status}
                  </span>
                </div>
              </div>
              {selectedConv?.status === 'open' && (
                <Button variant="outline" size="sm" onClick={closeConversation}>
                  Close conversation
                </Button>
              )}
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex ${msg.sender_type === 'business' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[70%] px-4 py-2.5 rounded-2xl text-sm ${
                      msg.sender_type === 'business'
                        ? 'bg-blue-500 text-white rounded-br-md'
                        : 'bg-white text-gray-900 border border-gray-200 rounded-bl-md'
                    }`}
                  >
                    <p className="whitespace-pre-wrap">{msg.message}</p>
                    <p className={`text-[10px] mt-1 ${
                      msg.sender_type === 'business' ? 'text-blue-100' : 'text-gray-400'
                    }`}>
                      {new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            {/* Reply input */}
            <div className="bg-white border-t border-gray-200 p-4">
              <div className="flex gap-2">
                <Input
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  placeholder="Type your reply..."
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      sendReply()
                    }
                  }}
                  disabled={sending}
                />
                <Button onClick={sendReply} disabled={!reply.trim() || sending}>
                  <Send className="size-4" />
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
