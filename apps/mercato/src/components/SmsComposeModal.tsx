'use client'

import { useState } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { X, Send, Loader2, MessageSquare } from 'lucide-react'

interface SmsComposeProps {
  contactName: string
  contactPhone: string
  contactId?: string
  onClose: () => void
  onSent?: () => void
}

export function SmsComposeModal({ contactName, contactPhone, contactId, onClose, onSent }: SmsComposeProps) {
  const [to, setTo] = useState(contactPhone)
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function sendSms() {
    if (!to || !message.trim()) return
    setSending(true)
    setError(null)
    try {
      const res = await fetch('/api/sms', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ to, message: message.trim(), contactId }),
      })
      const data = await res.json()
      if (data.ok) {
        setSent(true)
        setTimeout(() => { onSent?.(); onClose() }, 1500)
      } else {
        setError(data.error || 'Failed to send')
      }
    } catch {
      setError('Failed to send')
    }
    setSending(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-background rounded-xl border shadow-2xl w-full max-w-md mx-4">
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h2 className="text-sm font-semibold">{sent ? 'SMS Sent' : `Text ${contactName}`}</h2>
          <button type="button" onClick={onClose}
            className="w-7 h-7 rounded-md hover:bg-muted flex items-center justify-center text-muted-foreground">
            <X className="size-4" />
          </button>
        </div>

        {sent ? (
          <div className="p-8 text-center">
            <div className="w-12 h-12 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center mx-auto mb-3">
              <MessageSquare className="size-5 text-emerald-600 dark:text-emerald-400" />
            </div>
            <p className="text-sm font-medium">SMS sent to {contactName}</p>
          </div>
        ) : (
          <>
            <div className="px-5 py-4 space-y-3">
              {error && <p className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded">{error}</p>}
              <div>
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">To</label>
                <input value={to} onChange={e => setTo(e.target.value)} type="tel"
                  className="w-full h-9 rounded-md border bg-card px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring" />
              </div>
              <div>
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Message</label>
                <textarea value={message} onChange={e => setMessage(e.target.value)}
                  placeholder="Type your message..."
                  className="w-full rounded-md border bg-card px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring h-24"
                  maxLength={1600} autoFocus />
                <p className="text-[10px] text-muted-foreground text-right mt-1">{message.length}/1600</p>
              </div>
            </div>
            <div className="px-5 py-3 border-t flex items-center justify-between">
              <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
              <Button type="button" size="sm" onClick={sendSms} disabled={sending || !to || !message.trim()}>
                {sending ? <><Loader2 className="size-3 animate-spin mr-1.5" /> Sending...</> : <><Send className="size-3.5 mr-1.5" /> Send SMS</>}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
