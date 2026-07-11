'use client'

import { useState, useEffect } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Badge } from '@open-mercato/ui/primitives/badge'
import {
  Plus, CalendarCheck, X, Loader2, ArrowLeft, Copy, ExternalLink, Users,
  MapPin, Globe, Clock, DollarSign, ChevronDown, Trash2, Download, Send,
  Sparkles, Eye, Check, FileText, Video, UserPlus, AlertTriangle,
  QrCode, RefreshCw, UserCheck,
} from 'lucide-react'
import { qrSvg } from '@/modules/customers/lib/kiosk-qr'

type Event = {
  id: string; title: string; description: string | null; slug: string
  event_type: string; status: string; location_name: string | null; location_address: string | null
  virtual_link: string | null; start_time: string; end_time: string; timezone: string
  is_recurring: boolean; capacity: number | null; price: string | null; is_free: boolean
  registration_fields: any; preapproved_emails: any; landing_copy: any; landing_style: string
  terms_text: string | null; reminder_config: any; attendee_count: number; created_at: string
}

type Attendee = {
  id: string; attendee_name: string; attendee_email: string; status: string
  ticket_quantity: number; guest_details: any; registration_data: any; registered_at: string
  checked_in_at?: string | null; checkin_source?: string | null
}

const EVENT_TYPES = [
  { id: 'in-person', label: 'In-Person', icon: MapPin },
  { id: 'virtual', label: 'Virtual', icon: Globe },
  { id: 'hybrid', label: 'Hybrid', icon: Video },
]

const TEMPLATES = [
  { id: 'workshop', name: 'Workshop', desc: 'Half-day skill-building session', type: 'in-person', capacity: 20, duration: 4, isFree: true,
    fields: [{ id: 'diet', type: 'select', label: 'Dietary Restrictions', options: ['None', 'Vegetarian', 'Vegan', 'Gluten-Free'] }] },
  { id: 'webinar', name: 'Webinar', desc: '1-hour virtual presentation', type: 'virtual', capacity: null, duration: 1, isFree: true,
    fields: [{ id: 'questions', type: 'textarea', label: 'Questions you\'d like answered' }] },
  { id: 'mixer', name: 'Networking Mixer', desc: 'Evening networking event', type: 'in-person', capacity: 50, duration: 3, isFree: true,
    fields: [{ id: 'company', type: 'text', label: 'Company' }, { id: 'role', type: 'text', label: 'Role' }] },
  { id: 'dinner', name: 'Dinner / Gala', desc: 'Formal paid dinner event', type: 'in-person', capacity: 40, duration: 4, isFree: false, price: '75.00',
    fields: [
      { id: 'tickets', type: 'number', label: 'Number of Tickets', min: 1, max: 10, isQuantityField: true },
      { id: 'guest_group', type: 'repeating_group', label: 'Guest Details', dependsOn: 'tickets', fields: [
        { id: 'guest_name', type: 'text', label: 'Guest Name', required: true },
        { id: 'guest_menu', type: 'select', label: 'Menu Choice', options: ['Chicken', 'Fish', 'Vegetarian'] },
      ]},
    ] },
  { id: 'openhouse', name: 'Open House', desc: 'Drop-in style event', type: 'in-person', capacity: 100, duration: 3, isFree: true,
    fields: [{ id: 'timeslot', type: 'select', label: 'Preferred Time Slot', options: ['10am-11am', '11am-12pm', '1pm-2pm', '2pm-3pm'] }] },
  { id: 'launch', name: 'Product Launch', desc: 'Virtual product unveiling', type: 'virtual', capacity: null, duration: 1.5, isFree: true,
    fields: [{ id: 'role', type: 'select', label: 'Your Role', options: ['Founder', 'Executive', 'Manager', 'Individual Contributor', 'Student'] }, { id: 'size', type: 'select', label: 'Company Size', options: ['Just me', '2-10', '11-50', '50+'] }] },
  { id: 'training', name: 'Training Session', desc: 'Multi-hour hands-on training', type: 'hybrid', capacity: 15, duration: 6, isFree: false,
    fields: [{ id: 'level', type: 'select', label: 'Experience Level', options: ['Beginner', 'Intermediate', 'Advanced'] }] },
  { id: 'meetup', name: 'Community Meetup', desc: 'Casual community gathering', type: 'in-person', capacity: 30, duration: 2, isFree: true,
    fields: [{ id: 'topics', type: 'text', label: 'Topics you\'re interested in' }] },
]

const TIMEZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix', 'UTC', 'Europe/London', 'Europe/Berlin', 'Asia/Tokyo', 'Australia/Sydney']

export default function EventsPage() {
  const [events, setEvents] = useState<Event[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<'list' | 'pick' | 'templates' | 'create' | 'attendees'>('list')
  const [editingEvent, setEditingEvent] = useState<Event | null>(null)
  const [attendeesEvent, setAttendeesEvent] = useState<Event | null>(null)
  const [attendees, setAttendees] = useState<Attendee[]>([])
  const [attendeesLoading, setAttendeesLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [pastOpen, setPastOpen] = useState(false)

  // Email attendees
  const [showEmailModal, setShowEmailModal] = useState(false)
  const [emailSubject, setEmailSubject] = useState('')
  const [emailMessage, setEmailMessage] = useState('')
  const [emailSending, setEmailSending] = useState(false)

  // Kiosk sign-in
  const [showKioskModal, setShowKioskModal] = useState(false)
  const [kioskEvent, setKioskEvent] = useState<Event | null>(null)
  const [kioskUrl, setKioskUrl] = useState('')
  const [kioskLoading, setKioskLoading] = useState(false)
  const [kioskCopied, setKioskCopied] = useState(false)
  const [checkingInId, setCheckingInId] = useState<string | null>(null)

  // Create wizard step
  const [createStep, setCreateStep] = useState(0) // 0=info, 1=generate copy, 2=edit copy, 3=style+preview, 4=publish

  // Create form
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [eventType, setEventType] = useState('in-person')
  const [locationName, setLocationName] = useState('')
  const [locationAddress, setLocationAddress] = useState('')
  const [virtualLink, setVirtualLink] = useState('')
  const [startDate, setStartDate] = useState('')
  const [startTime, setStartTime] = useState('10:00')
  const [endDate, setEndDate] = useState('')
  const [endTime, setEndTime] = useState('12:00')
  const [timezone, setTimezone] = useState('America/New_York')
  const [capacity, setCapacity] = useState('')
  const [registrationDeadline, setRegistrationDeadline] = useState('')
  const [isFree, setIsFree] = useState(true)
  const [price, setPrice] = useState('')
  const [termsText, setTermsText] = useState('')
  const [registrationFields, setRegistrationFields] = useState<any[]>([])
  const [landingCopy, setLandingCopy] = useState<any>(null)
  const [landingStyle, setLandingStyle] = useState('warm')
  const [generatingCopy, setGeneratingCopy] = useState(false)
  const [isRecurring, setIsRecurring] = useState(false)
  const [addToCalendar, setAddToCalendar] = useState(true)
  const [recurrenceFreq, setRecurrenceFreq] = useState('weekly')
  const [recurrenceUntil, setRecurrenceUntil] = useState('')
  const [reminderConfirm, setReminderConfirm] = useState(true)
  const [reminder24h, setReminder24h] = useState(true)
  const [reminder1h, setReminder1h] = useState(false)
  const [preapprovedEmails, setPreapprovedEmails] = useState('')

  useEffect(() => { loadEvents() }, [])

  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(null), 2500) }

  function loadEvents() {
    setLoading(true)
    fetch('/api/crm-events', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.ok) setEvents(d.data || []); setLoading(false) })
      .catch(() => setLoading(false))
  }

  function resetForm() {
    setTitle(''); setDescription(''); setEventType('in-person'); setLocationName(''); setLocationAddress('')
    setVirtualLink(''); setStartDate(''); setStartTime('10:00'); setEndDate(''); setEndTime('12:00')
    setTimezone('America/New_York'); setCapacity(''); setIsFree(true); setPrice(''); setTermsText('')
    setRegistrationFields([]); setLandingCopy(null); setLandingStyle('warm'); setGeneratingCopy(false)
    setIsRecurring(false); setRecurrenceFreq('weekly'); setRecurrenceUntil('')
    setReminderConfirm(true); setReminder24h(true); setReminder1h(false); setPreapprovedEmails(''); setEditingEvent(null); setCreateStep(0)
  }

  function editEvent(ev: Event) {
    setEditingEvent(ev); setTitle(ev.title); setDescription(ev.description || '')
    setEventType(ev.event_type); setLocationName(ev.location_name || ''); setLocationAddress(ev.location_address || '')
    setVirtualLink(ev.virtual_link || '')
    const st = new Date(ev.start_time); const et = new Date(ev.end_time)
    setStartDate(st.toISOString().split('T')[0]); setStartTime(st.toTimeString().substring(0, 5))
    setEndDate(et.toISOString().split('T')[0]); setEndTime(et.toTimeString().substring(0, 5))
    setTimezone(ev.timezone || 'America/New_York')
    setCapacity(ev.capacity?.toString() || ''); setIsFree(ev.is_free); setPrice(ev.price || '')
    setTermsText(ev.terms_text || '')
    setRegistrationFields(typeof ev.registration_fields === 'string' ? JSON.parse(ev.registration_fields) : ev.registration_fields || [])
    setLandingCopy(ev.landing_copy ? (typeof ev.landing_copy === 'string' ? JSON.parse(ev.landing_copy) : ev.landing_copy) : null)
    setLandingStyle(ev.landing_style || 'warm')
    const reminders = typeof ev.reminder_config === 'string' ? JSON.parse(ev.reminder_config) : ev.reminder_config || []
    setReminderConfirm(reminders.some((r: any) => r.type === 'confirmation'))
    setReminder24h(reminders.some((r: any) => r.sendBefore === '24h'))
    setReminder1h(reminders.some((r: any) => r.sendBefore === '1h'))
    // Load recurring settings
    setIsRecurring(ev.is_recurring || false)
    if (ev.is_recurring && ev.recurrence_rule) {
      try {
        const rule = typeof ev.recurrence_rule === 'string' ? JSON.parse(ev.recurrence_rule) : ev.recurrence_rule
        setRecurrenceFreq(rule.frequency || 'weekly')
        setRecurrenceUntil(rule.until || '')
      } catch {}
    }
    // Load preapproved emails
    try {
      const emails = ev.preapproved_emails ? (typeof ev.preapproved_emails === 'string' ? JSON.parse(ev.preapproved_emails) : ev.preapproved_emails) : []
      setPreapprovedEmails(Array.isArray(emails) ? emails.join('\n') : '')
    } catch { setPreapprovedEmails('') }
    setView('create')
  }

  function applyTemplate(tpl: typeof TEMPLATES[0]) {
    setTitle(tpl.name); setDescription(tpl.desc); setEventType(tpl.type)
    setCapacity(tpl.capacity?.toString() || ''); setIsFree(tpl.isFree); setPrice((tpl as any).price || '')
    setRegistrationFields(tpl.fields || [])
    const now = new Date(); now.setDate(now.getDate() + 14)
    setStartDate(now.toISOString().split('T')[0])
    const endD = new Date(now.getTime() + tpl.duration * 60 * 60 * 1000)
    setEndDate(endD.toISOString().split('T')[0])
    setEndTime(endD.toTimeString().substring(0, 5))
    setView('create')
  }

  async function saveEvent() {
    const effectiveEndDate = endDate || startDate
    if (!title.trim() || !startDate) return showToast('Title and start date required')
    if (effectiveEndDate === startDate && endTime <= startTime) return showToast('End time must be after start time')
    if (!isFree && price && (isNaN(parseFloat(price)) || parseFloat(price) <= 0)) return showToast('Price must be greater than 0')
    if (isRecurring && recurrenceUntil && new Date(recurrenceUntil) <= new Date(startDate)) return showToast('Recurring end date must be after start date')
    setSaving(true)
    const reminderConfig = [
      ...(reminderConfirm ? [{ type: 'confirmation', sendAt: 'on_register' }] : []),
      ...(reminder24h ? [{ type: 'reminder', sendBefore: '24h' }] : []),
      ...(reminder1h ? [{ type: 'reminder', sendBefore: '1h' }] : []),
    ]
    const emailList = preapprovedEmails.trim().split('\n').map(e => e.trim().toLowerCase()).filter(Boolean)
    const payload = {
      title, description, eventType, locationName, locationAddress, virtualLink,
      startTime: `${startDate}T${startTime}`, endTime: `${effectiveEndDate}T${endTime}`,
      timezone, capacity: capacity ? parseInt(capacity) : null,
      registrationDeadline: registrationDeadline || null,
      isFree, price: isFree ? null : price, termsText: termsText || null,
      registrationFields, landingCopy, landingStyle, reminderConfig,
      preapprovedEmails: emailList.length > 0 ? emailList : null,
      isRecurring, recurrenceRule: isRecurring ? { frequency: recurrenceFreq, interval: 1, until: recurrenceUntil } : null,
      addToCalendar,
    }
    try {
      const url = editingEvent ? `/api/crm-events?id=${editingEvent.id}` : '/api/crm-events'
      const method = editingEvent ? 'PUT' : 'POST'
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(payload) })
      const d = await res.json()
      if (d.ok || res.ok) { resetForm(); setView('list'); loadEvents(); showToast(editingEvent ? 'Event updated' : 'Event created') }
      else showToast(d.error || 'Failed to save')
    } catch { showToast('Failed to save event') }
    setSaving(false)
  }

  async function publishEvent(ev: Event) {
    await fetch(`/api/crm-events?id=${ev.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ isPublished: ev.status !== 'published' }) })
    loadEvents()
  }

  async function cancelEvent(ev: Event) {
    if (!confirm(`Cancel "${ev.title}"?`)) return
    const sendEmail = ev.attendee_count > 0 ? confirm(`Send cancellation email to ${ev.attendee_count} attendee${ev.attendee_count > 1 ? 's' : ''}?`) : false
    await fetch(`/api/crm-events?id=${ev.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ status: 'cancelled', sendCancellationEmail: sendEmail }),
    })
    loadEvents(); showToast(sendEmail ? 'Event cancelled — emails sent' : 'Event cancelled')
  }

  async function deleteEvent(ev: Event) {
    if (!confirm(`Delete "${ev.title}"? This cannot be undone.`)) return
    await fetch(`/api/crm-events?id=${ev.id}`, { method: 'DELETE', credentials: 'include' })
    loadEvents(); showToast('Event deleted')
  }

  function copyLink(ev: Event) {
    navigator.clipboard.writeText(`${window.location.origin}/api/crm-events/public/${ev.slug}`)
    setCopied(ev.id); setTimeout(() => setCopied(null), 2000)
  }

  function viewAttendees(ev: Event) {
    setAttendeesEvent(ev); setView('attendees'); setAttendeesLoading(true)
    fetch(`/api/crm-events/${ev.id}/attendees`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.ok) setAttendees(d.data || []) })
      .catch(() => {})
      .finally(() => setAttendeesLoading(false))
  }

  function exportAttendeesCsv() {
    if (!attendeesEvent || attendees.length === 0) return
    const headers = ['Name', 'Email', 'Status', 'Tickets', 'Registered', 'Checked In']
    const rows = attendees.map(a => [a.attendee_name, a.attendee_email, a.status, a.ticket_quantity, new Date(a.registered_at).toLocaleDateString(), a.checked_in_at ? new Date(a.checked_in_at).toLocaleString() : ''])
    const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `${attendeesEvent.title.replace(/[^a-z0-9]/gi, '_')}_attendees.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  async function emailAttendees() {
    if (!emailSubject.trim() || !emailMessage.trim() || !attendeesEvent) return
    setEmailSending(true)
    try {
      const res = await fetch(`/api/crm-events/${attendeesEvent.id}/email`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ subject: emailSubject, message: emailMessage }),
      })
      const d = await res.json()
      if (d.ok) {
        showToast(`Email sent to ${d.data?.sent || 0} attendees`)
        setShowEmailModal(false); setEmailSubject(''); setEmailMessage('')
      } else showToast(d.error || 'Failed to send')
    } catch { showToast('Failed to send emails') }
    setEmailSending(false)
  }

  function openEmailModal(ev: Event) {
    setAttendeesEvent(ev)
    setEmailSubject(`Update: ${ev.title}`)
    setEmailMessage(`Hi {{firstName}},\n\nWe wanted to share an update about ${ev.title}.\n\n[Your message here]\n\nSee you there!`)
    setShowEmailModal(true)
  }

  async function openKioskModal(ev: Event, rotate = false) {
    setKioskEvent(ev); setShowKioskModal(true); setKioskLoading(true)
    if (!rotate) setKioskUrl('')
    try {
      const res = await fetch(`/api/crm-events/${ev.id}/kiosk`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify(rotate ? { rotate: true } : {}),
      })
      const d = await res.json()
      if (d.ok && d.data?.url) setKioskUrl(d.data.url)
      else { showToast(d.error || 'Failed to create kiosk link'); setShowKioskModal(false) }
    } catch { showToast('Failed to create kiosk link'); setShowKioskModal(false) }
    setKioskLoading(false)
  }

  async function toggleCheckIn(a: Attendee) {
    if (!attendeesEvent) return
    setCheckingInId(a.id)
    try {
      const res = await fetch(`/api/crm-events/${attendeesEvent.id}/attendees`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ attendeeId: a.id, action: a.checked_in_at ? 'undo_check_in' : 'check_in' }),
      })
      const d = await res.json()
      if (d.ok && d.data) {
        setAttendees(prev => prev.map(att => att.id === a.id ? { ...att, checked_in_at: d.data.checked_in_at, checkin_source: d.data.checkin_source } : att))
      } else showToast(d.error || 'Failed')
    } catch { showToast('Failed to update check-in') }
    setCheckingInId(null)
  }

  async function generateCopy() {
    setGeneratingCopy(true)
    try {
      const res = await fetch('/api/crm-events/ai', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ title, description, eventType, locationName, startTime: `${startDate}T${startTime}`, endTime: `${endDate}T${endTime}`, isFree, price, capacity }),
      })
      const d = await res.json()
      if (d.ok && d.data) setLandingCopy(d.data)
      else showToast('Failed to generate copy')
    } catch { showToast('Failed to generate copy') }
    setGeneratingCopy(false)
  }

  const now = new Date()
  const activeEvents = events.filter(e => e.status !== 'cancelled' && e.status !== 'archived' && new Date(e.start_time) >= now)
  const pastEvents = events.filter(e => e.status === 'cancelled' || e.status === 'archived' || new Date(e.start_time) < now)

  // Kiosk modal is reachable from both the list view and the attendees view.
  const kioskQr = kioskUrl ? qrSvg(kioskUrl, { moduleSize: 5, margin: 3 }) : null
  const kioskModal = showKioskModal && kioskEvent ? (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={() => setShowKioskModal(false)} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-background rounded-xl border shadow-xl w-full max-w-md p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold">Kiosk Sign-in</h3>
              <p className="text-xs text-muted-foreground mt-0.5">{kioskEvent.title}</p>
            </div>
            <IconButton variant="ghost" size="sm" type="button" aria-label="Close" onClick={() => setShowKioskModal(false)}><X className="size-4" /></IconButton>
          </div>
          {kioskLoading ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
          ) : kioskUrl ? (
            <div className="space-y-4">
              {kioskQr && (
                <div className="flex justify-center">
                  <div className="rounded-xl border p-2 bg-white" dangerouslySetInnerHTML={{ __html: kioskQr }} />
                </div>
              )}
              <p className="text-xs text-muted-foreground text-center">
                Open this link on a tablet at the door, or let attendees scan the QR code to sign in on their own phones.
                Walk-ins are added as attendees and CRM contacts automatically.
              </p>
              <div className="flex items-center gap-2">
                <Input readOnly value={kioskUrl} className="h-8 text-xs font-mono flex-1" />
                <Button type="button" variant="outline" size="sm" className="h-8 shrink-0" onClick={() => {
                  navigator.clipboard.writeText(kioskUrl); setKioskCopied(true); setTimeout(() => setKioskCopied(false), 2000)
                }}>
                  {kioskCopied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                </Button>
              </div>
              {attendeesEvent?.id === kioskEvent.id && attendees.length > 0 && (
                <p className="text-xs text-center font-medium">Attendees checked in: {attendees.filter(a => a.checked_in_at).length} of {attendees.length}</p>
              )}
              <div className="flex justify-between items-center pt-2 border-t">
                <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => window.open(kioskUrl, '_blank')}>
                  <ExternalLink className="size-3 mr-1" /> Open Kiosk
                </Button>
                <Button type="button" variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" title="Invalidate the current link and QR code and mint a new one" onClick={() => openKioskModal(kioskEvent, true)}>
                  <RefreshCw className="size-3 mr-1" /> Rotate Link
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-8">Could not load the kiosk link.</p>
          )}
        </div>
      </div>
    </>
  ) : null

  // ═══ Attendees View ═══
  if (view === 'attendees' && attendeesEvent) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <button onClick={() => { setView('list'); setAttendeesEvent(null) }} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-2">
              <ArrowLeft className="size-4" /> Back to Events
            </button>
            <h1 className="text-xl font-semibold">{attendeesEvent.title}</h1>
            <p className="text-sm text-muted-foreground">
              {attendees.length} registered{attendeesEvent.capacity ? ` of ${attendeesEvent.capacity}` : ''}
              {' · '}{attendees.filter(a => a.checked_in_at).length} checked in
            </p>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => openKioskModal(attendeesEvent!)}>
              <QrCode className="size-4 mr-1.5" /> Kiosk Sign-in
            </Button>
            {attendees.length > 0 && (
              <>
                <Button type="button" variant="outline" size="sm" onClick={() => openEmailModal(attendeesEvent!)}>
                  <Send className="size-4 mr-1.5" /> Email All
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={exportAttendeesCsv}>
                  <Download className="size-4 mr-1.5" /> Export CSV
                </Button>
              </>
            )}
          </div>
        </div>
        {attendeesLoading ? (
          <div className="flex items-center justify-center py-16"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
        ) : attendees.length === 0 ? (
          <div className="text-center py-16">
            <Users className="size-8 mx-auto text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No attendees yet</p>
          </div>
        ) : (
          <div className="border rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="bg-muted/50 border-b">
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Name</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Email</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Tickets</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Registered</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Checked In</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground"></th>
              </tr></thead>
              <tbody>
                {attendees.map(a => (
                  <tr key={a.id} className="border-b last:border-0 hover:bg-muted/20 group">
                    <td className="px-4 py-3 font-medium">{a.attendee_name}</td>
                    <td className="px-4 py-3 text-muted-foreground">{a.attendee_email}</td>
                    <td className="px-4 py-3">{a.ticket_quantity}</td>
                    <td className="px-4 py-3"><Badge variant="secondary" className={`text-[10px] ${a.status === 'registered' ? 'bg-emerald-100 text-emerald-700' : ''}`}>{a.status}</Badge></td>
                    <td className="px-4 py-3 text-muted-foreground">{new Date(a.registered_at).toLocaleDateString()}</td>
                    <td className="px-4 py-3">
                      {a.checked_in_at ? (
                        <span className="inline-flex items-center gap-1.5">
                          <Badge variant="secondary" className="text-[10px] bg-emerald-100 text-emerald-700">
                            <UserCheck className="size-3 mr-0.5" />
                            {new Date(a.checked_in_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                          </Badge>
                          {a.checkin_source && <span className="text-[10px] text-muted-foreground">{a.checkin_source}</span>}
                          <button type="button" className="text-[10px] text-muted-foreground underline opacity-0 group-hover:opacity-100 transition" disabled={checkingInId === a.id} onClick={() => toggleCheckIn(a)}>undo</button>
                        </span>
                      ) : (
                        <Button type="button" variant="outline" size="sm" className="h-7 text-xs" disabled={checkingInId === a.id} onClick={() => toggleCheckIn(a)}>
                          {checkingInId === a.id ? <Loader2 className="size-3 mr-1 animate-spin" /> : <UserCheck className="size-3 mr-1" />} Check in
                        </Button>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button type="button" onClick={async () => {
                        if (!confirm(`Remove ${a.attendee_name} from this event?`)) return
                        await fetch(`/api/crm-events/${attendeesEvent!.id}/attendees?attendeeId=${a.id}`, { method: 'DELETE', credentials: 'include' })
                        setAttendees(prev => prev.filter(att => att.id !== a.id))
                        showToast('Attendee removed')
                      }} className="p-1 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition" title="Remove attendee">
                        <Trash2 className="size-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {kioskModal}
        {toast && (
          <div className="fixed bottom-6 right-6 bg-foreground text-background px-4 py-2.5 rounded-lg text-sm font-medium shadow-lg z-50">
            {toast}
          </div>
        )}
      </div>
    )
  }

  // ═══ Pick View ═══
  if (view === 'pick') {
    return (
      <div className="p-6">
        <button onClick={() => setView('list')} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-6">
          <ArrowLeft className="size-4" /> Back to Events
        </button>
        <h1 className="text-xl font-semibold mb-2">New Event</h1>
        <p className="text-sm text-muted-foreground mb-6">Start from scratch or use a template.</p>
        <div className="grid grid-cols-2 gap-4 mb-8">
          <button type="button" onClick={() => { resetForm(); setView('create') }}
            className="rounded-xl border p-6 text-left hover:border-accent/40 hover:bg-accent/5 transition-all group">
            <div className="size-10 rounded-lg bg-muted flex items-center justify-center mb-3">
              <Plus className="size-5 text-muted-foreground group-hover:text-foreground" />
            </div>
            <h3 className="font-semibold mb-1">Start from Scratch</h3>
            <p className="text-xs text-muted-foreground">Build your event from the ground up.</p>
          </button>
          <button type="button" onClick={() => setView('templates' as any)}
            className="rounded-xl border border-accent/20 p-6 text-left hover:border-accent/40 hover:bg-accent/5 transition-all group">
            <div className="size-10 rounded-lg bg-accent/10 flex items-center justify-center mb-3">
              <FileText className="size-5 text-accent" />
            </div>
            <h3 className="font-semibold mb-1">Use a Template</h3>
            <p className="text-xs text-muted-foreground">Choose from {TEMPLATES.length} pre-built event templates.</p>
          </button>
        </div>
      </div>
    )
  }

  // ═══ Templates View ═══
  if (view === 'templates') {
    return (
      <div className="p-6">
        <button onClick={() => setView('pick')} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-6">
          <ArrowLeft className="size-4" /> Back
        </button>
        <h1 className="text-xl font-semibold mb-2">Choose a Template</h1>
        <p className="text-sm text-muted-foreground mb-6">Pick a template to pre-fill your event details.</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {TEMPLATES.map(tpl => (
            <button key={tpl.id} type="button" onClick={() => applyTemplate(tpl)}
              className="border rounded-xl p-4 text-left hover:border-accent/40 hover:bg-accent/5 transition-all">
              <h3 className="text-sm font-semibold mb-0.5">{tpl.name}</h3>
              <p className="text-[11px] text-muted-foreground">{tpl.desc}</p>
              <div className="flex items-center gap-2 mt-2 text-[10px] text-muted-foreground">
                <span>{tpl.type}</span>
                {tpl.capacity && <span>· {tpl.capacity} cap</span>}
                <span>· {tpl.isFree ? 'Free' : 'Paid'}</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    )
  }

  // ═══ Create/Edit View (Wizard) ═══
  if (view === 'create') {
    const STEPS = ['Event Info', 'Generate Copy', 'Edit Copy', 'Landing Page', 'Publish']
    return (
      <div className="p-6 max-w-3xl">
        <button onClick={() => { if (createStep > 0) setCreateStep(createStep - 1); else { setView('list'); resetForm() } }} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4">
          <ArrowLeft className="size-4" /> {createStep > 0 ? 'Previous Step' : 'Back to Events'}
        </button>
        <h1 className="text-xl font-semibold mb-2">{editingEvent ? 'Edit Event' : 'Create Event'}</h1>

        {/* Step indicators */}
        <div className="flex gap-1 mb-6">
          {STEPS.map((label, i) => (
            <button key={i} type="button" onClick={() => { if (i <= createStep) setCreateStep(i) }}
              className={`flex-1 py-2 rounded-lg text-[11px] font-medium text-center transition-colors ${createStep === i ? 'bg-accent/10 text-accent' : i < createStep ? 'bg-accent/5 text-accent/60' : 'bg-muted text-muted-foreground'}`}>
              {label}
            </button>
          ))}
        </div>

        <div className="space-y-6">
          {/* ── STEP 0: Event Info ── */}
          {createStep === 0 && (<>
          {/* Basics */}
          <div className="bg-card rounded-xl border p-5 space-y-4">
            <h2 className="text-sm font-semibold">Event Details</h2>
            <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="Event title" className="text-sm" autoFocus />
            <Textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Describe your event..." rows={3} className="text-sm" />
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-2 block">Event Type</label>
              <div className="flex gap-2">
                {EVENT_TYPES.map(t => (
                  <button key={t.id} type="button" onClick={() => setEventType(t.id)}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium transition ${eventType === t.id ? 'bg-accent text-accent-foreground border-accent' : 'text-muted-foreground hover:border-accent/30'}`}>
                    <t.icon className="size-3.5" /> {t.label}
                  </button>
                ))}
              </div>
            </div>
            {(eventType === 'in-person' || eventType === 'hybrid') && (
              <div className="grid grid-cols-2 gap-3">
                <div><label className="text-xs font-medium text-muted-foreground mb-1 block">Venue Name</label>
                  <Input value={locationName} onChange={e => setLocationName(e.target.value)} placeholder="The Grand Hotel" className="text-sm" /></div>
                <div><label className="text-xs font-medium text-muted-foreground mb-1 block">Address</label>
                  <Input value={locationAddress} onChange={e => setLocationAddress(e.target.value)} placeholder="123 Main St, City" className="text-sm" /></div>
              </div>
            )}
            {(eventType === 'virtual' || eventType === 'hybrid') && (
              <div><label className="text-xs font-medium text-muted-foreground mb-1 block">Virtual Link (Zoom, Meet, etc.)</label>
                <Input value={virtualLink} onChange={e => setVirtualLink(e.target.value)} placeholder="https://zoom.us/j/..." className="text-sm" /></div>
            )}
          </div>

          {/* Date & Time */}
          <div className="bg-card rounded-xl border p-5 space-y-4">
            <h2 className="text-sm font-semibold">Date & Time</h2>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="text-xs font-medium text-muted-foreground mb-1 block">Start Date</label>
                <Input type="date" value={startDate} onChange={e => { setStartDate(e.target.value); if (!endDate) setEndDate(e.target.value) }} className="text-sm" /></div>
              <div><label className="text-xs font-medium text-muted-foreground mb-1 block">Start Time</label>
                <Input type="time" value={startTime} onChange={e => setStartTime(e.target.value)} className="text-sm" /></div>
              <div><label className="text-xs font-medium text-muted-foreground mb-1 block">End Date</label>
                <Input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="text-sm" /></div>
              <div><label className="text-xs font-medium text-muted-foreground mb-1 block">End Time</label>
                <Input type="time" value={endTime} onChange={e => setEndTime(e.target.value)} className="text-sm" /></div>
            </div>
            <div><label className="text-xs font-medium text-muted-foreground mb-1 block">Timezone</label>
              <select value={timezone} onChange={e => setTimezone(e.target.value)} className="w-full h-9 rounded-lg border bg-background px-2.5 text-sm">
                {TIMEZONES.map(tz => <option key={tz} value={tz}>{tz.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-6">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={isRecurring} onChange={e => setIsRecurring(e.target.checked)} className="rounded" />
                <span className="text-sm">Recurring event</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={addToCalendar} onChange={e => setAddToCalendar(e.target.checked)} className="rounded" />
                <span className="text-sm">Add to my calendar</span>
              </label>
            </div>
            {isRecurring && (
              <div className="grid grid-cols-2 gap-3">
                <div><label className="text-xs font-medium text-muted-foreground mb-1 block">Frequency</label>
                  <select value={recurrenceFreq} onChange={e => setRecurrenceFreq(e.target.value)} className="w-full h-9 rounded-lg border bg-background px-2.5 text-sm">
                    <option value="weekly">Weekly</option><option value="monthly">Monthly</option>
                  </select></div>
                <div><label className="text-xs font-medium text-muted-foreground mb-1 block">Until</label>
                  <Input type="date" value={recurrenceUntil} onChange={e => setRecurrenceUntil(e.target.value)} className="text-sm" /></div>
              </div>
            )}
          </div>

          {/* Capacity & Pricing */}
          <div className="bg-card rounded-xl border p-5 space-y-4">
            <h2 className="text-sm font-semibold">Capacity & Pricing</h2>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="text-xs font-medium text-muted-foreground mb-1 block">Max Capacity (blank = unlimited)</label>
                <Input type="number" value={capacity} onChange={e => setCapacity(e.target.value)} placeholder="50" className="text-sm" /></div>
              <div><label className="text-xs font-medium text-muted-foreground mb-1 block">Registration Deadline (optional)</label>
                <Input type="datetime-local" value={registrationDeadline} onChange={e => setRegistrationDeadline(e.target.value)} className="text-sm" /></div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Pricing</label>
                <div className="flex items-center gap-2">
                  {[true, false].map(free => (
                    <button key={String(free)} type="button" onClick={() => setIsFree(free)}
                      className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition ${isFree === free ? 'bg-accent text-accent-foreground border-accent' : 'text-muted-foreground hover:border-accent/30'}`}>
                      {free ? 'Free' : 'Paid'}
                    </button>
                  ))}
                  {!isFree && <div className="flex items-center gap-1"><span className="text-sm text-muted-foreground">$</span>
                    <Input type="number" value={price} onChange={e => setPrice(e.target.value)} placeholder="25.00" className="w-24 text-sm" step="0.01" /></div>}
                </div>
              </div>
            </div>
          </div>

          {/* Registration Fields */}
          <div className="bg-card rounded-xl border p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Registration Form Fields</h2>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => {
                  const qtyId = crypto.randomUUID().substring(0, 8)
                  setRegistrationFields(prev => [...prev,
                    { id: qtyId, type: 'number', label: 'Number of Attendees', min: 1, max: 10, required: true, isQuantityField: true },
                    { id: crypto.randomUUID().substring(0, 8), type: 'repeating_group', label: 'Attendee Details', dependsOn: qtyId, fields: [
                      { id: 'guest_name', type: 'text', label: 'Guest Name', required: true },
                    ]},
                  ])
                }}>
                  <UserPlus className="size-3.5 mr-1" /> Add Guest Fields
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setRegistrationFields(prev => [...prev, { id: crypto.randomUUID().substring(0, 8), type: 'text', label: '', required: false }])}>
                  <Plus className="size-3.5 mr-1" /> Add Field
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">Name and email are always collected. Add custom fields here.</p>
            {registrationFields.length > 0 && (
              <div className="space-y-2">
                {registrationFields.map((field: any, i: number) => (
                  <div key={field.id || i}>
                  {field.type === 'repeating_group' ? (
                    <div className="border rounded-lg p-3 bg-accent/5 border-accent/20">
                      <div className="flex items-center justify-between mb-2">
                        <div>
                          <p className="text-xs font-semibold text-accent">↳ Repeating Group</p>
                          <p className="text-[10px] text-muted-foreground">Repeats based on attendee quantity above. Each attendee fills these fields:</p>
                        </div>
                        <button type="button" onClick={() => setRegistrationFields(prev => prev.filter((_, j) => j !== i))}
                          className="p-1 text-muted-foreground hover:text-destructive"><X className="size-3.5" /></button>
                      </div>
                      <Input value={field.label} onChange={e => { const u = [...registrationFields]; u[i] = { ...field, label: e.target.value }; setRegistrationFields(u) }}
                        placeholder="Group label (e.g. Guest Details)" className="h-7 text-xs mb-2" />
                      <div className="space-y-1 ml-3">
                        {(field.fields || []).map((sf: any, si: number) => (
                          <div key={si} className="flex items-center gap-2">
                            <Input value={sf.label} onChange={e => {
                              const u = [...registrationFields]; const sfs = [...(u[i].fields || [])]; sfs[si] = { ...sf, label: e.target.value }; u[i] = { ...u[i], fields: sfs }; setRegistrationFields(u)
                            }} placeholder="Sub-field label" className="flex-1 h-6 text-xs" />
                            <select value={sf.type} onChange={e => {
                              const u = [...registrationFields]; const sfs = [...(u[i].fields || [])]; sfs[si] = { ...sf, type: e.target.value }; u[i] = { ...u[i], fields: sfs }; setRegistrationFields(u)
                            }} className="h-6 rounded border bg-background px-1.5 text-[10px] w-20">
                              <option value="text">Text</option><option value="select">Dropdown</option><option value="email">Email</option>
                            </select>
                            <button type="button" onClick={() => {
                              const u = [...registrationFields]; u[i] = { ...u[i], fields: (u[i].fields || []).filter((_: any, j: number) => j !== si) }; setRegistrationFields(u)
                            }} className="p-0.5 text-muted-foreground hover:text-destructive"><X className="size-2.5" /></button>
                          </div>
                        ))}
                        <button type="button" onClick={() => {
                          const u = [...registrationFields]; u[i] = { ...u[i], fields: [...(u[i].fields || []), { id: crypto.randomUUID().substring(0, 6), type: 'text', label: '' }] }; setRegistrationFields(u)
                        }} className="text-[10px] text-accent">+ Add sub-field</button>
                      </div>
                    </div>
                  ) : (<>
                  <div className="flex items-center gap-2 border rounded-lg p-3">
                    <Input value={field.label} onChange={e => {
                      const u = [...registrationFields]; u[i] = { ...field, label: e.target.value }; setRegistrationFields(u)
                    }} placeholder="Field label" className="flex-1 h-8 text-xs" />
                    <select value={field.type} onChange={e => {
                      const u = [...registrationFields]; u[i] = { ...field, type: e.target.value }; setRegistrationFields(u)
                    }} className="h-8 rounded-lg border bg-background px-2 text-xs w-28">
                      <option value="text">Text</option>
                      <option value="textarea">Long Text</option>
                      <option value="email">Email</option>
                      <option value="phone">Phone</option>
                      <option value="number">Number</option>
                      <option value="select">Dropdown</option>
                      <option value="radio">Radio</option>
                      <option value="checkbox">Checkbox</option>
                    </select>
                    <label className="flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap">
                      <input type="checkbox" checked={field.required || false} onChange={e => {
                        const u = [...registrationFields]; u[i] = { ...field, required: e.target.checked }; setRegistrationFields(u)
                      }} className="rounded" /> Required
                    </label>
                    <button type="button" onClick={() => setRegistrationFields(prev => prev.filter((_, j) => j !== i))}
                      className="p-1 text-muted-foreground hover:text-destructive"><X className="size-3.5" /></button>
                  </div>
                  {(field.type === 'select' || field.type === 'radio') && (
                    <div className="ml-3 mt-2 space-y-1">
                      <p className="text-[10px] text-muted-foreground">Options:</p>
                      {(field.options || []).map((opt: string, oi: number) => (
                        <div key={oi} className="flex items-center gap-1">
                          <Input value={opt} onChange={ev => {
                            const u = [...registrationFields]; const opts = [...(u[i].options || [])]; opts[oi] = ev.target.value; u[i] = { ...u[i], options: opts }; setRegistrationFields(u)
                          }} className="flex-1 h-6 text-xs" placeholder={`Option ${oi + 1}`} />
                          <button type="button" onClick={() => {
                            const u = [...registrationFields]; u[i] = { ...u[i], options: (u[i].options || []).filter((_: any, j: number) => j !== oi) }; setRegistrationFields(u)
                          }} className="p-0.5 text-muted-foreground hover:text-destructive"><X className="size-2.5" /></button>
                        </div>
                      ))}
                      <button type="button" onClick={() => {
                        const u = [...registrationFields]; u[i] = { ...u[i], options: [...(u[i].options || []), ''] }; setRegistrationFields(u)
                      }} className="text-[10px] text-accent">+ Add option</button>
                    </div>
                  )}
                  </>)}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Preapproved Emails */}
          <div className="bg-card rounded-xl border p-5 space-y-3">
            <h2 className="text-sm font-semibold">Access Control</h2>
            <p className="text-xs text-muted-foreground">Leave blank for open registration. Add emails to restrict to invited attendees only.</p>
            <Textarea value={preapprovedEmails}
              onChange={e => setPreapprovedEmails(e.target.value)}
              placeholder="One email per line (leave blank for open registration)" rows={3} className="text-xs font-mono" />
          </div>

          {/* Reminders */}
          <div className="bg-card rounded-xl border p-5 space-y-3">
            <h2 className="text-sm font-semibold">Email Reminders</h2>
            <label className="flex items-center gap-2 cursor-pointer text-sm">
              <input type="checkbox" checked={reminderConfirm} onChange={e => setReminderConfirm(e.target.checked)} className="rounded" /> Confirmation email on registration
            </label>
            <label className="flex items-center gap-2 cursor-pointer text-sm">
              <input type="checkbox" checked={reminder24h} onChange={e => setReminder24h(e.target.checked)} className="rounded" /> Reminder 24 hours before
            </label>
            <label className="flex items-center gap-2 cursor-pointer text-sm">
              <input type="checkbox" checked={reminder1h} onChange={e => setReminder1h(e.target.checked)} className="rounded" /> Reminder 1 hour before
            </label>
          </div>

          {/* Terms */}
          <div className="bg-card rounded-xl border p-5 space-y-3">
            <h2 className="text-sm font-semibold">Terms & Conditions (optional)</h2>
            <Textarea value={termsText} onChange={e => setTermsText(e.target.value)} placeholder="Enter terms attendees must accept..." rows={2} className="text-xs" />
          </div>

          <div className="flex justify-end">
            <Button type="button" onClick={() => { if (!title.trim() || !startDate) { showToast('Title and start date required'); return } setCreateStep(1) }}>
              Next: Generate Copy →
            </Button>
          </div>
          </>)}

          {/* ── STEP 1: Generate Copy ── */}
          {createStep === 1 && (
            <div className="bg-card rounded-xl border p-6 text-center space-y-4">
              <Sparkles className="size-10 mx-auto text-accent/40" />
              <h2 className="text-lg font-semibold">Generate Landing Page Copy</h2>
              <p className="text-sm text-muted-foreground max-w-md mx-auto">AI will create a headline, description, benefits, FAQ, and CTA for your event landing page.</p>
              <div className="flex justify-center gap-3">
                {landingCopy && <Button type="button" variant="outline" onClick={() => setCreateStep(2)}>Skip — Use Existing Copy</Button>}
                <Button type="button" onClick={async () => { await generateCopy(); setCreateStep(2) }} disabled={generatingCopy}>
                  {generatingCopy ? <><Loader2 className="size-4 mr-1.5 animate-spin" /> Generating...</> : <><Sparkles className="size-4 mr-1.5" /> Generate Copy</>}
                </Button>
              </div>
              <button type="button" onClick={() => setCreateStep(2)} className="text-xs text-muted-foreground hover:text-foreground">Skip this step — I'll write my own</button>
            </div>
          )}

          {/* ── STEP 2: Edit Copy ── */}
          {createStep === 2 && (<>
            <div className="bg-card rounded-xl border p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">Edit Landing Page Copy</h2>
                <Button type="button" variant="outline" size="sm" onClick={generateCopy} disabled={generatingCopy}>
                  <Sparkles className="size-3.5 mr-1" /> Regenerate
                </Button>
              </div>
              {!landingCopy ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No copy generated yet. Go back to generate, or fill in manually below.</p>
              ) : null}
              <div className="space-y-3">
                <div><label className="text-xs font-medium text-muted-foreground mb-1 block">Headline</label>
                  <Input value={landingCopy?.headline || ''} onChange={e => setLandingCopy({ ...(landingCopy || {}), headline: e.target.value })} className="text-sm font-semibold" placeholder="Your event headline" /></div>
                <div><label className="text-xs font-medium text-muted-foreground mb-1 block">Subheadline</label>
                  <Textarea value={landingCopy?.subheadline || ''} onChange={e => setLandingCopy({ ...(landingCopy || {}), subheadline: e.target.value })} rows={2} className="text-sm" placeholder="Brief description" /></div>
                <div><label className="text-xs font-medium text-muted-foreground mb-1 block">CTA Button Text</label>
                  <Input value={landingCopy?.ctaText || ''} onChange={e => setLandingCopy({ ...(landingCopy || {}), ctaText: e.target.value })} className="text-sm w-56" placeholder="Register Now" /></div>
              </div>
            </div>
            <div className="flex justify-end">
              <Button type="button" onClick={() => setCreateStep(3)}>Next: Choose Style →</Button>
            </div>
          </>)}

          {/* ── STEP 3: Landing Page Style + Preview ── */}
          {createStep === 3 && (<>
            <div className="bg-card rounded-xl border p-5 space-y-4">
              <h2 className="text-sm font-semibold">Choose Landing Page Style</h2>
              <div className="grid grid-cols-3 gap-3">
                {[{ id: 'warm', label: 'Warm', desc: 'Soft tones, friendly feel', color: 'bg-amber-50 border-amber-200' },
                  { id: 'minimal', label: 'Minimal', desc: 'Clean, serif typography', color: 'bg-gray-50 border-gray-200' },
                  { id: 'dark', label: 'Dark', desc: 'Dark mode, purple accents', color: 'bg-gray-900 border-purple-500' }].map(s => (
                  <button key={s.id} type="button" onClick={() => setLandingStyle(s.id)}
                    className={`rounded-lg border p-4 text-left transition-all ${landingStyle === s.id ? 'ring-2 ring-accent border-accent' : 'hover:border-accent/30'}`}>
                    <div className={`w-full h-8 rounded ${s.color} border mb-2`} />
                    <p className="text-sm font-medium">{s.label}</p>
                    <p className="text-[10px] text-muted-foreground">{s.desc}</p>
                  </button>
                ))}
              </div>
            </div>
            <div className="flex justify-end">
              <Button type="button" onClick={() => setCreateStep(4)}>Next: Review & Publish →</Button>
            </div>
          </>)}

          {/* ── STEP 4: Publish ── */}
          {createStep === 4 && (<>
            <div className="bg-card rounded-xl border p-5 space-y-3">
              <h2 className="text-sm font-semibold">Review & Publish</h2>
              <div className="bg-muted/50 rounded-lg p-4 space-y-2 text-sm">
                <p><span className="font-medium">Event:</span> {title}</p>
                <p><span className="font-medium">Type:</span> {eventType}</p>
                <p><span className="font-medium">Date:</span> {startDate} {startTime} — {endDate} {endTime}</p>
                {locationName && <p><span className="font-medium">Location:</span> {locationName}</p>}
                {virtualLink && <p><span className="font-medium">Virtual Link:</span> {virtualLink}</p>}
                <p><span className="font-medium">Pricing:</span> {isFree ? 'Free' : `$${price}`}</p>
                {capacity && <p><span className="font-medium">Capacity:</span> {capacity}</p>}
                <p><span className="font-medium">Landing Style:</span> {landingStyle}</p>
                {landingCopy?.headline && <p><span className="font-medium">Headline:</span> {landingCopy.headline}</p>}
                <p><span className="font-medium">Registration Fields:</span> {registrationFields.length} custom field{registrationFields.length !== 1 ? 's' : ''}</p>
              </div>
            </div>
            <div className="flex justify-between pt-2">
              <Button type="button" variant="outline" onClick={() => { setView('list'); resetForm() }}>Cancel</Button>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={saveEvent} disabled={saving}>
                  {saving ? <Loader2 className="size-4 mr-1.5 animate-spin" /> : null}
                  Save as Draft
                </Button>
                <Button type="button" onClick={async () => {
                  if (!title.trim() || !startDate) { showToast('Title and start date required'); return }
                  setSaving(true)
                  const effectiveEndDate = endDate || startDate
                  if (!title.trim() || !startDate) { showToast('Title and start date required'); return }
                  setSaving(true)
                  const reminderConfig = [
                    ...(reminderConfirm ? [{ type: 'confirmation', sendAt: 'on_register' }] : []),
                    ...(reminder24h ? [{ type: 'reminder', sendBefore: '24h' }] : []),
                    ...(reminder1h ? [{ type: 'reminder', sendBefore: '1h' }] : []),
                  ]
                  const emailList = preapprovedEmails.trim().split('\n').map((e: string) => e.trim().toLowerCase()).filter(Boolean)
                  const payload = {
                    title, description, eventType, locationName, locationAddress, virtualLink,
                    startTime: `${startDate}T${startTime}`, endTime: `${effectiveEndDate}T${endTime}`,
                    timezone, capacity: capacity ? parseInt(capacity) : null,
                    registrationDeadline: registrationDeadline || null,
                    isFree, price: isFree ? null : price, termsText: termsText || null,
                    registrationFields, landingCopy, landingStyle, reminderConfig,
                    preapprovedEmails: emailList.length > 0 ? emailList : null,
                    isRecurring, recurrenceRule: isRecurring ? { frequency: recurrenceFreq, interval: 1, until: recurrenceUntil } : null,
                    addToCalendar,
                    isPublished: true,
                  }
                  try {
                    const url = editingEvent ? `/api/crm-events?id=${editingEvent.id}` : '/api/crm-events'
                    const method = editingEvent ? 'PUT' : 'POST'
                    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(payload) })
                    if (res.ok) { resetForm(); setView('list'); loadEvents(); showToast('Event published') }
                    else { const d = await res.json(); showToast(d.error || 'Failed') }
                  } catch { showToast('Failed to publish') }
                  setSaving(false)
                }} disabled={saving}>
                  {saving ? <><Loader2 className="size-4 mr-1.5 animate-spin" /> Publishing...</> : 'Publish Event'}
                </Button>
              </div>
            </div>
          </>)}
        </div>
      </div>
    )
  }

  // ═══ List View ═══
  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold">Events</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{activeEvents.length} upcoming event{activeEvents.length !== 1 ? 's' : ''}</p>
        </div>
        <Button type="button" onClick={() => setView('pick')}>
          <Plus className="size-4 mr-2" /> New Event
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
      ) : activeEvents.length === 0 && pastEvents.length === 0 ? (
        <div className="rounded-xl border border-muted-foreground/20 p-12 text-center">
          <div className="inline-flex items-center justify-center size-14 rounded-2xl bg-accent/10 text-accent mb-4">
            <CalendarCheck className="size-7" />
          </div>
          <h2 className="text-lg font-semibold mb-2">Create your first event</h2>
          <p className="text-sm text-muted-foreground max-w-sm mx-auto mb-6">Host workshops, webinars, meetups, and more. Create a landing page and start collecting registrations.</p>
          <Button type="button" onClick={() => setView('pick')}><Plus className="size-4 mr-2" /> Get Started</Button>
        </div>
      ) : (
        <div className="space-y-6">
          {activeEvents.length === 0 ? (
            <div className="text-center py-10 border border-dashed rounded-xl">
              <p className="text-sm text-muted-foreground">No upcoming events</p>
            </div>
          ) : (
            <div className="grid gap-3">
              {activeEvents.map(ev => {
                const date = new Date(ev.start_time)
                const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
                return (
                  <div key={ev.id} className="bg-card rounded-xl border p-5 hover:border-accent/30 transition-colors">
                    <div className="flex items-center gap-4">
                      <div className="size-12 rounded-lg bg-accent/10 flex flex-col items-center justify-center shrink-0">
                        <span className="text-[10px] font-bold text-accent uppercase">{date.toLocaleDateString('en-US', { month: 'short' })}</span>
                        <span className="text-lg font-bold text-accent leading-none">{date.getDate()}</span>
                      </div>
                      <div className="flex-1 min-w-0 cursor-pointer" onClick={() => editEvent(ev)}>
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="font-semibold truncate">{ev.title}</h3>
                          <Badge variant={ev.status === 'published' ? 'default' : 'secondary'}
                            className={`text-[10px] ${ev.status === 'published' ? 'bg-emerald-100 text-emerald-700' : ''}`}>
                            {ev.status}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1"><Clock className="size-3" /> {dateStr} at {timeStr}</span>
                          <span className="flex items-center gap-1">{ev.event_type === 'virtual' ? <Globe className="size-3" /> : <MapPin className="size-3" />} {ev.event_type}</span>
                          <span className="flex items-center gap-1"><Users className="size-3" /> {ev.attendee_count}{ev.capacity ? `/${ev.capacity}` : ''}</span>
                          {!ev.is_free && <span className="flex items-center gap-1"><DollarSign className="size-3" /> ${Number(ev.price).toFixed(2)}</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {ev.status === 'published' && (
                          <IconButton variant="ghost" size="sm" type="button" title="Copy link" onClick={() => copyLink(ev)}>
                            {copied === ev.id ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4 text-muted-foreground" />}
                          </IconButton>
                        )}
                        {ev.status === 'published' && (
                          <IconButton variant="ghost" size="sm" type="button" title="Preview" onClick={() => window.open(`/api/crm-events/public/${ev.slug}`, '_blank')}>
                            <ExternalLink className="size-4 text-muted-foreground" />
                          </IconButton>
                        )}
                        {ev.attendee_count > 0 && (
                          <IconButton variant="ghost" size="sm" type="button" title="Email attendees" onClick={() => openEmailModal(ev)}>
                            <Send className="size-4 text-muted-foreground" />
                          </IconButton>
                        )}
                        <IconButton variant="ghost" size="sm" type="button" title="Kiosk sign-in" onClick={() => openKioskModal(ev)}>
                          <QrCode className="size-4 text-muted-foreground" />
                        </IconButton>
                        <IconButton variant="ghost" size="sm" type="button" title="Attendees" onClick={() => viewAttendees(ev)}>
                          <Users className="size-4 text-muted-foreground" />
                        </IconButton>
                        <IconButton variant="ghost" size="sm" type="button" title="Cancel" onClick={() => cancelEvent(ev)}>
                          <AlertTriangle className="size-4 text-muted-foreground" />
                        </IconButton>
                        <IconButton variant="ghost" size="sm" type="button" title="Delete" onClick={() => deleteEvent(ev)}>
                          <Trash2 className="size-4 text-muted-foreground hover:text-destructive" />
                        </IconButton>
                        <Button type="button" variant="ghost" size="sm" className="h-8 text-xs ml-1" onClick={() => publishEvent(ev)}>
                          {ev.status === 'published' ? 'Unpublish' : 'Publish'}
                        </Button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {pastEvents.length > 0 && (
            <div>
              <button type="button" onClick={() => setPastOpen(!pastOpen)}
                className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition w-full">
                <ChevronDown className={`size-4 transition-transform ${pastOpen ? 'rotate-180' : ''}`} />
                <span className="font-medium text-xs">Past & Cancelled ({pastEvents.length})</span>
                <div className="flex-1 h-px bg-border ml-2" />
              </button>
              {pastOpen && (
                <div className="grid gap-3 mt-3">
                  {pastEvents.map(ev => (
                    <div key={ev.id} className="bg-card rounded-xl border p-5 opacity-60">
                      <div className="flex items-center gap-4">
                        <div className="size-12 rounded-lg bg-muted flex flex-col items-center justify-center shrink-0">
                          <span className="text-[10px] font-bold text-muted-foreground uppercase">{new Date(ev.start_time).toLocaleDateString('en-US', { month: 'short' })}</span>
                          <span className="text-lg font-bold text-muted-foreground leading-none">{new Date(ev.start_time).getDate()}</span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <h3 className="font-semibold truncate">{ev.title}</h3>
                            <Badge variant="secondary" className="text-[10px]">{ev.status}</Badge>
                          </div>
                          <p className="text-xs text-muted-foreground">{ev.attendee_count} attendees · {new Date(ev.start_time).toLocaleDateString()}</p>
                        </div>
                        <IconButton variant="ghost" size="sm" type="button" title="Attendees" onClick={() => viewAttendees(ev)}>
                          <Users className="size-4" />
                        </IconButton>
                        <IconButton variant="ghost" size="sm" type="button" title="Delete" onClick={() => deleteEvent(ev)}>
                          <Trash2 className="size-4 text-muted-foreground hover:text-destructive" />
                        </IconButton>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Email Attendees Modal */}
      {showEmailModal && attendeesEvent && (
        <>
          <div className="fixed inset-0 bg-black/30 z-40" onClick={() => setShowEmailModal(false)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-background rounded-xl border shadow-xl w-full max-w-lg p-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="font-semibold">Email Attendees</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">{attendeesEvent.attendee_count} registered attendee{attendeesEvent.attendee_count !== 1 ? 's' : ''} for {attendeesEvent.title}</p>
                </div>
                <IconButton variant="ghost" size="sm" type="button" onClick={() => setShowEmailModal(false)}><X className="size-4" /></IconButton>
              </div>
              <div className="space-y-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Subject</label>
                  <Input value={emailSubject} onChange={e => setEmailSubject(e.target.value)} className="text-sm" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Message</label>
                  <Textarea value={emailMessage} onChange={e => setEmailMessage(e.target.value)} rows={6} className="text-sm" />
                  <p className="text-[10px] text-muted-foreground mt-1">Use {'{{firstName}}'} to personalize with attendee's first name.</p>
                </div>
              </div>
              <div className="flex justify-end gap-2 mt-5 pt-4 border-t">
                <Button type="button" variant="outline" onClick={() => setShowEmailModal(false)}>Cancel</Button>
                <Button type="button" onClick={emailAttendees} disabled={emailSending || !emailSubject.trim() || !emailMessage.trim()}>
                  {emailSending ? <><Loader2 className="size-4 mr-1.5 animate-spin" /> Sending...</> : <><Send className="size-4 mr-1.5" /> Send to All Attendees</>}
                </Button>
              </div>
            </div>
          </div>
        </>
      )}

      {kioskModal}

      {toast && (
        <div className="fixed bottom-6 right-6 bg-foreground text-background px-4 py-2.5 rounded-lg text-sm font-medium shadow-lg z-50">
          {toast}
        </div>
      )}
    </div>
  )
}
