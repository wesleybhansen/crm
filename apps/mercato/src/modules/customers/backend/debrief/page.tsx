'use client'

import { useEffect, useRef, useState } from 'react'
import { Mic, MicOff, Loader2, CheckCircle2, Copy, ClipboardList, Handshake, StickyNote } from 'lucide-react'

/* Voice debrief: hang up, talk for 60 seconds, and the call becomes records.
 * Browser speech recognition (free, on-device where supported) fills the
 * transcript; typing works everywhere as the fallback. One submit creates the
 * call note, tasks, and commitments, and returns a follow-up draft to review. */

type DebriefResult = {
  noteSummary: string | null
  noteSaved: boolean
  tasksCreated: number
  commitmentsCreated: number
  emailDraft: { subject: string; body: string } | null
  contactName: string | null
}

type ContactHit = { id: string; name: string; email?: string }

export default function DebriefPage() {
  const [transcript, setTranscript] = useState('')
  const [listening, setListening] = useState(false)
  const [speechSupported, setSpeechSupported] = useState(false)
  const [contactQuery, setContactQuery] = useState('')
  const [contactHits, setContactHits] = useState<ContactHit[]>([])
  const [contact, setContact] = useState<ContactHit | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<DebriefResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const recognitionRef = useRef<any>(null)

  useEffect(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    setSpeechSupported(Boolean(SR))
  }, [])

  // Contact search (debounced)
  useEffect(() => {
    if (contactQuery.trim().length < 2 || contact) {
      setContactHits([])
      return
    }
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/customers/people?search=${encodeURIComponent(contactQuery.trim())}&limit=5`, { credentials: 'include' })
        const d = await res.json()
        const items = (d?.data ?? d?.items ?? []) as Array<Record<string, any>>
        setContactHits(
          items.slice(0, 5).map((c) => ({
            id: c.id ?? c.entity_id,
            name: c.display_name ?? c.name ?? [c.first_name, c.last_name].filter(Boolean).join(' ') ?? c.primary_email ?? 'Unknown',
            email: c.primary_email ?? c.email,
          })),
        )
      } catch {
        setContactHits([])
      }
    }, 250)
    return () => clearTimeout(t)
  }, [contactQuery, contact])

  const toggleListening = () => {
    if (listening) {
      recognitionRef.current?.stop()
      setListening(false)
      return
    }
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) return
    const rec = new SR()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = 'en-US'
    let finalSoFar = transcript ? transcript + ' ' : ''
    rec.onresult = (e: any) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const chunk = e.results[i][0].transcript
        if (e.results[i].isFinal) finalSoFar += chunk + ' '
        else interim += chunk
      }
      setTranscript((finalSoFar + interim).trim())
    }
    rec.onend = () => setListening(false)
    rec.onerror = () => setListening(false)
    recognitionRef.current = rec
    rec.start()
    setListening(true)
  }

  const submit = async () => {
    if (submitting || transcript.trim().length < 20) return
    recognitionRef.current?.stop()
    setListening(false)
    setSubmitting(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch('/api/ai/debrief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ transcript: transcript.trim(), contactId: contact?.id, today: new Date().toLocaleDateString('en-CA') }),
      })
      const d = await res.json()
      if (!d.ok) throw new Error(d.error || 'Debrief failed')
      setResult(d.data as DebriefResult)
      setTranscript('')
    } catch (e: any) {
      setError(e?.message || 'Debrief failed')
    } finally {
      setSubmitting(false)
    }
  }

  const copyDraft = async () => {
    if (!result?.emailDraft) return
    try {
      await navigator.clipboard.writeText(`Subject: ${result.emailDraft.subject}\n\n${result.emailDraft.body}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* ignore */ }
  }

  return (
    <div className="p-3 sm:p-6 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Call debrief</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Just got off a call? Talk for 60 seconds about what happened. It becomes a call note,
          tasks, tracked promises, and a follow-up draft, all at once.
        </p>
      </div>

      {/* Contact picker */}
      <div className="rounded-xl border p-4">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Who was the call with? (optional but recommended)</p>
        {contact ? (
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{contact.name}</span>
            {contact.email && <span className="text-xs text-muted-foreground">{contact.email}</span>}
            <button type="button" className="text-xs text-muted-foreground underline ml-2" onClick={() => { setContact(null); setContactQuery('') }}>
              change
            </button>
          </div>
        ) : (
          <div className="relative">
            <input
              value={contactQuery}
              onChange={(e) => setContactQuery(e.target.value)}
              placeholder="Search contacts by name or email..."
              className="w-full rounded-lg border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
            />
            {contactHits.length > 0 && (
              <div className="absolute z-10 mt-1 w-full rounded-lg border bg-card shadow-lg overflow-hidden">
                {contactHits.map((c) => (
                  <button key={c.id} type="button" onClick={() => { setContact(c); setContactHits([]) }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-muted flex items-center justify-between">
                    <span>{c.name}</span>
                    {c.email && <span className="text-xs text-muted-foreground">{c.email}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Transcript capture */}
      <div className="rounded-xl border p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">The debrief</p>
          {speechSupported && (
            <button type="button" onClick={toggleListening}
              className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm border transition ${listening ? 'bg-red-500/10 border-red-500/40 text-red-600' : 'hover:bg-muted'}`}>
              {listening ? <MicOff className="size-4" /> : <Mic className="size-4" />}
              {listening ? 'Stop listening' : 'Start talking'}
            </button>
          )}
        </div>
        <textarea
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
          rows={7}
          placeholder={speechSupported
            ? 'Hit "Start talking" and just describe the call: what happened, what you promised, what they promised, what needs doing...'
            : 'Type what happened on the call: decisions, promises made both ways, what needs doing next...'}
          className="w-full rounded-lg border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
        />
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {listening ? 'Listening... speak naturally.' : `${transcript.trim().length} characters`}
          </p>
          <button type="button" onClick={submit} disabled={submitting || transcript.trim().length < 20}
            className="inline-flex items-center gap-2 rounded-lg bg-accent text-white px-4 py-2 text-sm font-medium disabled:opacity-50">
            {submitting ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
            {submitting ? 'Processing...' : 'Turn it into records'}
          </button>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>

      {/* Result */}
      {result && (
        <div className="rounded-xl border-2 border-accent/30 bg-accent/5 p-4 space-y-3">
          <p className="text-sm font-semibold">Done{result.contactName ? ` — filed under ${result.contactName}` : ''}.</p>
          <div className="space-y-2 text-sm">
            {result.noteSaved ? (
              <p className="flex items-start gap-2"><StickyNote className="size-4 text-accent mt-0.5 shrink-0" /> Call note saved{result.noteSummary ? `: ${result.noteSummary}` : ''}</p>
            ) : result.noteSummary ? (
              <p className="flex items-start gap-2"><StickyNote className="size-4 text-muted-foreground mt-0.5 shrink-0" /> Note (pick a contact next time to file it): {result.noteSummary}</p>
            ) : null}
            {result.tasksCreated > 0 && (
              <p className="flex items-start gap-2"><ClipboardList className="size-4 text-accent mt-0.5 shrink-0" /> {result.tasksCreated} task{result.tasksCreated === 1 ? '' : 's'} created</p>
            )}
            {result.commitmentsCreated > 0 && (
              <p className="flex items-start gap-2"><Handshake className="size-4 text-accent mt-0.5 shrink-0" /> {result.commitmentsCreated} promise{result.commitmentsCreated === 1 ? '' : 's'} now tracked (they will appear in meeting prep)</p>
            )}
            {!result.noteSaved && result.tasksCreated === 0 && result.commitmentsCreated === 0 && (
              <p className="text-muted-foreground">Nothing actionable found. Pick a contact so the note has a home, or add more detail.</p>
            )}
          </div>
          {result.emailDraft && (
            <div className="rounded-lg border bg-card p-3">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Follow-up draft</p>
                <button type="button" onClick={copyDraft} className="inline-flex items-center gap-1.5 text-xs border rounded-lg px-2 py-1 hover:bg-muted">
                  <Copy className="size-3" /> {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <p className="text-sm font-medium">{result.emailDraft.subject}</p>
              <p className="text-sm text-muted-foreground whitespace-pre-wrap mt-1">{result.emailDraft.body}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
