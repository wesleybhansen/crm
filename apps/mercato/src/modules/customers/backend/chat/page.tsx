'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { Badge } from '@open-mercato/ui/primitives/badge'
import {
  MessageCircle, Send, X, Plus, Copy, Check, Settings, Search,
  Paperclip, PanelRightClose, PanelRightOpen, Mail, Phone,
  Calendar, Tag, Zap, Bell, BellOff, Trash2,
  ChevronDown, Slash, Bot, ArrowLeft, ArrowRight,
  Globe, Code, Link, Plug, ExternalLink, ChevronLeft,
  ChevronRight, Inbox, Upload, FileText, Headphones,
} from 'lucide-react'
import { Switch } from '@open-mercato/ui/primitives/switch'
import { Label } from '@open-mercato/ui/primitives/label'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  visitor_typing: boolean
  agent_typing: boolean
  visitor_typing_at: string | null
  agent_typing_at: string | null
}

type Message = {
  id: string
  conversation_id: string
  sender_type: 'visitor' | 'business' | 'system'
  message: string
  created_at: string
  is_bot?: boolean
}

type Widget = {
  id: string
  name: string
  greeting_message: string
  config: Record<string, unknown>
  is_active: boolean
  embedCode: string
  created_at: string
  bot_enabled: boolean
  bot_knowledge_base: string | null
  bot_personality: string | null
  bot_instructions: string | null
  bot_guardrails: string | null
  bot_handoff_message: string | null
  bot_max_responses: number | null
  slug: string | null
  description: string | null
  brand_color: string | null
  welcome_message: string | null
  business_name: string | null
  public_page_enabled: boolean
  conversation_count?: number
}

type CannedResponse = { id: string; shortcut: string; text: string }

type ContactInfo = {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  source: string | null
  lifecycle_stage: string | null
  created_at: string
  tags?: string[]
  notes?: Array<{ id: string; content: string; created_at: string }>
  deals?: Array<{ id: string; title: string; value: number; stage: string }>
}

type PageMode = 'landing' | 'inbox' | 'wizard'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY_CANNED = 'chat_canned_responses'

const DEFAULT_CANNED: CannedResponse[] = [
  { id: '1', shortcut: 'hello', text: 'Hi there! How can I help you today?' },
  { id: '2', shortcut: 'price', text: 'Our pricing starts at $29/mo. Would you like me to send more details?' },
  { id: '3', shortcut: 'hours', text: 'Our business hours are Monday-Friday, 9 AM to 5 PM EST.' },
  { id: '4', shortcut: 'thanks', text: 'Thank you for reaching out! Is there anything else I can help with?' },
  { id: '5', shortcut: 'bye', text: 'Thanks for chatting with us. Have a great day!' },
]

const AVATAR_COLORS = [
  'bg-blue-500', 'bg-emerald-500', 'bg-violet-500', 'bg-amber-500',
  'bg-rose-500', 'bg-cyan-500', 'bg-indigo-500', 'bg-pink-500',
]

const DEFAULT_GUARDRAILS = `- Do not provide legal, medical, or financial advice
- Do not discuss competitor products or pricing
- Do not share internal company information or employee details
- Do not make promises about delivery dates or guarantees not in the knowledge base
- Do not collect or discuss sensitive personal information (SSN, credit card numbers, passwords)`

const PERSONALITY_PRESETS = [
  { id: 'friendly', label: 'Friendly & Professional', value: 'friendly, helpful, and professional. Use a warm but business-appropriate tone.' },
  { id: 'casual', label: 'Casual & Fun', value: 'casual, upbeat, and friendly. Use conversational language and emojis occasionally.' },
  { id: 'formal', label: 'Formal & Business', value: 'formal, precise, and business-oriented. Use professional language and avoid slang.' },
  { id: 'custom', label: 'Custom', value: '' },
] as const

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getAvatarColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

function getInitials(name: string | null, email: string | null): string {
  if (name) {
    const parts = name.trim().split(/\s+/)
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
    return parts[0][0].toUpperCase()
  }
  if (email) return email[0].toUpperCase()
  return '?'
}

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHr = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHr / 24)

  if (diffSec < 60) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHr < 24) return `${diffHr}h ago`
  if (diffDay === 1) return 'Yesterday'
  if (diffDay < 7) return `${diffDay}d ago`
  return d.toLocaleDateString()
}

function formatMessageTime(dateStr: string): string {
  const d = new Date(dateStr)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (isToday) return `Today ${time}`
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`
  return `${d.toLocaleDateString()} ${time}`
}

function loadCannedResponses(): CannedResponse[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_CANNED)
    if (stored) return JSON.parse(stored)
  } catch { /* ignore */ }
  return DEFAULT_CANNED
}

function saveCannedResponses(responses: CannedResponse[]) {
  try {
    localStorage.setItem(STORAGE_KEY_CANNED, JSON.stringify(responses))
  } catch { /* ignore */ }
}

function randomSuffix() { return Math.random().toString(36).substring(2, 6) }

function slugify(text: string): string {
  const base = text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${base}-${randomSuffix()}`
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Avatar({ name, email, size = 'md' }: { name: string | null; email: string | null; size?: 'sm' | 'md' | 'lg' }) {
  const displayName = name || email || 'Anonymous'
  const color = getAvatarColor(displayName)
  const initials = getInitials(name, email)
  const sizeClass = size === 'sm' ? 'size-8 text-xs' : size === 'lg' ? 'size-12 text-lg' : 'size-10 text-sm'
  return (
    <div className={`${sizeClass} ${color} rounded-full flex items-center justify-center text-white font-medium flex-shrink-0`}>
      {initials}
    </div>
  )
}

function StatusDot({ status }: { status: string }) {
  return (
    <span className={`size-2 rounded-full flex-shrink-0 ${status === 'open' ? 'bg-[#047857] dark:bg-[#34d399]' : 'bg-muted-foreground/30'}`} />
  )
}

function UnreadDot() {
  return <span className="size-2.5 rounded-full bg-accent flex-shrink-0" />
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

function useToast() {
  const [toasts, setToasts] = useState<Array<{ id: number; message: string; type: 'error' | 'success' }>>([])
  const nextId = useRef(0)

  const showToast = useCallback((message: string, type: 'error' | 'success' = 'error') => {
    const id = nextId.current++
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000)
  }, [])

  const ToastContainer = useMemo(() => {
    return function ToastContainerInner() {
      if (toasts.length === 0) return null
      return (
        <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
          {toasts.map(t => (
            <div
              key={t.id}
              className={`px-4 py-2.5 rounded-lg text-sm font-medium shadow-lg animate-in slide-in-from-bottom-2 ${
                t.type === 'error'
                  ? 'bg-destructive text-white'
                  : 'bg-[#047857] dark:bg-[#34d399] text-white'
              }`}
            >
              {t.message}
            </div>
          ))}
        </div>
      )
    }
  }, [toasts])

  return { showToast, ToastContainer }
}

// ---------------------------------------------------------------------------
// Landing Page
// ---------------------------------------------------------------------------

function LandingPage({
  widgets,
  conversations,
  onCreateWidget,
  onOpenInbox,
  onEditWidget,
  onDeleteWidget,
  onToggleWidgetActive,
  showToast,
}: {
  widgets: Widget[]
  conversations: Conversation[]
  onCreateWidget: () => void
  onOpenInbox: () => void
  onEditWidget: (widget: Widget) => void
  onDeleteWidget: (id: string) => void
  onToggleWidgetActive: (id: string, active: boolean) => void
  showToast: (msg: string, type?: 'error' | 'success') => void
}) {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null)
  const [copiedEmbed, setCopiedEmbed] = useState<string | null>(null)

  const openConversationCount = conversations.filter(c => c.status === 'open').length

  const copyPublicLink = (slug: string) => {
    navigator.clipboard.writeText(`${origin}/api/chat/page/${slug}`)
    setCopiedSlug(slug)
    setTimeout(() => setCopiedSlug(null), 2000)
  }

  const copyEmbedCode = (widget: Widget) => {
    navigator.clipboard.writeText(widget.embedCode)
    setCopiedEmbed(widget.id)
    setTimeout(() => setCopiedEmbed(null), 2000)
  }

  return (
    <div className="h-[calc(100vh-64px)] bg-background overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-12">
        {/* Header */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center size-14 rounded-2xl bg-accent/10 mb-4">
            <MessageCircle className="size-7 text-accent" />
          </div>
          <h1 className="text-2xl font-bold text-foreground mb-2">Chat</h1>
          <p className="text-muted-foreground max-w-md mx-auto">
            Connect with your customers through live chat. Create a chat widget for your website or start chatting with existing customers.
          </p>
        </div>

        {/* Two action cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-12">
          {/* Create Widget Card */}
          <button
            type="button"
            onClick={onCreateWidget}
            className="group text-left bg-card rounded-xl border border-border p-6 hover:border-accent/40 hover:shadow-md transition-all"
          >
            <div className="inline-flex items-center justify-center size-10 rounded-lg bg-accent/10 mb-4 group-hover:bg-accent/15 transition-colors">
              <Plug className="size-5 text-accent" />
            </div>
            <h2 className="text-base font-semibold text-foreground mb-1.5">Create Chat Widget</h2>
            <p className="text-sm text-muted-foreground mb-4 leading-relaxed">
              Add live chat to your website or get a shareable chat link for your customers.
            </p>
            <span className="inline-flex items-center text-sm font-medium text-accent group-hover:gap-2 gap-1.5 transition-all">
              Get Started <ArrowRight className="size-4" />
            </span>
          </button>

          {/* Open Inbox Card */}
          <button
            type="button"
            onClick={onOpenInbox}
            className="group text-left bg-card rounded-xl border border-border p-6 hover:border-accent/40 hover:shadow-md transition-all relative"
          >
            <div className="inline-flex items-center justify-center size-10 rounded-lg bg-accent/10 mb-4 group-hover:bg-accent/15 transition-colors">
              <Inbox className="size-5 text-accent" />
            </div>
            <h2 className="text-base font-semibold text-foreground mb-1.5">Chat with Customers</h2>
            <p className="text-sm text-muted-foreground mb-4 leading-relaxed">
              View and respond to customer conversations in your inbox.
            </p>
            <span className="inline-flex items-center text-sm font-medium text-accent group-hover:gap-2 gap-1.5 transition-all">
              Open Inbox <ArrowRight className="size-4" />
            </span>
            {openConversationCount > 0 && (
              <div className="absolute top-4 right-4">
                <Badge variant="default" className="text-xs">
                  {openConversationCount} open
                </Badge>
              </div>
            )}
          </button>
        </div>

        {/* Existing Widgets List */}
        {widgets.length > 0 && (
          <div>
            <div className="flex items-center gap-3 mb-4">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Your Chat Widgets</span>
              <div className="h-px flex-1 bg-border" />
            </div>

            <div className="space-y-3">
              {widgets.map((widget) => (
                <div
                  key={widget.id}
                  className="bg-card rounded-lg border border-border p-4 flex items-center gap-4"
                >
                  {/* Color indicator */}
                  <div
                    className="size-3 rounded-full flex-shrink-0"
                    style={{ backgroundColor: widget.brand_color || '#3B82F6' }}
                  />

                  {/* Widget info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-sm font-medium text-foreground truncate">{widget.name}</span>
                      <Badge variant={widget.is_active ? 'default' : 'secondary'} className="text-[10px] h-5">
                        {widget.is_active ? 'Active' : 'Inactive'}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground truncate">
                      {widget.business_name || widget.name}
                      {widget.conversation_count !== undefined && ` \u00b7 ${widget.conversation_count} conversations`}
                    </p>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {widget.slug && widget.public_page_enabled && (
                      <IconButton
                        variant="ghost"
                        size="sm"
                        type="button"
                        onClick={() => copyPublicLink(widget.slug!)}
                        aria-label="Copy public link"
                        title="Copy public chat link"
                      >
                        {copiedSlug === widget.slug ? <Check className="size-4 text-[#047857] dark:text-[#34d399]" /> : <Link className="size-4" />}
                      </IconButton>
                    )}
                    <IconButton
                      variant="ghost"
                      size="sm"
                      type="button"
                      onClick={() => copyEmbedCode(widget)}
                      aria-label="Copy embed code"
                      title="Copy embed code"
                    >
                      {copiedEmbed === widget.id ? <Check className="size-4 text-[#047857] dark:text-[#34d399]" /> : <Code className="size-4" />}
                    </IconButton>
                    {widget.slug && widget.public_page_enabled && (
                      <IconButton
                        variant="ghost"
                        size="sm"
                        type="button"
                        onClick={() => window.open(`/api/chat/page/${widget.slug}`, '_blank')}
                        aria-label="Open public page"
                        title="Open public chat page"
                      >
                        <ExternalLink className="size-4" />
                      </IconButton>
                    )}
                    <IconButton
                      variant="ghost"
                      size="sm"
                      type="button"
                      onClick={() => onEditWidget(widget)}
                      aria-label="Edit widget"
                    >
                      <Settings className="size-4" />
                    </IconButton>
                    <IconButton
                      variant="ghost"
                      size="sm"
                      type="button"
                      onClick={() => onToggleWidgetActive(widget.id, !widget.is_active)}
                      aria-label={widget.is_active ? 'Deactivate' : 'Activate'}
                      title={widget.is_active ? 'Deactivate widget' : 'Activate widget'}
                    >
                      <div className={`size-2 rounded-full ${widget.is_active ? 'bg-[#047857] dark:bg-[#34d399]' : 'bg-muted-foreground/30'}`} />
                    </IconButton>
                    <IconButton
                      variant="ghost"
                      size="sm"
                      type="button"
                      onClick={() => {
                        if (confirm('Delete this widget? This cannot be undone.')) {
                          onDeleteWidget(widget.id)
                        }
                      }}
                      aria-label="Delete widget"
                    >
                      <Trash2 className="size-4 text-destructive/70" />
                    </IconButton>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Wizard
// ---------------------------------------------------------------------------

type WizardData = {
  name: string
  businessName: string
  welcomeMessage: string
  brandColor: string
}

function CreationWizard({
  onBack,
  onCreate,
  showToast,
}: {
  onBack: () => void
  onCreate: (data: WizardData) => Promise<any>
  showToast: (msg: string, type?: 'error' | 'success') => void
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [creating, setCreating] = useState(false)
  const [createdWidget, setCreatedWidget] = useState<Widget | null>(null)
  const [copiedLink, setCopiedLink] = useState(false)
  const [copiedEmbed, setCopiedEmbed] = useState(false)

  const [name, setName] = useState('')
  const [businessName, setBusinessName] = useState('')
  const [welcomeMessage, setWelcomeMessage] = useState('Hi there! How can we help you today?')
  const [brandColor, setBrandColor] = useState('#3B82F6')

  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const slug = slugify(name)

  const canProceedStep1 = name.trim().length > 0

  const handleCreate = async () => {
    setCreating(true)
    try {
      const result = await onCreate({
        name: name.trim(),
        businessName: businessName.trim() || name.trim(),
        welcomeMessage: welcomeMessage.trim(),
        brandColor,
      })
      if (result) {
        setCreatedWidget(result)
        setStep(3)
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to create widget')
    } finally {
      setCreating(false)
    }
  }

  const widgetSlug = createdWidget?.slug || slugify(name.trim())
  const copyLink = () => {
    navigator.clipboard.writeText(`${origin}/api/chat/page/${widgetSlug}`)
    setCopiedLink(true)
    setTimeout(() => setCopiedLink(false), 2000)
  }

  const copyEmbed = () => {
    const code = `<script src="${origin}/api/chat/widget/${createdWidget?.id || 'WIDGET_ID'}" async></script>`
    navigator.clipboard.writeText(code)
    setCopiedEmbed(true)
    setTimeout(() => setCopiedEmbed(false), 2000)
  }

  return (
    <div className="h-[calc(100vh-64px)] bg-background overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 py-8">
        {/* Back button and progress */}
        <div className="flex items-center justify-between mb-8">
          <Button variant="ghost" size="sm" type="button" onClick={onBack} className="text-muted-foreground">
            <ArrowLeft className="size-4 mr-1.5" /> Back to Chat
          </Button>
          <div className="flex items-center gap-2">
            {[1, 2, 3].map((s) => (
              <div
                key={s}
                className={`flex items-center gap-1.5 ${s <= step ? 'text-foreground' : 'text-muted-foreground/50'}`}
              >
                <div className={`size-7 rounded-full flex items-center justify-center text-xs font-medium border-2 transition-colors ${
                  s < step ? 'bg-accent border-accent text-white' :
                  s === step ? 'border-accent text-accent' :
                  'border-muted-foreground/30 text-muted-foreground/50'
                }`}>
                  {s < step ? <Check className="size-3.5" /> : s}
                </div>
                {s < 3 && <div className={`w-8 h-0.5 ${s < step ? 'bg-accent' : 'bg-border'}`} />}
              </div>
            ))}
          </div>
        </div>

        {/* Step 1: Basics */}
        {step === 1 && (
          <div>
            <h2 className="text-xl font-bold text-foreground mb-1">Widget Basics</h2>
            <p className="text-sm text-muted-foreground mb-6">Set up the core details for your chat widget.</p>

            <div className="space-y-5">
              <div>
                <label className="text-sm font-medium text-foreground mb-1.5 block">
                  Widget Name <span className="text-destructive">*</span>
                </label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Main Site Chat, Support Widget"
                  className="text-sm"
                />
              </div>

              <div>
                <label className="text-sm font-medium text-foreground mb-1.5 block">
                  Business Name
                </label>
                <Input
                  value={businessName}
                  onChange={(e) => setBusinessName(e.target.value)}
                  placeholder="Shown in the public page header (defaults to widget name)"
                  className="text-sm"
                />
              </div>

              <div>
                <label className="text-sm font-medium text-foreground mb-1.5 block">
                  Welcome Message
                </label>
                <Textarea
                  value={welcomeMessage}
                  onChange={(e) => setWelcomeMessage(e.target.value)}
                  placeholder="The first thing visitors see when they open the chat"
                  className="text-sm"
                  rows={2}
                />
              </div>

              <div>
                <label className="text-sm font-medium text-foreground mb-1.5 block">
                  Brand Color
                </label>
                <div className="flex items-center gap-2">
                  <div className="relative size-10 rounded-lg overflow-hidden border border-border shrink-0">
                    <input
                      type="color"
                      value={brandColor}
                      onChange={(e) => setBrandColor(e.target.value)}
                      className="absolute inset-0 size-full cursor-pointer border-0 p-0"
                      style={{ appearance: 'none', WebkitAppearance: 'none' }}
                    />
                    <div className="absolute inset-0 rounded-lg pointer-events-none" style={{ backgroundColor: brandColor }} />
                  </div>
                  <Input
                    value={brandColor}
                    onChange={(e) => setBrandColor(e.target.value)}
                    placeholder="#3B82F6"
                    className="text-sm font-mono w-28 h-10"
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end mt-8">
              <Button
                type="button"
                onClick={() => setStep(2)}
                disabled={!canProceedStep1}
              >
                Next <ChevronRight className="size-4 ml-1" />
              </Button>
            </div>
          </div>
        )}

        {/* Step 2: Answers (powered by Customer Service) */}
        {step === 2 && (
          <div>
            <h2 className="text-xl font-bold text-foreground mb-1">Answers and escalation</h2>
            <p className="text-sm text-muted-foreground mb-6">
              Chat is now powered by Customer Service.
            </p>

            <div className="rounded-xl border border-border bg-muted/40 px-5 py-5">
              <div className="flex items-start gap-3">
                <Headphones className="size-5 text-[#6d28d9] dark:text-[#c4b5fd] mt-0.5 shrink-0" />
                <div className="text-sm text-muted-foreground space-y-2">
                  <p className="text-foreground font-medium">Set up answers, knowledge, and escalation in Customer Service settings.</p>
                  <p>
                    Your chat widget gets instant, grounded answers from your Customer Service knowledge and model answers, with your flag scenarios deciding what is answered automatically and what is held for your review.
                  </p>
                  <a href="/backend/customer-service" className="inline-flex items-center gap-1.5 text-accent font-medium hover:underline">
                    Open Customer Service settings <ArrowRight className="size-4" />
                  </a>
                </div>
              </div>
            </div>

            <div className="flex justify-between mt-8">
              <Button variant="outline" type="button" onClick={() => setStep(1)}>
                <ChevronLeft className="size-4 mr-1" /> Back
              </Button>
              <Button
                type="button"
                onClick={() => setStep(3)}
              >
                Next <ChevronRight className="size-4 ml-1" />
              </Button>
            </div>
          </div>
        )}

        {/* Step 3: Deploy */}
        {step === 3 && !createdWidget && (
          <div>
            <h2 className="text-xl font-bold text-foreground mb-1">Deploy Your Widget</h2>
            <p className="text-sm text-muted-foreground mb-6">
              Review your settings and create the widget. You will get deployment options after creation.
            </p>

            {/* Summary */}
            <div className="bg-card rounded-xl border border-border p-5 mb-6 space-y-3">
              <div className="flex items-center gap-3">
                <div className="size-4 rounded-full" style={{ backgroundColor: brandColor }} />
                <span className="text-sm font-medium text-foreground">{name}</span>
              </div>
              <div className="text-xs text-muted-foreground space-y-1">
                <p>Business name: {businessName || name}</p>
                <p>Welcome message: {welcomeMessage}</p>
                <p>Answers: powered by Customer Service</p>
              </div>
            </div>

            <div className="flex justify-between">
              <Button variant="outline" type="button" onClick={() => setStep(2)}>
                <ChevronLeft className="size-4 mr-1" /> Back
              </Button>
              <Button type="button" onClick={handleCreate} disabled={creating}>
                {creating ? 'Creating...' : 'Create Widget'}
              </Button>
            </div>
          </div>
        )}

        {/* Step 3: Post-creation deployment options */}
        {step === 3 && createdWidget && (
          <div>
            <div className="text-center mb-8">
              <div className="inline-flex items-center justify-center size-14 rounded-2xl bg-[rgba(16,185,129,.10)] mb-3">
                <Check className="size-7 text-[#047857] dark:text-[#34d399]" />
              </div>
              <h2 className="text-xl font-bold text-foreground mb-1">Widget Created</h2>
              <p className="text-sm text-muted-foreground">
                Choose how you want to deploy your chat widget.
              </p>
            </div>

            <div className="space-y-4">
              {/* Option 1: Shareable Link */}
              <div className="bg-card rounded-xl border border-border p-5">
                <div className="flex items-center gap-2.5 mb-3">
                  <div className="inline-flex items-center justify-center size-8 rounded-lg bg-accent/10">
                    <Globe className="size-4 text-accent" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">Shareable Link</h3>
                    <p className="text-xs text-muted-foreground">Share a branded chat page link with your customers</p>
                  </div>
                </div>
                <div className="bg-muted rounded-lg px-3 py-2.5 flex items-center gap-2 mb-2">
                  <code className="text-xs text-foreground flex-1 truncate font-mono">
                    {origin}/api/chat/page/{widgetSlug}
                  </code>
                  <Button variant="ghost" size="sm" type="button" onClick={copyLink} className="h-7 px-2 text-xs flex-shrink-0">
                    {copiedLink ? <Check className="size-3 mr-1 text-[#047857] dark:text-[#34d399]" /> : <Copy className="size-3 mr-1" />}
                    {copiedLink ? 'Copied!' : 'Copy'}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  This is the easiest option -- just share the link via email, social media, or anywhere else.
                </p>
              </div>

              {/* Option 2: Embed */}
              <div className="bg-card rounded-xl border border-border p-5">
                <div className="flex items-center gap-2.5 mb-3">
                  <div className="inline-flex items-center justify-center size-8 rounded-lg bg-accent/10">
                    <Code className="size-4 text-accent" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">Embed on Website</h3>
                    <p className="text-xs text-muted-foreground">Add a chat widget popup to your website</p>
                  </div>
                </div>
                <div className="bg-muted rounded-lg px-3 py-2.5 flex items-center gap-2 mb-2">
                  <code className="text-xs text-foreground flex-1 truncate font-mono">
                    {`<script src="${origin}/api/chat/widget/${createdWidget.id}" async></script>`}
                  </code>
                  <Button variant="ghost" size="sm" type="button" onClick={copyEmbed} className="h-7 px-2 text-xs flex-shrink-0">
                    {copiedEmbed ? <Check className="size-3 mr-1 text-[#047857] dark:text-[#34d399]" /> : <Copy className="size-3 mr-1" />}
                    {copiedEmbed ? 'Copied!' : 'Copy'}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Paste this script tag into your website's HTML, just before the closing &lt;/body&gt; tag.
                </p>
              </div>
            </div>

            <div className="flex justify-center mt-8">
              <Button type="button" onClick={onBack}>
                Done
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function ChatPage() {
  // Mode
  const [mode, setMode] = useState<PageMode>('landing')
  const [editingWidget, setEditingWidget] = useState<Widget | null>(null)

  // Core state
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [selectedConvId, setSelectedConvId] = useState<string | null>(null)
  const [selectedConv, setSelectedConv] = useState<Conversation | null>(null)
  const [contactInfo, setContactInfo] = useState<ContactInfo | null>(null)

  // UI state
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<'mine' | 'all' | 'closed'>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [showSidebar, setShowSidebar] = useState(true)
  const [showCannedManager, setShowCannedManager] = useState(false)
  const [showCloseDialog, setShowCloseDialog] = useState(false)
  const [closeNote, setCloseNote] = useState('')
  const [widgetFilter, setWidgetFilter] = useState<string>('all')
  const [showWidgetFilterDropdown, setShowWidgetFilterDropdown] = useState(false)

  // Canned responses
  const [cannedResponses, setCannedResponses] = useState<CannedResponse[]>([])
  const [showCannedPicker, setShowCannedPicker] = useState(false)
  const [cannedFilter, setCannedFilter] = useState('')

  // Widgets
  const [widgets, setWidgets] = useState<Widget[]>([])

  // New note
  const [newNote, setNewNote] = useState('')

  // Unread tracking
  const [unreadConvIds, setUnreadConvIds] = useState<Set<string>>(new Set())
  const [notificationsEnabled, setNotificationsEnabled] = useState(false)
  const [hasNewMessage, setHasNewMessage] = useState(false)

  // Refs
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const lastMessageCountRef = useRef<Record<string, number>>({})
  const unreadConvIdsRef = useRef(unreadConvIds)
  unreadConvIdsRef.current = unreadConvIds

  // Agent typing indicator
  const agentTypingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const agentTypingSentRef = useRef(false)

  const sendAgentTyping = useCallback((isTyping: boolean) => {
    if (!selectedConvId) return
    fetch('/api/chat/typing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ conversationId: selectedConvId, isTyping, sender: 'agent' }),
    }).catch(() => {})
  }, [selectedConvId])

  const { showToast, ToastContainer } = useToast()

  // Load canned responses from localStorage on mount
  useEffect(() => {
    setCannedResponses(loadCannedResponses())
  }, [])

  // Check notification permission
  useEffect(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      setNotificationsEnabled(true)
    }
  }, [])

  // ---------------------------------------------------------------------------
  // API Calls
  // ---------------------------------------------------------------------------

  const loadConversations = useCallback(async () => {
    try {
      const apiStatus = statusFilter === 'mine' ? 'open' : statusFilter === 'closed' ? 'closed' : 'open'
      const res = await fetch(`/api/chat/conversations?status=${statusFilter === 'all' ? 'open' : apiStatus}`, { credentials: 'include' })
      if (!res.ok) throw new Error(`Failed to load conversations (${res.status})`)
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || 'Failed to load conversations')

      const newConversations: Conversation[] = data.data

      // Check for new messages (for notifications + unread)
      const newUnread = new Set(unreadConvIdsRef.current)
      for (const conv of newConversations) {
        const prevCount = lastMessageCountRef.current[conv.id] || 0
        if (prevCount > 0 && conv.message_count > prevCount && conv.id !== selectedConvId) {
          newUnread.add(conv.id)
          setHasNewMessage(true)

          if (notificationsEnabled && conv.last_sender_type === 'visitor') {
            try {
              new Notification('New chat message', {
                body: `${conv.visitor_name || 'Visitor'}: ${conv.last_message || ''}`,
                icon: '/favicon.ico',
              })
            } catch { /* ignore */ }
          }
        }
        lastMessageCountRef.current[conv.id] = conv.message_count
      }
      setUnreadConvIds(newUnread)
      setConversations(newConversations)
    } catch {
      // Silent — polling will retry
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, selectedConvId, notificationsEnabled])

  const loadMessages = useCallback(async (convId: string) => {
    try {
      const res = await fetch(`/api/chat/conversations?conversationId=${convId}`, { credentials: 'include' })
      if (!res.ok) throw new Error(`Failed to load messages (${res.status})`)
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || 'Failed to load messages')
      setMessages(data.data.messages)
      setSelectedConv(data.data.conversation)
    } catch {
      // Silent — polling will retry
    }
  }, [])

  const loadContactInfo = useCallback(async (contactId: string) => {
    try {
      const res = await fetch(`/api/pipeline/contact-detail?id=${contactId}`, { credentials: 'include' })
      if (!res.ok) return
      const data = await res.json()
      if (data.ok) setContactInfo(data.data)
    } catch {
      // Non-critical, silently fail
    }
  }, [])

  const loadWidgets = useCallback(async () => {
    try {
      const res = await fetch('/api/chat/widgets', { credentials: 'include' })
      if (!res.ok) throw new Error(`Failed to load widgets (${res.status})`)
      const data = await res.json()
      if (data.ok) setWidgets(data.data)
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to load widgets')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------------

  // Load widgets on mount for the landing page
  useEffect(() => {
    loadWidgets()
  }, [loadWidgets])

  const initialLoadDone = useRef(false)
  useEffect(() => {
    if (!initialLoadDone.current) {
      setLoading(true)
      loadConversations().finally(() => { setLoading(false); initialLoadDone.current = true })
    } else {
      loadConversations()
    }
  }, [loadConversations])

  useEffect(() => {
    if (!selectedConvId) return
    loadMessages(selectedConvId)
    setUnreadConvIds(prev => {
      const next = new Set(prev)
      next.delete(selectedConvId)
      return next
    })

    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(() => {
      // Silent poll — don't show error toasts for background refreshes
      fetch(`/api/chat/conversations?conversationId=${selectedConvId}`, { credentials: 'include' })
        .then(r => r.ok ? r.json() : null)
        .then(data => { if (data?.ok) { setMessages(data.data.messages); setSelectedConv(data.data.conversation) } })
        .catch(() => {})
      fetch(`/api/chat/conversations?status=${statusFilter === 'closed' ? 'closed' : 'open'}`, { credentials: 'include' })
        .then(r => r.ok ? r.json() : null)
        .then(data => { if (data?.ok) setConversations(data.data) })
        .catch(() => {})
    }, 5000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [selectedConvId, loadMessages, loadConversations])

  useEffect(() => {
    if (selectedConv?.contact_id) {
      loadContactInfo(selectedConv.contact_id)
    } else {
      setContactInfo(null)
    }
  }, [selectedConv?.contact_id, loadContactInfo])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const sendReply = async () => {
    if (!reply.trim() || !selectedConvId) return
    setSending(true)
    // Clear agent typing on send
    if (agentTypingTimerRef.current) clearTimeout(agentTypingTimerRef.current)
    agentTypingSentRef.current = false
    sendAgentTyping(false)
    try {
      const res = await fetch('/api/chat/messages', { credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: selectedConvId, message: reply.trim() }),
      })
      if (!res.ok) throw new Error(`Failed to send message (${res.status})`)
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || 'Failed to send message')
      setReply('')
      setShowCannedPicker(false)
      loadMessages(selectedConvId)
      loadConversations()
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to send message')
    } finally {
      setSending(false)
    }
  }

  const closeConversation = async () => {
    if (!selectedConvId) return
    try {
      const res = await fetch('/api/chat/conversations', { credentials: 'include',
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: selectedConvId, status: 'closed' }),
      })
      if (!res.ok) throw new Error(`Failed to close conversation (${res.status})`)
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || 'Failed to close conversation')

      if (closeNote.trim()) {
        await fetch('/api/chat/messages', { credentials: 'include',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId: selectedConvId, message: `[Closed] ${closeNote.trim()}` }),
        })
      } else {
        await fetch('/api/chat/messages', { credentials: 'include',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId: selectedConvId, message: '[Conversation closed]' }),
        })
      }

      setShowCloseDialog(false)
      setCloseNote('')
      showToast('Conversation closed', 'success')
      loadConversations()
      loadMessages(selectedConvId)
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to close conversation')
    }
  }

  const requestNotifications = async () => {
    if (typeof Notification === 'undefined') {
      showToast('Notifications not supported in this browser')
      return
    }
    const permission = await Notification.requestPermission()
    setNotificationsEnabled(permission === 'granted')
    if (permission === 'granted') {
      showToast('Browser notifications enabled', 'success')
    } else {
      showToast('Notification permission denied')
    }
  }

  // Widget actions
  const createWidgetFromWizard = async (data: WizardData) => {
    const res = await fetch('/api/chat/widgets', {
      credentials: 'include',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: data.name,
        businessName: data.businessName,
        welcomeMessage: data.welcomeMessage,
        brandColor: data.brandColor,
        greetingMessage: data.welcomeMessage,
        slug: slugify(data.name),
        publicPageEnabled: true,
        config: { primaryColor: data.brandColor, position: 'bottom-right' },
      }),
    })
    if (!res.ok) {
      const errorData = await res.json().catch(() => null)
      throw new Error(errorData?.error || `Failed to create widget (${res.status})`)
    }
    const result = await res.json()
    if (!result.ok) throw new Error(result.error || 'Failed to create widget')
    showToast('Widget created!', 'success')
    await loadWidgets()
    return result.data
  }

  const deleteWidget = async (id: string) => {
    try {
      const res = await fetch(`/api/chat/widgets?id=${id}`, { credentials: 'include', method: 'DELETE' })
      if (!res.ok) throw new Error(`Failed to delete widget (${res.status})`)
      showToast('Widget deleted', 'success')
      loadWidgets()
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to delete widget')
    }
  }

  const toggleWidgetActive = async (id: string, active: boolean) => {
    try {
      const res = await fetch(`/api/chat/widgets?id=${id}`, {
        credentials: 'include',
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: active }),
      })
      if (!res.ok) throw new Error('Failed to update widget')
      showToast(active ? 'Widget activated' : 'Widget deactivated', 'success')
      loadWidgets()
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to update widget')
    }
  }

  // Canned response actions
  const insertCannedResponse = (response: CannedResponse) => {
    setReply(response.text)
    setShowCannedPicker(false)
    setCannedFilter('')
    composerRef.current?.focus()
  }

  const addCannedResponse = (shortcut: string, text: string) => {
    const updated = [...cannedResponses, { id: String(Date.now()), shortcut, text }]
    setCannedResponses(updated)
    saveCannedResponses(updated)
  }

  const removeCannedResponse = (id: string) => {
    const updated = cannedResponses.filter(r => r.id !== id)
    setCannedResponses(updated)
    saveCannedResponses(updated)
  }

  // Composer key handler
  const handleComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (showCannedPicker) {
        const filtered = cannedResponses.filter(r =>
          r.shortcut.toLowerCase().includes(cannedFilter.toLowerCase()) ||
          r.text.toLowerCase().includes(cannedFilter.toLowerCase())
        )
        if (filtered.length > 0) {
          insertCannedResponse(filtered[0])
        }
      } else {
        sendReply()
      }
    }
    if (e.key === 'Escape') {
      setShowCannedPicker(false)
      setCannedFilter('')
    }
  }

  const handleComposerChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    setReply(value)

    // Agent typing indicator
    if (value.trim() && !agentTypingSentRef.current) {
      agentTypingSentRef.current = true
      sendAgentTyping(true)
    }
    if (agentTypingTimerRef.current) clearTimeout(agentTypingTimerRef.current)
    agentTypingTimerRef.current = setTimeout(() => {
      agentTypingSentRef.current = false
      sendAgentTyping(false)
    }, 2000)

    // Detect "/" trigger for canned responses
    if (value.endsWith('/') || (value.includes('/') && showCannedPicker)) {
      const slashIdx = value.lastIndexOf('/')
      if (slashIdx >= 0) {
        const afterSlash = value.substring(slashIdx + 1)
        setCannedFilter(afterSlash)
        setShowCannedPicker(true)
      }
    } else if (!value.includes('/')) {
      setShowCannedPicker(false)
      setCannedFilter('')
    }
  }

  // ---------------------------------------------------------------------------
  // Filtered conversations
  // ---------------------------------------------------------------------------

  const filteredConversations = useMemo(() => {
    let list = conversations
    if (widgetFilter !== 'all') {
      list = list.filter(c => c.widget_id === widgetFilter)
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      list = list.filter(c =>
        (c.visitor_name?.toLowerCase().includes(q)) ||
        (c.visitor_email?.toLowerCase().includes(q)) ||
        (c.last_message?.toLowerCase().includes(q))
      )
    }
    return list
  }, [conversations, searchQuery, widgetFilter])

  const filteredCanned = useMemo(() => {
    if (!cannedFilter) return cannedResponses
    const q = cannedFilter.toLowerCase()
    return cannedResponses.filter(r =>
      r.shortcut.toLowerCase().includes(q) || r.text.toLowerCase().includes(q)
    )
  }, [cannedResponses, cannedFilter])

  // ---------------------------------------------------------------------------
  // Widget Management Panel (edit mode for existing widgets)
  // ---------------------------------------------------------------------------

  if (editingWidget) {
    return (
      <div className="h-[calc(100vh-64px)] bg-background overflow-y-auto">
        <div className="max-w-3xl mx-auto p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-xl font-semibold text-foreground">Edit Widget: {editingWidget.name}</h1>
              <p className="text-sm text-muted-foreground mt-1">Manage settings, bot configuration, and deployment</p>
            </div>
            <Button variant="outline" size="sm" type="button" onClick={() => { setEditingWidget(null); loadWidgets() }}>
              <ArrowLeft className="size-4 mr-1.5" /> Back
            </Button>
          </div>
          <WidgetCard
            widget={editingWidget}
            copiedId={null}
            onCopy={(w) => {
              navigator.clipboard.writeText(w.embedCode)
              showToast('Embed code copied', 'success')
            }}
            onDelete={async (id) => {
              await deleteWidget(id)
              setEditingWidget(null)
            }}
            onUpdate={async (id, updates) => {
              try {
                const res = await fetch(`/api/chat/widgets?id=${id}`, {
                  credentials: 'include',
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(updates),
                })
                if (!res.ok) throw new Error('Failed to update widget')
                const data = await res.json()
                if (!data.ok) throw new Error(data.error || 'Failed to update widget')
                showToast('Widget updated', 'success')
                // Refresh the editing widget
                const widgetsRes = await fetch('/api/chat/widgets', { credentials: 'include' })
                const widgetsData = await widgetsRes.json()
                if (widgetsData.ok) {
                  setWidgets(widgetsData.data)
                  const updated = widgetsData.data.find((w: Widget) => w.id === id)
                  if (updated) setEditingWidget(updated)
                }
              } catch (err) {
                showToast(err instanceof Error ? err.message : 'Failed to update widget')
              }
            }}
          />
        </div>
        <ToastContainer />
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // Canned Response Manager
  // ---------------------------------------------------------------------------

  if (showCannedManager) {
    return (
      <div className="h-[calc(100vh-64px)] bg-background overflow-y-auto">
        <div className="max-w-2xl mx-auto p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-xl font-semibold text-foreground">Canned Responses</h1>
              <p className="text-sm text-muted-foreground mt-1">Quick reply templates triggered with &quot;/&quot; in the composer</p>
            </div>
            <Button variant="outline" size="sm" type="button" onClick={() => setShowCannedManager(false)}>
              Back to Inbox
            </Button>
          </div>

          <CannedResponseEditor
            responses={cannedResponses}
            onAdd={addCannedResponse}
            onRemove={removeCannedResponse}
          />
        </div>
        <ToastContainer />
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // Landing Page Mode
  // ---------------------------------------------------------------------------

  if (mode === 'landing') {
    return (
      <>
        <LandingPage
          widgets={widgets}
          conversations={conversations}
          onCreateWidget={() => setMode('wizard')}
          onOpenInbox={() => setMode('inbox')}
          onEditWidget={(w) => setEditingWidget(w)}
          onDeleteWidget={deleteWidget}
          onToggleWidgetActive={toggleWidgetActive}
          showToast={showToast}
        />
        <ToastContainer />
      </>
    )
  }

  // ---------------------------------------------------------------------------
  // Wizard Mode
  // ---------------------------------------------------------------------------

  if (mode === 'wizard') {
    return (
      <>
        <CreationWizard
          onBack={() => setMode('landing')}
          onCreate={createWidgetFromWizard}
          showToast={showToast}
        />
        <ToastContainer />
      </>
    )
  }

  // ---------------------------------------------------------------------------
  // Inbox Mode (existing chat interface)
  // ---------------------------------------------------------------------------

  return (
    <div className="h-[calc(100vh-64px)] flex bg-background">
      {/* ===== LEFT PANEL: Conversation List ===== */}
      <div className="w-[280px] border-r border-border flex flex-col bg-card flex-shrink-0">
        {/* Header */}
        <div className="p-3 border-b border-border">
          <div className="flex items-center justify-between mb-2.5">
            <div className="flex items-center gap-2">
              <IconButton
                variant="ghost"
                size="xs"
                type="button"
                onClick={() => setMode('landing')}
                aria-label="Back to Chat"
              >
                <ArrowLeft className="size-3.5" />
              </IconButton>
              <h2 className="text-base font-semibold text-foreground">Inbox</h2>
            </div>
            <div className="flex items-center gap-1">
              <IconButton
                variant="ghost"
                size="xs"
                type="button"
                onClick={requestNotifications}
                aria-label={notificationsEnabled ? 'Notifications enabled' : 'Enable notifications'}
              >
                {notificationsEnabled
                  ? <Bell className="size-3.5 text-accent" />
                  : <BellOff className="size-3.5 text-muted-foreground" />
                }
              </IconButton>
              <IconButton
                variant="ghost"
                size="xs"
                type="button"
                onClick={() => setShowCannedManager(true)}
                aria-label="Canned responses"
              >
                <Zap className="size-3.5" />
              </IconButton>
              <IconButton
                variant="ghost"
                size="xs"
                type="button"
                onClick={() => setMode('landing')}
                aria-label="Widget settings"
                title="Widget settings"
              >
                <Settings className="size-3.5" />
              </IconButton>
            </div>
          </div>

          {/* Widget filter dropdown */}
          <div className="relative mb-2.5">
            <button
              type="button"
              onClick={() => setShowWidgetFilterDropdown(!showWidgetFilterDropdown)}
              className="w-full flex items-center justify-between text-xs bg-muted/50 rounded-md px-2.5 py-1.5 hover:bg-muted transition-colors"
            >
              <span className="text-muted-foreground truncate">
                {widgetFilter === 'all'
                  ? 'All Widgets'
                  : widgets.find(w => w.id === widgetFilter)?.name || 'All Widgets'
                }
              </span>
              <ChevronDown className="size-3 text-muted-foreground flex-shrink-0" />
            </button>
            {showWidgetFilterDropdown && (
              <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-popover border border-border rounded-lg shadow-lg max-h-48 overflow-y-auto">
                <button
                  type="button"
                  onClick={() => { setWidgetFilter('all'); setShowWidgetFilterDropdown(false) }}
                  className={`w-full text-left px-3 py-2 text-xs hover:bg-muted transition-colors ${widgetFilter === 'all' ? 'text-accent font-medium' : 'text-foreground'}`}
                >
                  All Widgets
                </button>
                {widgets.map(w => (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => { setWidgetFilter(w.id); setShowWidgetFilterDropdown(false) }}
                    className={`w-full text-left px-3 py-2 text-xs hover:bg-muted transition-colors border-t border-border/50 ${widgetFilter === w.id ? 'text-accent font-medium' : 'text-foreground'}`}
                  >
                    {w.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Status tabs */}
          <div className="flex gap-0.5 mb-2.5">
            {(['mine', 'all', 'closed'] as const).map((tab) => (
              <Button
                key={tab}
                type="button"
                variant="ghost"
                size="sm"
                className={`h-7 px-2.5 text-xs capitalize flex-1 ${
                  statusFilter === tab
                    ? 'bg-accent/10 text-accent font-medium'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                onClick={() => setStatusFilter(tab)}
              >
                {tab}
              </Button>
            ))}
          </div>

          {/* Search */}
          <div className="relative">
            <Search className="size-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search conversations..."
              className="h-8 pl-8 text-xs"
            />
          </div>
        </div>

        {/* Conversation List */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-6 text-center">
              <div className="size-6 border-2 border-accent/30 border-t-accent rounded-full animate-spin mx-auto mb-2" />
              <p className="text-xs text-muted-foreground">Loading conversations...</p>
            </div>
          ) : filteredConversations.length === 0 ? (
            <div className="p-6 text-center">
              <MessageCircle className="size-8 mx-auto mb-2 text-muted-foreground/30" />
              {searchQuery ? (
                <p className="text-sm text-muted-foreground">No matching conversations</p>
              ) : (
                <>
                  <p className="text-sm font-medium text-foreground mb-1">No conversations yet</p>
                  <p className="text-xs text-muted-foreground mb-4">
                    Conversations will appear here when visitors start chatting through your widgets.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="text-xs"
                    onClick={() => setMode('landing')}
                  >
                    <ArrowLeft className="size-3.5 mr-1.5" /> Back to Chat
                  </Button>
                </>
              )}
            </div>
          ) : (
            filteredConversations.map((conv) => {
              const isSelected = selectedConvId === conv.id
              const isUnread = unreadConvIds.has(conv.id)
              const displayName = conv.visitor_name || conv.visitor_email || 'Anonymous Visitor'
              return (
                <button
                  key={conv.id}
                  type="button"
                  onClick={() => setSelectedConvId(conv.id)}
                  className={`w-full text-left px-3 py-3 border-b border-border/50 transition-colors cursor-pointer ${
                    isSelected
                      ? 'bg-accent/8'
                      : 'hover:bg-muted/50'
                  }`}
                  style={{ height: 'auto', minHeight: '64px' }}
                >
                  <div className="flex gap-2.5">
                    <Avatar name={conv.visitor_name} email={conv.visitor_email} size="sm" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2 mb-0.5">
                        <span className={`text-[13px] truncate ${isUnread ? 'font-semibold text-foreground' : 'font-medium text-foreground'}`}>
                          {displayName}
                        </span>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          {isUnread && <UnreadDot />}
                          <span className="text-[10px] text-muted-foreground">
                            {formatRelativeTime(conv.last_message_at || conv.updated_at)}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <StatusDot status={conv.status} />
                        <p className={`text-xs truncate ${isUnread ? 'text-foreground' : 'text-muted-foreground'}`}>
                          {conv.last_sender_type === 'business' && <span className="text-muted-foreground">You: </span>}
                          {conv.last_message || 'No messages'}
                        </p>
                      </div>
                    </div>
                  </div>
                </button>
              )
            })
          )}
        </div>

        {/* New message indicator */}
        {hasNewMessage && selectedConvId && (
          <div className="px-3 py-2 border-t border-border bg-accent/5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full h-7 text-xs text-accent"
              onClick={() => { setHasNewMessage(false); loadConversations() }}
            >
              New messages available
            </Button>
          </div>
        )}
      </div>

      {/* ===== CENTER PANEL: Message Thread ===== */}
      <div className="flex-1 flex flex-col min-w-0">
        {!selectedConvId ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center max-w-sm">
              <MessageCircle className="size-12 mx-auto mb-3 text-muted-foreground/20" />
              {filteredConversations.length === 0 ? (
                <>
                  <p className="text-base font-medium text-foreground mb-1">No conversations</p>
                  <p className="text-sm text-muted-foreground mb-5">
                    Conversations will appear here when visitors start chatting through your widgets.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-base font-medium text-muted-foreground">Select a conversation</p>
                  <p className="text-sm text-muted-foreground/60 mt-1">Choose a chat from the left to start replying</p>
                </>
              )}
            </div>
          </div>
        ) : (
          <>
            {/* Message Header */}
            <div className="bg-card border-b border-border px-4 py-3 flex items-center justify-between flex-shrink-0">
              <div className="flex items-center gap-3">
                <Avatar name={selectedConv?.visitor_name ?? null} email={selectedConv?.visitor_email ?? null} />
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-foreground">
                      {selectedConv?.visitor_name || selectedConv?.visitor_email || 'Anonymous Visitor'}
                    </h3>
                    <Badge variant={selectedConv?.status === 'open' ? 'default' : 'secondary'} className="text-[10px] h-5">
                      {selectedConv?.status}
                    </Badge>
                  </div>
                  {selectedConv?.visitor_email && selectedConv?.visitor_name && (
                    <p className="text-xs text-muted-foreground">{selectedConv.visitor_email}</p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {selectedConv?.status === 'open' && (
                  <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    onClick={() => setShowCloseDialog(true)}
                    className="text-xs"
                  >
                    Close
                  </Button>
                )}
                <IconButton
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={() => setShowSidebar(!showSidebar)}
                  aria-label={showSidebar ? 'Hide sidebar' : 'Show sidebar'}
                >
                  {showSidebar ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
                </IconButton>
              </div>
            </div>

            {/* Close Conversation Dialog */}
            {showCloseDialog && (
              <div className="bg-card border-b border-border px-4 py-3 flex items-center gap-3">
                <span className="text-sm text-muted-foreground">Close note (optional):</span>
                <Input
                  value={closeNote}
                  onChange={(e) => setCloseNote(e.target.value)}
                  placeholder="Add a note about this conversation..."
                  className="flex-1 h-8 text-sm"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') closeConversation()
                    if (e.key === 'Escape') { setShowCloseDialog(false); setCloseNote('') }
                  }}
                />
                <Button type="button" size="sm" onClick={closeConversation} className="text-xs">
                  Close Conversation
                </Button>
                <IconButton variant="ghost" size="xs" type="button" onClick={() => { setShowCloseDialog(false); setCloseNote('') }} aria-label="Cancel">
                  <X className="size-3.5" />
                </IconButton>
              </div>
            )}

            {/* Messages Area */}
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-1">
              {messages.map((msg, idx) => {
                const prevMsg = idx > 0 ? messages[idx - 1] : null
                const showTimestamp = !prevMsg ||
                  (new Date(msg.created_at).getTime() - new Date(prevMsg.created_at).getTime() > 300000) ||
                  prevMsg.sender_type !== msg.sender_type

                if (msg.sender_type === 'system') {
                  return (
                    <div key={msg.id} className="flex justify-center py-2">
                      <span className="text-[11px] text-muted-foreground bg-muted px-3 py-1 rounded-full">
                        {msg.message}
                      </span>
                    </div>
                  )
                }

                const isVisitor = msg.sender_type === 'visitor'
                return (
                  <div key={msg.id} className={`flex ${isVisitor ? 'justify-start' : 'justify-end'} ${showTimestamp ? 'mt-3' : 'mt-0.5'}`}>
                    <div className={`max-w-[65%] group`}>
                      <div
                        className={`px-3.5 py-2.5 text-[13px] leading-relaxed ${
                          isVisitor
                            ? 'bg-muted text-foreground rounded-2xl rounded-bl-md'
                            : 'bg-accent text-accent-foreground rounded-2xl rounded-br-md'
                        }`}
                      >
                        <p className="whitespace-pre-wrap break-words">{msg.message}</p>
                      </div>
                      <div className={`flex items-center gap-1.5 mt-1 ${isVisitor ? 'justify-start' : 'justify-end'}`}>
                        {showTimestamp && (
                          <span className="text-[10px] text-muted-foreground">
                            {formatMessageTime(msg.created_at)}
                          </span>
                        )}
{/* Bot indicator removed — AI disclaimer shown below input instead */}
                      </div>
                    </div>
                  </div>
                )
              })}
              <div ref={messagesEndRef} />
            </div>

            {/* Visitor Typing Indicator */}
            {selectedConv?.visitor_typing && selectedConv?.visitor_typing_at &&
              (Date.now() - new Date(selectedConv.visitor_typing_at).getTime() < 5000) && (
              <div className="flex items-center gap-1.5 px-4 py-2 text-xs text-muted-foreground">
                <div className="flex items-center gap-0.5">
                  <span className="size-1.5 rounded-full bg-muted-foreground/50 animate-pulse" style={{ animationDelay: '0ms' }} />
                  <span className="size-1.5 rounded-full bg-muted-foreground/50 animate-pulse" style={{ animationDelay: '200ms' }} />
                  <span className="size-1.5 rounded-full bg-muted-foreground/50 animate-pulse" style={{ animationDelay: '400ms' }} />
                </div>
                <span>{selectedConv?.visitor_name || 'Visitor'} is typing...</span>
              </div>
            )}

            {/* Composer */}
            <div className="bg-card border-t border-border p-3 flex-shrink-0 relative">
              {/* Canned Response Picker */}
              {showCannedPicker && filteredCanned.length > 0 && (
                <div className="absolute bottom-full left-3 right-3 mb-1 bg-popover border border-border rounded-lg shadow-lg max-h-48 overflow-y-auto">
                  {filteredCanned.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => insertCannedResponse(r)}
                      className="w-full text-left px-3 py-2 hover:bg-muted transition-colors border-b border-border/50 last:border-0"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono text-accent">/{r.shortcut}</span>
                        <span className="text-xs text-muted-foreground truncate">{r.text}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              <div className="flex items-end gap-2">
                <div className="flex-1 relative">
                  <Textarea
                    ref={composerRef}
                    value={reply}
                    onChange={handleComposerChange}
                    onKeyDown={handleComposerKeyDown}
                    placeholder='Type a message... (/ for quick replies)'
                    disabled={sending || selectedConv?.status === 'closed'}
                    className="min-h-[40px] max-h-[120px] resize-none text-sm pr-10"
                    rows={1}
                  />
                  <IconButton
                    variant="ghost"
                    size="xs"
                    type="button"
                    className="absolute right-1 bottom-1"
                    aria-label="Attach file (coming soon)"
                    disabled
                    title="File attachments coming soon"
                  >
                    <Paperclip className="size-3.5 text-muted-foreground" />
                  </IconButton>
                </div>
                <Button
                  type="button"
                  onClick={sendReply}
                  disabled={!reply.trim() || sending || selectedConv?.status === 'closed'}
                  className="h-10 px-4"
                >
                  <Send className="size-4" />
                </Button>
              </div>
              {selectedConv?.status === 'closed' ? (
                <p className="text-[11px] text-muted-foreground mt-1.5 text-center">This conversation is closed</p>
              ) : (
                <p className="text-[10px] text-muted-foreground/60 mt-1 text-center">AI can make mistakes. Please double check responses.</p>
              )}
            </div>
          </>
        )}
      </div>

      {/* ===== RIGHT PANEL: Contact Sidebar ===== */}
      {showSidebar && selectedConvId && (
        <div className="w-[300px] border-l border-border bg-card flex-shrink-0 overflow-y-auto">
          <div className="p-4">
            {/* Contact Card */}
            <div className="text-center pb-4 border-b border-border mb-4">
              <Avatar
                name={contactInfo?.first_name ? `${contactInfo.first_name} ${contactInfo.last_name || ''}` : selectedConv?.visitor_name ?? null}
                email={(contactInfo?.email || selectedConv?.visitor_email) ?? null}
                size="lg"
              />
              <h3 className="text-sm font-semibold text-foreground mt-2">
                {contactInfo
                  ? [contactInfo.first_name, contactInfo.last_name].filter(Boolean).join(' ') || 'No Name'
                  : selectedConv?.visitor_name || 'Anonymous Visitor'
                }
              </h3>
              {(contactInfo?.email || selectedConv?.visitor_email) && (
                <div className="flex items-center justify-center gap-1.5 mt-1">
                  <Mail className="size-3 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">{contactInfo?.email || selectedConv?.visitor_email}</span>
                </div>
              )}
              {contactInfo?.phone && (
                <div className="flex items-center justify-center gap-1.5 mt-0.5">
                  <Phone className="size-3 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">{contactInfo.phone}</span>
                </div>
              )}
              {!contactInfo && !selectedConv?.contact_id && (
                <Button variant="outline" size="sm" type="button" className="mt-2 text-xs h-7">
                  Link to Contact
                </Button>
              )}
            </div>

            {/* Details */}
            <div className="space-y-3 pb-4 border-b border-border mb-4">
              <DetailRow icon={Zap} label="Source" value={contactInfo?.source || 'Chat'} />
              <DetailRow icon={Tag} label="Stage" value={contactInfo?.lifecycle_stage || 'Prospect'} />
              <DetailRow
                icon={Calendar}
                label="Created"
                value={formatRelativeTime(contactInfo?.created_at || selectedConv?.created_at || null)}
              />
            </div>

            {/* Notes Section */}
            <div className="pb-4 border-b border-border mb-4">
              <h4 className="text-xs font-semibold text-foreground uppercase tracking-wider mb-2">Notes</h4>
              {contactInfo?.notes && contactInfo.notes.length > 0 ? (
                <div className="space-y-2 mb-2">
                  {contactInfo.notes.slice(0, 3).map((note) => (
                    <div key={note.id} className="bg-muted rounded-md p-2">
                      <p className="text-xs text-foreground">{note.content}</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">{formatRelativeTime(note.created_at)}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground mb-2">No notes yet</p>
              )}
              <div className="flex gap-1.5">
                <Input
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder="Add a note..."
                  className="h-7 text-xs"
                  onKeyDown={(e) => e.key === 'Enter' && setNewNote('')}
                />
                <Button variant="outline" size="sm" type="button" className="h-7 text-xs px-2" disabled={!newNote.trim()}>
                  <Plus className="size-3" />
                </Button>
              </div>
            </div>

            {/* Deals Section */}
            <div className="pb-4 border-b border-border mb-4">
              <h4 className="text-xs font-semibold text-foreground uppercase tracking-wider mb-2">Deals</h4>
              {contactInfo?.deals && contactInfo.deals.length > 0 ? (
                <div className="space-y-2 mb-2">
                  {contactInfo.deals.map((deal) => (
                    <div key={deal.id} className="bg-muted rounded-md p-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-foreground">{deal.title}</span>
                        <span className="text-xs text-muted-foreground">${deal.value.toLocaleString()}</span>
                      </div>
                      <Badge variant="secondary" className="text-[10px] h-4 mt-1">{deal.stage}</Badge>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground mb-2">No deals</p>
              )}
              <Button variant="outline" size="sm" type="button" className="w-full h-7 text-xs">
                <Plus className="size-3 mr-1" /> Create Deal
              </Button>
            </div>

            {/* Tags Section */}
            <div>
              <h4 className="text-xs font-semibold text-foreground uppercase tracking-wider mb-2">Tags</h4>
              {contactInfo?.tags && contactInfo.tags.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {contactInfo.tags.map((tag) => (
                    <Badge key={tag} variant="secondary" className="text-[10px]">{tag}</Badge>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No tags</p>
              )}
            </div>
          </div>
        </div>
      )}

      <ToastContainer />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Detail Row
// ---------------------------------------------------------------------------

function DetailRow({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="size-3.5 text-muted-foreground flex-shrink-0" />
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xs text-foreground ml-auto">{value}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Widget Card
// ---------------------------------------------------------------------------

function WidgetCard({
  widget,
  copiedId,
  onCopy,
  onDelete,
  onUpdate,
}: {
  widget: Widget
  copiedId: string | null
  onCopy: (w: Widget) => void
  onDelete: (id: string) => void
  onUpdate: (id: string, updates: Record<string, unknown>) => Promise<void>
}) {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const [copiedLink, setCopiedLink] = useState(false)
  const [copiedEmbed, setCopiedEmbed] = useState(false)

  return (
    <div className="bg-card rounded-lg border border-border p-5">
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="font-medium text-foreground">{widget.name}</h3>
          <p className="text-sm text-muted-foreground mt-0.5">{widget.greeting_message}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={widget.is_active ? 'default' : 'secondary'}>
            {widget.is_active ? 'Active' : 'Inactive'}
          </Badge>
          <IconButton variant="ghost" size="sm" type="button" onClick={() => onDelete(widget.id)} aria-label="Delete widget">
            <Trash2 className="size-4 text-destructive" />
          </IconButton>
        </div>
      </div>

      {/* Deployment Options */}
      <div className="space-y-3 mb-3">
        {/* Shareable Link */}
        {widget.slug && (
          <div className="bg-muted rounded-md p-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <Globe className="size-3" /> Public Chat Link
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(`${origin}/api/chat/page/${widget.slug}`)
                    setCopiedLink(true)
                    setTimeout(() => setCopiedLink(false), 2000)
                  }}
                  className="h-auto py-0.5 px-2 text-xs"
                >
                  {copiedLink ? <Check className="size-3 mr-1 text-[#047857] dark:text-[#34d399]" /> : <Copy className="size-3 mr-1" />}
                  {copiedLink ? 'Copied!' : 'Copy'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={() => window.open(`/api/chat/page/${widget.slug}`, '_blank')}
                  className="h-auto py-0.5 px-2 text-xs"
                >
                  <ExternalLink className="size-3 mr-1" /> Open
                </Button>
              </div>
            </div>
            <code className="text-xs text-muted-foreground break-all block leading-relaxed">
              {origin}/api/chat/page/{widget.slug}
            </code>
          </div>
        )}

        {/* Embed Code */}
        <div className="bg-muted rounded-md p-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Code className="size-3" /> Embed Code
            </span>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(widget.embedCode)
                setCopiedEmbed(true)
                setTimeout(() => setCopiedEmbed(false), 2000)
              }}
              className="h-auto py-0.5 px-2 text-xs"
            >
              {copiedEmbed ? <Check className="size-3 mr-1 text-[#047857] dark:text-[#34d399]" /> : <Copy className="size-3 mr-1" />}
              {copiedEmbed ? 'Copied!' : 'Copy'}
            </Button>
          </div>
          <code className="text-xs text-muted-foreground break-all block leading-relaxed">{widget.embedCode}</code>
        </div>
      </div>

      {/* Website chat is powered by Customer Service. Answers, knowledge, and
          escalation are configured there, not on the widget. */}
      <div className="rounded-lg border border-border bg-muted/40 px-4 py-3">
        <div className="flex items-start gap-2.5">
          <Headphones className="size-4 text-[#6d28d9] dark:text-[#c4b5fd] mt-0.5 shrink-0" />
          <div className="text-sm text-muted-foreground">
            <p className="text-foreground font-medium">Chat is now powered by Customer Service.</p>
            <p className="mt-0.5">
              Set up answers, knowledge, and escalation in{' '}
              <a href="/backend/customer-service" className="text-accent font-medium hover:underline">Customer Service settings</a>.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Canned Response Editor
// ---------------------------------------------------------------------------

function CannedResponseEditor({
  responses,
  onAdd,
  onRemove,
}: {
  responses: CannedResponse[]
  onAdd: (shortcut: string, text: string) => void
  onRemove: (id: string) => void
}) {
  const [newShortcut, setNewShortcut] = useState('')
  const [newText, setNewText] = useState('')

  const handleAdd = () => {
    if (!newShortcut.trim() || !newText.trim()) return
    onAdd(newShortcut.trim().replace(/^\//, ''), newText.trim())
    setNewShortcut('')
    setNewText('')
  }

  return (
    <div>
      <div className="bg-card rounded-lg border border-border p-5 mb-4">
        <h2 className="text-sm font-semibold text-foreground mb-3">Add New Response</h2>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Shortcut (without /)</label>
            <Input
              value={newShortcut}
              onChange={(e) => setNewShortcut(e.target.value)}
              placeholder="e.g. hello"
              className="h-8 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Response text</label>
            <Textarea
              value={newText}
              onChange={(e) => setNewText(e.target.value)}
              placeholder="The text that will be inserted..."
              className="text-sm"
              rows={2}
            />
          </div>
          <Button type="button" size="sm" onClick={handleAdd} disabled={!newShortcut.trim() || !newText.trim()}>
            <Plus className="size-4 mr-1" /> Add Response
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        {responses.map((r) => (
          <div key={r.id} className="bg-card rounded-lg border border-border p-4 flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-1">
                <Slash className="size-3 text-accent" />
                <span className="text-sm font-mono font-medium text-accent">{r.shortcut}</span>
              </div>
              <p className="text-sm text-muted-foreground">{r.text}</p>
            </div>
            <IconButton variant="ghost" size="xs" type="button" onClick={() => onRemove(r.id)} aria-label="Remove response">
              <Trash2 className="size-3.5 text-destructive" />
            </IconButton>
          </div>
        ))}
      </div>
    </div>
  )
}
