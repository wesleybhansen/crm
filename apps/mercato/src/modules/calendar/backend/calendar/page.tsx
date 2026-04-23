'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Calendar as BigCalendar, dateFnsLocalizer, type View } from 'react-big-calendar'
import {
  format, parse, startOfWeek, getDay, startOfDay, endOfDay,
  startOfMonth, endOfMonth, addDays, subDays, isSameDay, isToday, isPast,
  addWeeks, subWeeks, addMonths, subMonths,
} from 'date-fns'
import { enUS } from 'date-fns/locale/en-US'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import {
  CalendarDays, List, Plus, Link2, ChevronLeft, ChevronRight,
  Loader2, Video, Phone, MapPin, Clock, X, ExternalLink,
  Copy, Check, Send, Trash2, Pencil, CheckCircle2, XCircle,
  CalendarCheck, AlertCircle, ChevronDown, Repeat,
  Mail, User,
} from 'lucide-react'

// ---------- localizer ----------
const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek,
  getDay,
  locales: { 'en-US': enUS },
})

// ---------- types ----------
type TabId = 'calendar' | 'upcoming' | 'booking-pages'
type CalendarView = 'month' | 'week' | 'day'
type EventType = 'google_meet' | 'zoom' | 'phone' | 'in_person' | 'focused_work' | 'personal_time' | 'other'
type DurationOption = 15 | 30 | 45 | 60 | 90 | 120 | 'custom'

type UnifiedEvent = {
  id: string
  title: string
  start: string
  end: string
  source: 'crm' | 'google'
  type: 'booking' | 'blocked' | 'google_event'
  status: string | null
  meetingType: string | null
  meetLink: string | null
  guestName: string | null
  guestEmail: string | null
  guestPhone: string | null
  meetingLocation: string | null
  color: string | null
  editable: boolean
  googleHtmlLink: string | null
  recurrenceRule: { type: string; days?: number[]; endDate?: string; count?: number } | null
  recurrenceParentId: string | null
}

type RecurrenceType = 'daily' | 'weekly' | 'biweekly' | 'monthly'
type RecurrenceEndType = 'weeks' | 'date' | 'never'

type CalendarEvent = {
  id: string
  title: string
  start: Date
  end: Date
  resource: UnifiedEvent
}

type BookingPage = {
  id: string
  title: string
  slug: string
  description: string | null
  duration_minutes: number
  is_active: boolean
  meeting_type: string | null
  meeting_location: string | null
  zoom_link: string | null
  auto_confirm: boolean
  reminder_config: any
  created_at: string
}

type ContactResult = {
  id: string
  display_name: string
  primary_email: string | null
  primary_phone: string | null
}

// ---------- tab config ----------
const TABS: { id: TabId; label: string; icon: typeof CalendarDays }[] = [
  { id: 'calendar', label: 'Calendar', icon: CalendarDays },
  { id: 'upcoming', label: 'Upcoming', icon: List },
  { id: 'booking-pages', label: 'Booking Pages', icon: Link2 },
]

// ---------- event type config ----------
const EVENT_TYPE_COLORS: Record<string, { bg: string; border: string; text: string; pillBg: string }> = {
  google_meet: { bg: '#3B82F6', border: '#2563EB', text: '#ffffff', pillBg: '#3B82F6' },
  zoom: { bg: '#6366F1', border: '#4F46E5', text: '#ffffff', pillBg: '#6366F1' },
  phone: { bg: '#10B981', border: '#059669', text: '#ffffff', pillBg: '#10B981' },
  in_person: { bg: '#F59E0B', border: '#D97706', text: '#ffffff', pillBg: '#F59E0B' },
  focused_work: { bg: '#EF4444', border: '#DC2626', text: '#ffffff', pillBg: '#EF4444' },
  personal_time: { bg: '#6B7280', border: '#4B5563', text: '#ffffff', pillBg: '#6B7280' },
  other: { bg: '#8B5CF6', border: '#7C3AED', text: '#ffffff', pillBg: '#8B5CF6' },
  google_event: { bg: '#EC4899', border: '#DB2777', text: '#ffffff', pillBg: '#EC4899' },
}

const EVENT_TYPE_META: Record<string, { icon: typeof Video; label: string; color: string }> = {
  google_meet: { icon: Video, label: 'Google Meet', color: '#3B82F6' },
  zoom: { icon: Video, label: 'Zoom', color: '#6366F1' },
  phone: { icon: Phone, label: 'Phone', color: '#10B981' },
  in_person: { icon: MapPin, label: 'In-Person', color: '#F59E0B' },
  focused_work: { icon: Clock, label: 'Focused Work', color: '#EF4444' },
  personal_time: { icon: User, label: 'Personal Time', color: '#6B7280' },
  other: { icon: CalendarDays, label: 'Other', color: '#8B5CF6' },
}

const DURATION_OPTIONS: DurationOption[] = [15, 30, 45, 60, 90, 120, 'custom']
const DURATION_LABELS: Record<string, string> = {
  '15': '15m', '30': '30m', '45': '45m', '60': '1h', '90': '1.5h', '120': '2h', 'custom': 'Custom',
}

// ---------- helpers ----------
function getDateRange(date: Date, view: CalendarView): { start: Date; end: Date } {
  if (view === 'month') {
    return { start: subDays(startOfMonth(date), 7), end: addDays(endOfMonth(date), 7) }
  }
  if (view === 'week') {
    const weekStart = startOfWeek(date, { locale: enUS })
    return { start: weekStart, end: addDays(weekStart, 6) }
  }
  return { start: startOfDay(date), end: endOfDay(date) }
}

function navigateDate(date: Date, direction: 'prev' | 'next' | 'today', view: CalendarView): Date {
  if (direction === 'today') return new Date()
  if (view === 'month') return direction === 'next' ? addMonths(date, 1) : subMonths(date, 1)
  if (view === 'week') return direction === 'next' ? addWeeks(date, 1) : subWeeks(date, 1)
  return direction === 'next' ? addDays(date, 1) : subDays(date, 1)
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function randomSlugSuffix(): string {
  // 10 hex chars ≈ 40 bits of entropy, enough to avoid collisions across tenants
  const arr = new Uint8Array(5)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(arr)
  } else {
    for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function slugifyWithSuffix(text: string): string {
  const base = slugify(text)
  return base ? `${base}-${randomSlugSuffix()}` : randomSlugSuffix()
}

function contactName(contact: ContactResult): string {
  return contact.display_name || contact.primary_email || 'Unnamed'
}

function resolveEventColor(resource: UnifiedEvent): string {
  if (resource.source === 'google') return 'google_event'
  if (resource.type === 'blocked') return 'focused_work'
  if (resource.meetingType && EVENT_TYPE_COLORS[resource.meetingType]) return resource.meetingType
  return 'other'
}

// ---------- calendar style overrides ----------
const CALENDAR_STYLES = `
  .monday-cal .rbc-month-view {
    border: none;
    border-radius: 8px;
    overflow: hidden;
  }
  .monday-cal .rbc-month-view .rbc-header {
    border: none;
    padding: 10px 0;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted-foreground, #64748b);
    background: transparent;
  }
  .monday-cal .rbc-month-view .rbc-month-row {
    border: none;
    min-height: 100px;
  }
  .monday-cal .rbc-month-view .rbc-day-bg {
    border: 1px solid var(--border, #e2e8f0);
    border-radius: 0;
    margin: 0;
  }
  .monday-cal .rbc-month-view .rbc-day-bg + .rbc-day-bg {
    border-left: none;
  }
  .monday-cal .rbc-month-row + .rbc-month-row .rbc-day-bg {
    border-top: none;
  }
  .monday-cal .rbc-month-view .rbc-off-range-bg {
    background: var(--muted, #f8fafc);
    opacity: 0.4;
  }
  .monday-cal .rbc-month-view .rbc-today {
    background: rgba(59, 130, 246, 0.04);
  }
  .monday-cal .rbc-month-view .rbc-date-cell {
    padding: 6px 8px 2px;
    text-align: left;
    font-size: 12px;
    font-weight: 500;
    color: var(--foreground, #1e293b);
  }
  .monday-cal .rbc-month-view .rbc-date-cell.rbc-off-range {
    color: var(--muted-foreground, #94a3b8);
    opacity: 0.5;
  }
  .monday-cal .rbc-month-view .rbc-date-cell.rbc-now > a {
    background: #3B82F6;
    color: #fff;
    border-radius: 50%;
    width: 24px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    font-size: 11px;
  }
  .monday-cal .rbc-month-view .rbc-event {
    margin: 1px 4px !important;
    max-width: calc(100% - 8px) !important;
    border: none !important;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
    padding: 1px 6px;
    line-height: 20px;
    cursor: pointer;
    box-shadow: none;
    outline: none;
    overflow: hidden;
  }
  .monday-cal .rbc-month-view .rbc-event:focus {
    outline: none;
    box-shadow: none;
  }
  .monday-cal .rbc-month-view .rbc-event.rbc-event-continues-after {
    border-radius: 4px;
  }
  .monday-cal .rbc-month-view .rbc-event.rbc-event-continues-prior {
    border-radius: 4px;
  }
  .monday-cal .rbc-month-view .rbc-show-more {
    margin: 2px 6px;
    font-size: 10px;
    font-weight: 600;
    color: var(--muted-foreground, #64748b);
    background: transparent;
    padding: 0;
  }
  .monday-cal .rbc-month-view .rbc-row-segment {
    padding: 0;
    max-width: 14.28% !important;
    flex-basis: 14.28% !important;
    overflow: hidden;
  }
  .monday-cal .rbc-month-view .rbc-event-content {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Week/Day view */
  .monday-cal .rbc-time-view {
    border: none !important;
    border-radius: 8px;
  }
  .monday-cal .rbc-time-view .rbc-time-header {
    border: none;
    border-bottom: 1px solid var(--border) !important;
  }
  .monday-cal .rbc-time-header-content {
    border-left: none !important;
  }
  .monday-cal .rbc-time-view .rbc-header {
    border: none;
    padding: 8px 0;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--muted-foreground, #64748b);
  }
  .monday-cal .rbc-time-view .rbc-header.rbc-today {
    color: #3B82F6;
  }
  .monday-cal .rbc-time-view .rbc-time-content {
    border-top: 1px solid var(--border, #e2e8f0);
  }
  .monday-cal .rbc-time-view .rbc-time-slot {
    border: none;
    min-height: 24px;
  }
  .monday-cal .rbc-time-view .rbc-timeslot-group {
    border-bottom: 1px solid var(--border, #e2e8f0);
    min-height: 48px;
  }
  .monday-cal .rbc-time-view .rbc-time-gutter .rbc-label {
    font-size: 10px;
    font-weight: 500;
    color: var(--muted-foreground, #94a3b8);
    padding: 0 8px;
  }
  .monday-cal .rbc-time-view .rbc-day-slot .rbc-time-slot {
    border-top: none;
  }
  .monday-cal .rbc-time-view .rbc-current-time-indicator {
    background-color: #3B82F6;
    height: 2px;
  }
  .monday-cal .rbc-time-view .rbc-current-time-indicator::before {
    content: '';
    position: absolute;
    left: -5px;
    top: -4px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #3B82F6;
  }
  .monday-cal .rbc-time-view .rbc-event {
    border: none !important;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 500;
    padding: 4px 8px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.08);
    cursor: pointer;
  }
  .monday-cal .rbc-time-view .rbc-event:focus {
    outline: none;
    box-shadow: 0 0 0 2px rgba(59,130,246,0.3);
  }
  .monday-cal .rbc-time-view .rbc-event-label {
    display: none;
  }
  .monday-cal .rbc-time-view .rbc-day-slot .rbc-events-container {
    margin-right: 4px;
  }

  /* Overlay popup */
  .monday-cal .rbc-overlay {
    border-radius: 8px;
    border: 1px solid var(--border, #e2e8f0);
    box-shadow: 0 8px 24px rgba(0,0,0,0.12);
    padding: 8px;
    max-width: 240px;
    z-index: 50;
  }
  .monday-cal .rbc-overlay-header {
    font-size: 12px;
    font-weight: 600;
    padding: 4px 4px 8px;
    border-bottom: 1px solid var(--border, #e2e8f0);
    margin-bottom: 4px;
  }

  /* Pending event dashed border */
  .monday-cal .rbc-event.event-pending {
    background: rgba(245, 158, 11, 0.12) !important;
    border: 1px dashed #F59E0B !important;
    color: #92400E !important;
  }

  /* Scrollbar */
  .monday-cal .rbc-time-content::-webkit-scrollbar {
    width: 6px;
  }
  .monday-cal .rbc-time-content::-webkit-scrollbar-track {
    background: transparent;
  }
  .monday-cal .rbc-time-content::-webkit-scrollbar-thumb {
    background: var(--border, #e2e8f0);
    border-radius: 3px;
  }
`

// ---------- main component ----------
export default function CalendarPage() {
  const [tab, setTab] = useState<TabId>('calendar')
  const [showNewEvent, setShowNewEvent] = useState(false)

  // Calendar state
  const [calView, setCalView] = useState<CalendarView>('month')
  const [currentDate, setCurrentDate] = useState(new Date())
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [loadingEvents, setLoadingEvents] = useState(true)
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null)
  const [showViewDropdown, setShowViewDropdown] = useState(false)

  // Google Calendar connected state
  const [googleCalendarConnected, setGoogleCalendarConnected] = useState(false)

  // Upcoming state
  const [upcomingEvents, setUpcomingEvents] = useState<CalendarEvent[]>([])
  const [loadingUpcoming, setLoadingUpcoming] = useState(true)

  // New Event state
  const [newEventDate, setNewEventDate] = useState<Date | null>(null)
  const [newTitle, setNewTitle] = useState('')
  const [newDate, setNewDate] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [newStartTime, setNewStartTime] = useState('09:00')
  const [newDuration, setNewDuration] = useState<DurationOption>(30)
  const [customDuration, setCustomDuration] = useState('')
  const [newEventType, setNewEventType] = useState<EventType>('google_meet')
  const [customTypeName, setCustomTypeName] = useState('')
  const [newLocation, setNewLocation] = useState('')
  const [newNotes, setNewNotes] = useState('')
  const [newAttendees, setNewAttendees] = useState<ContactResult[]>([])
  const [contactSearch, setContactSearch] = useState('')
  const [contactResults, setContactResults] = useState<ContactResult[]>([])
  const [showContactDropdown, setShowContactDropdown] = useState(false)
  const [submittingEvent, setSubmittingEvent] = useState(false)
  const [editingEventId, setEditingEventId] = useState<string | null>(null)
  const [sendInviteEmail, setSendInviteEmail] = useState(true)
  const [editStatus, setEditStatus] = useState<string>('confirmed')
  const contactSearchRef = useRef<HTMLDivElement>(null)

  // Recurrence state
  const [newRecurring, setNewRecurring] = useState(false)
  const [newRecurrenceType, setNewRecurrenceType] = useState<RecurrenceType>('weekly')
  const [newRecurrenceDays, setNewRecurrenceDays] = useState<number[]>([])
  const [newRecurrenceEndType, setNewRecurrenceEndType] = useState<RecurrenceEndType>('never')
  const [newRecurrenceWeeks, setNewRecurrenceWeeks] = useState(12)
  const [newRecurrenceEndDate, setNewRecurrenceEndDate] = useState('')

  // Recurring delete modal state
  const [showRecurringDeleteModal, setShowRecurringDeleteModal] = useState<{ eventId: string; parentId: string | null; hasRule: boolean } | null>(null)

  // Booking pages state
  const [bookingPages, setBookingPages] = useState<BookingPage[]>([])
  const [loadingPages, setLoadingPages] = useState(true)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [showNewPageForm, setShowNewPageForm] = useState(false)
  const [editingPageId, setEditingPageId] = useState<string | null>(null)
  const [pageForm, setPageForm] = useState({
    title: '', slug: '', description: '', duration_minutes: 30,
    meeting_type: 'google_meet' as string, auto_confirm: false,
    meeting_location: '', zoom_link: '',
    reminder_24h: true, reminder_1h: false,
  })
  const [savingPage, setSavingPage] = useState(false)
  const [deletingPageId, setDeletingPageId] = useState<string | null>(null)
  const viewDropdownRef = useRef<HTMLDivElement>(null)

  // Cancellation email modal state
  const [showCancelEmail, setShowCancelEmail] = useState<{
    guestName: string; guestEmail: string; title: string; date: string
  } | null>(null)
  const [cancelEmailSubject, setCancelEmailSubject] = useState('')
  const [cancelEmailBody, setCancelEmailBody] = useState('')
  const [sendingCancelEmail, setSendingCancelEmail] = useState(false)

  // Send booking link email compose state
  const [sendEmailPageId, setSendEmailPageId] = useState<string | null>(null)
  const [sendEmailTo, setSendEmailTo] = useState('')
  const [sendEmailToResults, setSendEmailToResults] = useState<ContactResult[]>([])
  const [sendEmailSubject, setSendEmailSubject] = useState('')
  const [sendEmailBody, setSendEmailBody] = useState('')
  const [sendEmailCc, setSendEmailCc] = useState('')
  const [sendEmailBcc, setSendEmailBcc] = useState('')
  const [showSendEmailCcBcc, setShowSendEmailCcBcc] = useState(false)
  const [sendingEmail, setSendingEmail] = useState(false)
  const [sendEmailSelectedContact, setSendEmailSelectedContact] = useState<ContactResult | null>(null)
  const [showSendEmailDropdown, setShowSendEmailDropdown] = useState(false)
  const sendEmailDropdownRef = useRef<HTMLDivElement>(null)

  // =============================================
  // DATA LOADING
  // =============================================

  const loadCalendarEvents = useCallback(async () => {
    setLoadingEvents(true)
    try {
      const range = getDateRange(currentDate, calView)
      const params = new URLSearchParams({
        start: range.start.toISOString(),
        end: range.end.toISOString(),
      })
      const res = await fetch(`/api/calendar/events?${params}`, { credentials: 'include' })
      const data = await res.json()
      if (data.ok) {
        const evList = data.data || []
        setEvents(evList.map((ev: UnifiedEvent) => ({
          id: ev.id, title: ev.title,
          start: new Date(ev.start), end: new Date(ev.end),
          resource: ev,
        })))
        // Detect Google Calendar connectivity by checking if any events came from Google
        if (evList.some((ev: UnifiedEvent) => ev.source === 'google')) {
          setGoogleCalendarConnected(true)
        }
      }
    } catch { /* empty */ }
    setLoadingEvents(false)
  }, [currentDate, calView])

  const loadUpcomingEvents = useCallback(async () => {
    setLoadingUpcoming(true)
    try {
      const start = startOfDay(new Date())
      const end = addDays(start, 30)
      const params = new URLSearchParams({
        start: start.toISOString(),
        end: end.toISOString(),
      })
      const res = await fetch(`/api/calendar/events?${params}`, { credentials: 'include' })
      const data = await res.json()
      if (data.ok) {
        const mapped: CalendarEvent[] = (data.data || []).map((ev: UnifiedEvent) => ({
          id: ev.id, title: ev.title,
          start: new Date(ev.start), end: new Date(ev.end),
          resource: ev,
        }))
        mapped.sort((a, b) => a.start.getTime() - b.start.getTime())
        setUpcomingEvents(mapped)
      }
    } catch { /* empty */ }
    setLoadingUpcoming(false)
  }, [])

  const loadBookingPages = useCallback(async () => {
    setLoadingPages(true)
    try {
      const res = await fetch('/api/calendar/booking-pages', { credentials: 'include' })
      const data = await res.json()
      if (data.ok) setBookingPages(data.data || [])
    } catch { /* empty */ }
    setLoadingPages(false)
  }, [])

  useEffect(() => { loadCalendarEvents() }, [loadCalendarEvents])
  useEffect(() => { if (tab === 'upcoming') loadUpcomingEvents() }, [tab, loadUpcomingEvents])
  useEffect(() => { if (tab === 'booking-pages') loadBookingPages() }, [tab, loadBookingPages])

  // Prefill date when switching to new-event from calendar click
  useEffect(() => {
    if (showNewEvent && newEventDate) {
      setNewDate(format(newEventDate, 'yyyy-MM-dd'))
      setNewEventDate(null)
    }
  }, [showNewEvent, newEventDate])

  // Contact search for new event — fetch on focus (empty search = recent) or typed search
  const [contactSearchActive, setContactSearchActive] = useState(false)
  useEffect(() => {
    if (!contactSearchActive) { return }
    const delay = contactSearch.trim() ? 300 : 0
    const timeout = setTimeout(async () => {
      try {
        const query = contactSearch.trim()
        const res = await fetch(`/api/customers/people?search=${encodeURIComponent(query)}&pageSize=10`, { credentials: 'include' })
        const data = await res.json()
        let items: any[] = []
        if (Array.isArray(data.data?.items)) items = data.data.items
        else if (Array.isArray(data.data)) items = data.data
        else if (Array.isArray(data.items)) items = data.items
        else if (Array.isArray(data)) items = data
        setContactResults(items.map((c: any) => ({
          id: c.id,
          display_name: c.display_name || c.displayName || '',
          primary_email: c.primary_email || c.primaryEmail || null,
          primary_phone: c.primary_phone || c.primaryPhone || null,
        })))
      } catch { /* empty */ }
    }, delay)
    return () => clearTimeout(timeout)
  }, [contactSearch, contactSearchActive])

  // Send email contact search
  useEffect(() => {
    if (!sendEmailTo.trim() || sendEmailSelectedContact) { setSendEmailToResults([]); return }
    const timeout = setTimeout(async () => {
      try {
        const res = await fetch(`/api/customers/people?search=${encodeURIComponent(sendEmailTo)}&pageSize=10`, { credentials: 'include' })
        const data = await res.json()
        let items: any[] = []
        if (Array.isArray(data.data?.items)) items = data.data.items
        else if (Array.isArray(data.data)) items = data.data
        else if (Array.isArray(data.items)) items = data.items
        else if (Array.isArray(data)) items = data
        setSendEmailToResults(items.map((c: any) => ({
          id: c.id,
          display_name: c.display_name || c.displayName || '',
          primary_email: c.primary_email || c.primaryEmail || null,
          primary_phone: c.primary_phone || c.primaryPhone || null,
        })))
      } catch { /* empty */ }
    }, 300)
    return () => clearTimeout(timeout)
  }, [sendEmailTo, sendEmailSelectedContact])

  // Close dropdowns on outside click
  useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (contactSearchRef.current && !contactSearchRef.current.contains(event.target as Node)) {
        setShowContactDropdown(false)
        setContactSearchActive(false)
      }
      if (viewDropdownRef.current && !viewDropdownRef.current.contains(event.target as Node)) {
        setShowViewDropdown(false)
      }
      if (sendEmailDropdownRef.current && !sendEmailDropdownRef.current.contains(event.target as Node)) {
        setShowSendEmailDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  // =============================================
  // ACTIONS
  // =============================================

  function getEffectiveDuration(): number {
    if (newDuration === 'custom') {
      const parsed = parseInt(customDuration)
      return parsed > 0 ? parsed : 30
    }
    return newDuration
  }

  async function handleCreateEvent() {
    const isFocusedWork = newEventType === 'focused_work' || newEventType === 'personal_time'
    const effectiveTitle = isFocusedWork ? (newTitle.trim() || (newEventType === 'personal_time' ? 'Personal Time' : 'Focused Work')) : newTitle
    if (!effectiveTitle.trim()) return
    setSubmittingEvent(true)
    try {
      const duration = getEffectiveDuration()
      const startDate = new Date(`${newDate}T${newStartTime}`)
      const endDate = new Date(startDate.getTime() + duration * 60 * 1000)

      // Edit existing event via PUT /api/calendar/bookings
      if (editingEventId) {
        const meetingType = newEventType === 'other' ? (customTypeName || 'other') : newEventType
        const putBody: Record<string, unknown> = {
          id: editingEventId,
          guest_name: newAttendees.length > 0 ? contactName(newAttendees[0]) : effectiveTitle,
          start_time: startDate.toISOString(),
          end_time: endDate.toISOString(),
          meeting_type: meetingType,
          meeting_location: newLocation || null,
          notes: newNotes || null,
          status: editStatus,
        }
        const res = await fetch('/api/calendar/bookings', {
          method: 'PUT', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(putBody),
        })
        const data = await res.json()
        if (data.ok) {
          resetNewEventForm()
          setShowNewEvent(false)
          loadCalendarEvents()
          if (tab === 'upcoming') loadUpcomingEvents()
        } else {
          console.error('[calendar.edit] PUT failed:', data.error)
        }
        setSubmittingEvent(false)
        return
      }

      if (isFocusedWork) {
        // Block time for focused work
        const blockBody: Record<string, unknown> = {
          title: effectiveTitle,
          start: startDate.toISOString(),
          end: endDate.toISOString(),
        }

        if (newRecurring) {
          const recurrence: Record<string, unknown> = { type: newRecurrenceType }
          if (newRecurrenceType === 'weekly' || newRecurrenceType === 'biweekly') {
            recurrence.days = newRecurrenceDays.length > 0 ? newRecurrenceDays : [startDate.getDay()]
          }
          if (newRecurrenceEndType === 'date' && newRecurrenceEndDate) {
            recurrence.endDate = newRecurrenceEndDate
          } else if (newRecurrenceEndType === 'weeks') {
            recurrence.endDate = addWeeks(startDate, newRecurrenceWeeks).toISOString()
          }
          // 'never' — no endDate, API defaults to 3 months
          blockBody.recurrence = recurrence
        }

        const res = await fetch('/api/calendar/events/block', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(blockBody),
        })
        const data = await res.json()
        if (data.ok) {
          resetNewEventForm()
          setShowNewEvent(false)
          loadCalendarEvents()
          if (tab === 'upcoming') loadUpcomingEvents()
        } else {
          alert(`Failed to create event: ${data.error || 'Unknown error'}`)
        }
      } else {
        const meetingType = newEventType === 'other' ? (customTypeName || 'other') : newEventType
        const body: Record<string, unknown> = {
          title: effectiveTitle,
          date: newDate,
          startTime: newStartTime,
          durationMinutes: duration,
          meetingType,
          notes: newNotes || undefined,
          attendees: newAttendees.map(a => ({
            name: contactName(a),
            email: a.primary_email || undefined,
          })),
        }
        if (newEventType === 'zoom') body.meetingLocation = newLocation
        if (newEventType === 'phone') body.meetingLocation = newLocation
        if (newEventType === 'in_person') body.meetingLocation = newLocation

        if (newRecurring) {
          const recurrence: Record<string, unknown> = { type: newRecurrenceType }
          if (newRecurrenceType === 'weekly' || newRecurrenceType === 'biweekly') {
            recurrence.days = newRecurrenceDays.length > 0 ? newRecurrenceDays : [startDate.getDay()]
          }
          if (newRecurrenceEndType === 'date' && newRecurrenceEndDate) {
            recurrence.endDate = newRecurrenceEndDate
          } else if (newRecurrenceEndType === 'weeks') {
            recurrence.endDate = addWeeks(startDate, newRecurrenceWeeks).toISOString()
          }
          // 'never' — no endDate, API defaults to 3 months
          body.recurrence = recurrence
        }
        const res = await fetch('/api/calendar/events/create', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const data = await res.json()
        if (data.ok) {
          // If Google Calendar is NOT connected and there are attendees, send invite emails (only when checkbox is checked)
          if (sendInviteEmail && !googleCalendarConnected && newAttendees.length > 0) {
            const eventDate = format(startDate, 'EEEE, MMMM d, yyyy \'at\' h:mm a')
            const eventEnd = format(endDate, 'h:mm a')
            for (const attendee of newAttendees) {
              const email = attendee.primary_email
              if (!email) continue
              try {
                await fetch('/api/email/send', {
                  method: 'POST', credentials: 'include',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    to: email,
                    subject: `Calendar Invite: ${effectiveTitle}`,
                    body: `Hi ${contactName(attendee)},\n\nYou have been invited to an event.\n\nEvent: ${effectiveTitle}\nDate: ${eventDate}\nEnd: ${eventEnd}\nType: ${meetingType}\n${newLocation ? `Location: ${newLocation}\n` : ''}\nLooking forward to it!`,
                  }),
                })
              } catch { /* email send failed silently */ }
            }
          }
          resetNewEventForm()
          setShowNewEvent(false)
          loadCalendarEvents()
          if (tab === 'upcoming') loadUpcomingEvents()
        } else {
          alert(`Failed to create event: ${data.error || 'Unknown error'}`)
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      alert(`Error creating event: ${message}`)
      console.error('[calendar.createEvent]', err)
    }
    setSubmittingEvent(false)
  }

  function resetNewEventForm() {
    setNewTitle('')
    setNewDate(format(new Date(), 'yyyy-MM-dd'))
    setNewStartTime('09:00')
    setNewDuration(30)
    setCustomDuration('')
    setNewEventType('google_meet')
    setCustomTypeName('')
    setNewLocation('')
    setNewNotes('')
    setNewAttendees([])
    setContactSearch('')
    setEditingEventId(null)
    setSendInviteEmail(true)
    setEditStatus('confirmed')
    setNewRecurring(false)
    setNewRecurrenceType('weekly')
    setNewRecurrenceDays([])
    setNewRecurrenceEndType('weeks')
    setNewRecurrenceWeeks(12)
    setNewRecurrenceEndDate('')
  }

  async function handleEventAction(eventId: string, action: 'confirm' | 'cancel', eventResource?: UnifiedEvent) {
    if (action === 'cancel') {
      if (!window.confirm('Cancel this event? Attendees will be notified.')) return
    }
    try {
      const newStatus = action === 'cancel' ? 'cancelled' : 'confirmed'
      const res = await fetch('/api/calendar/bookings', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: eventId, status: newStatus }),
      })
      const data = await res.json()
      if (!data.ok) {
        console.error(`[calendar.${action}] PUT failed:`, data.error)
      }

      // If cancelling and guest has email, offer cancellation email
      if (action === 'cancel' && eventResource?.guestEmail && eventResource.guestEmail !== 'blocked@internal.local') {
        const eventDate = eventResource.start ? format(new Date(eventResource.start), 'EEEE, MMMM d, yyyy \'at\' h:mm a') : ''
        setShowCancelEmail({
          guestName: eventResource.guestName || '',
          guestEmail: eventResource.guestEmail,
          title: eventResource.title,
          date: eventDate,
        })
        setCancelEmailSubject(`Cancelled: ${eventResource.title}`)
        setCancelEmailBody(`Hi ${eventResource.guestName || 'there'},\n\nThe event '${eventResource.title}' scheduled for ${eventDate} has been cancelled.\n\nWe apologize for any inconvenience.`)
      }

      setSelectedEvent(null)
      loadCalendarEvents()
      if (tab === 'upcoming') loadUpcomingEvents()
    } catch (err) {
      console.error(`[calendar.${action}] Error:`, err)
    }
  }

  async function handleSendCancellationEmail() {
    if (!showCancelEmail) return
    setSendingCancelEmail(true)
    try {
      await fetch('/api/email/send', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: showCancelEmail.guestEmail,
          subject: cancelEmailSubject,
          body: cancelEmailBody,
        }),
      })
    } catch { /* empty */ }
    setSendingCancelEmail(false)
    setShowCancelEmail(null)
  }

  async function handleDeleteRecurring(eventId: string, deleteSeries: boolean) {
    try {
      const res = await fetch('/api/calendar/bookings', {
        method: 'DELETE', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: eventId, deleteSeries }),
      })
      const data = await res.json()
      if (!data.ok) {
        console.error('[calendar.deleteRecurring] DELETE failed:', data.error)
      }
      setShowRecurringDeleteModal(null)
      setSelectedEvent(null)
      loadCalendarEvents()
      if (tab === 'upcoming') loadUpcomingEvents()
    } catch (err) {
      console.error('[calendar.deleteRecurring] Error:', err)
    }
  }

  function prefillEditFromEvent(event: CalendarEvent) {
    setEditingEventId(event.resource.id)
    setEditStatus(event.resource.status || 'confirmed')
    setNewTitle(event.resource.title)
    setNewDate(format(event.start, 'yyyy-MM-dd'))
    setNewStartTime(format(event.start, 'HH:mm'))
    const durationMs = event.end.getTime() - event.start.getTime()
    const durationMin = Math.round(durationMs / 60000)
    const standardDurations: DurationOption[] = [15, 30, 45, 60, 90, 120]
    if (standardDurations.includes(durationMin as DurationOption)) {
      setNewDuration(durationMin as DurationOption)
    } else {
      setNewDuration('custom')
      setCustomDuration(String(durationMin))
    }
    if (event.resource.meetingType && EVENT_TYPE_META[event.resource.meetingType]) {
      setNewEventType(event.resource.meetingType as EventType)
    }
    if (event.resource.meetingLocation) setNewLocation(event.resource.meetingLocation)
    setNewNotes('')
    setSelectedEvent(null)
    setShowNewEvent(true)
    setTab('calendar')
  }

  function copyBookingLink(slug: string, pageId: string) {
    const url = `${window.location.origin}/api/calendar/book/${slug}`
    navigator.clipboard.writeText(url).then(() => {
      setCopiedId(pageId)
      setTimeout(() => setCopiedId(null), 2000)
    })
  }

  async function handleSaveBookingPage() {
    setSavingPage(true)
    try {
      const isEdit = !!editingPageId
      const method = isEdit ? 'PUT' : 'POST'
      const payload: Record<string, unknown> = {
        title: pageForm.title,
        slug: pageForm.slug,
        description: pageForm.description,
        durationMinutes: pageForm.duration_minutes,
        meetingType: pageForm.meeting_type,
        meetingLocation: pageForm.meeting_location,
        zoomLink: pageForm.zoom_link,
        autoConfirm: pageForm.auto_confirm,
        reminderConfig: [
          ...(pageForm.reminder_24h ? [{ type: 'reminder', sendBefore: '24h' }] : []),
          ...(pageForm.reminder_1h ? [{ type: 'reminder', sendBefore: '1h' }] : []),
        ],
      }
      if (isEdit) {
        payload.id = editingPageId
      }
      const res = await fetch('/api/calendar/booking-pages', {
        method, credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (data.ok) {
        setShowNewPageForm(false)
        setEditingPageId(null)
        resetPageForm()
        loadBookingPages()
      }
    } catch { /* empty */ }
    setSavingPage(false)
  }

  async function handleDeleteBookingPage(pageId: string) {
    if (!window.confirm('Are you sure you want to delete this booking page? This cannot be undone.')) return
    setDeletingPageId(pageId)
    try {
      const res = await fetch(`/api/calendar/booking-pages?id=${pageId}`, {
        method: 'DELETE', credentials: 'include',
      })
      const data = await res.json()
      if (data.ok) {
        setBookingPages(prev => prev.filter(p => p.id !== pageId))
      } else {
        console.error('[calendar.deleteBookingPage] DELETE failed:', data.error)
      }
      loadBookingPages()
    } catch (err) {
      console.error('[calendar.deleteBookingPage] Error:', err)
    }
    setDeletingPageId(null)
  }


  function resetPageForm() {
    setPageForm({
      title: '', slug: '', description: '', duration_minutes: 30,
      meeting_type: 'google_meet', auto_confirm: false,
      meeting_location: '', zoom_link: '',
      reminder_24h: true, reminder_1h: false,
    })
  }

  function startEditPage(page: BookingPage) {
    setEditingPageId(page.id)
    const reminders = typeof page.reminder_config === 'string' ? JSON.parse(page.reminder_config) : (page.reminder_config || [])
    setPageForm({
      title: page.title,
      slug: page.slug,
      description: page.description || '',
      duration_minutes: page.duration_minutes,
      meeting_type: page.meeting_type || 'google_meet',
      auto_confirm: page.auto_confirm,
      meeting_location: page.meeting_location || '',
      zoom_link: page.zoom_link || '',
      reminder_24h: reminders.some((r: any) => r.sendBefore === '24h'),
      reminder_1h: reminders.some((r: any) => r.sendBefore === '1h'),
    })
    setShowNewPageForm(false)
  }

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        if (showNewEvent) {
          event.preventDefault()
          handleCreateEvent()
        }
      }
      if (event.key === 'Escape') {
        if (showRecurringDeleteModal) { setShowRecurringDeleteModal(null); return }
        if (showNewEvent) { setShowNewEvent(false); resetNewEventForm() }
        if (selectedEvent) setSelectedEvent(null)
        if (showNewPageForm) { setShowNewPageForm(false); resetPageForm() }
        if (editingPageId) { setEditingPageId(null); resetPageForm() }
        if (showViewDropdown) setShowViewDropdown(false)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [showNewEvent, newTitle, selectedEvent, showNewPageForm, editingPageId, showViewDropdown, showRecurringDeleteModal])

  // =============================================
  // GROUPED UPCOMING
  // =============================================

  const groupedUpcoming = useMemo(() => {
    const groups: { label: string; date: Date; events: CalendarEvent[] }[] = []
    for (const ev of upcomingEvents) {
      const evDate = startOfDay(ev.start)
      const existing = groups.find(g => isSameDay(g.date, evDate))
      if (existing) {
        existing.events.push(ev)
      } else {
        const today = startOfDay(new Date())
        const tomorrow = addDays(today, 1)
        let label: string
        if (isSameDay(evDate, today)) label = `Today \u2014 ${format(evDate, 'MMMM d, yyyy')}`
        else if (isSameDay(evDate, tomorrow)) label = `Tomorrow \u2014 ${format(evDate, 'MMMM d, yyyy')}`
        else label = format(evDate, 'EEEE \u2014 MMMM d, yyyy')
        groups.push({ label, date: evDate, events: [ev] })
      }
    }
    return groups
  }, [upcomingEvents])

  // =============================================
  // CALENDAR EVENT PROP GETTER
  // =============================================

  const eventPropGetter = useCallback((event: CalendarEvent) => {
    const colorKey = resolveEventColor(event.resource)
    const colors = EVENT_TYPE_COLORS[colorKey] || EVENT_TYPE_COLORS.other
    const isPending = event.resource.status === 'pending'

    if (isPending) {
      return {
        className: 'event-pending',
        style: {
          backgroundColor: 'rgba(245, 158, 11, 0.12)',
          border: '1px dashed #F59E0B',
          color: '#92400E',
          borderRadius: '4px',
          fontSize: '11px',
          fontWeight: 500,
          padding: '1px 6px',
          lineHeight: '20px',
        } as React.CSSProperties,
      }
    }

    return {
      style: {
        backgroundColor: colors.bg,
        border: 'none',
        borderRadius: '4px',
        color: colors.text,
        fontSize: '11px',
        fontWeight: 500,
        padding: '1px 6px',
        lineHeight: '20px',
      } as React.CSSProperties,
    }
  }, [])

  // =============================================
  // RENDER
  // =============================================

  return (
    <div className="flex h-[calc(100vh-52px)] flex-col bg-background">
      <style dangerouslySetInnerHTML={{ __html: CALENDAR_STYLES }} />

      {/* Header bar */}
      <div className="flex items-center justify-between border-b bg-card px-5 py-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-0.5 rounded-lg border bg-muted/30 p-0.5">
            {TABS.map(t => {
              const Icon = t.icon
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => { setTab(t.id); setShowNewEvent(false) }}
                  className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
                    tab === t.id && !showNewEvent
                      ? 'bg-foreground text-background shadow-sm'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                  }`}
                >
                  <Icon className="size-3.5" />
                  {t.label}
                </button>
              )
            })}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {loadingEvents && tab === 'calendar' && !showNewEvent && (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          )}
          <Button
            type="button"
            size="sm"
            onClick={() => { setShowNewEvent(true); setTab('calendar') }}
            className="h-8 gap-1.5 rounded-lg bg-blue-600 px-4 text-xs font-semibold text-white shadow-sm hover:bg-blue-700"
          >
            <Plus className="size-3.5" />
            New Event
          </Button>
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden">

        {/* ======================== TAB 1: CALENDAR ======================== */}
        {tab === 'calendar' && !showNewEvent && (
          <div className="flex h-full flex-col">
            {/* Monday.com-inspired Toolbar */}
            <div className="flex items-center justify-between border-b border-border/60 bg-card px-5 py-2">
              {/* Left: Today button */}
              <div className="flex items-center">
                <button
                  type="button"
                  onClick={() => setCurrentDate(new Date())}
                  className="rounded-md border bg-card px-2.5 py-1 text-xs font-semibold text-foreground shadow-sm transition hover:bg-muted/50"
                >
                  Today
                </button>
              </div>

              {/* Center: < Month Year > */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setCurrentDate(prev => navigateDate(prev, 'prev', calView))}
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted/50 hover:text-foreground"
                  aria-label="Previous"
                >
                  <ChevronLeft className="size-4" />
                </button>
                <span className="min-w-[140px] text-center text-sm font-semibold tracking-tight">
                  {format(currentDate, calView === 'day' ? 'MMMM d, yyyy' : 'MMMM yyyy')}
                </span>
                <button
                  type="button"
                  onClick={() => setCurrentDate(prev => navigateDate(prev, 'next', calView))}
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted/50 hover:text-foreground"
                  aria-label="Next"
                >
                  <ChevronRight className="size-4" />
                </button>
              </div>

              {/* Right: View dropdown */}
              <div className="relative" ref={viewDropdownRef}>
                <button
                  type="button"
                  onClick={() => setShowViewDropdown(prev => !prev)}
                  className="flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1 text-xs font-semibold shadow-sm transition hover:bg-muted/50"
                >
                  {calView.charAt(0).toUpperCase() + calView.slice(1)}
                  <ChevronDown className="size-3 text-muted-foreground" />
                </button>
                {showViewDropdown && (
                  <div className="absolute right-0 top-full z-30 mt-1 w-28 rounded-lg border bg-card py-1 shadow-lg">
                    {(['month', 'week', 'day'] as CalendarView[]).map(v => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => { setCalView(v); setShowViewDropdown(false) }}
                        className={`flex w-full items-center px-3 py-1.5 text-xs font-medium transition ${
                          calView === v
                            ? 'bg-blue-50 text-blue-700'
                            : 'text-foreground hover:bg-muted/50'
                        }`}
                      >
                        {v.charAt(0).toUpperCase() + v.slice(1)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Calendar + Detail Panel */}
            <div className="flex flex-1 overflow-hidden">
              <div className="monday-cal flex-1 overflow-hidden px-4 pb-3 pt-2">
                <BigCalendar
                  localizer={localizer}
                  culture="en-US"
                  events={events}
                  view={calView as View}
                  date={currentDate}
                  toolbar={false}
                  selectable
                  popup
                  onView={(v) => setCalView(v as CalendarView)}
                  onNavigate={(date) => setCurrentDate(date)}
                  onSelectSlot={(slot) => {
                    setNewEventDate(slot.start)
                    setNewDate(format(slot.start, 'yyyy-MM-dd'))
                    setShowNewEvent(true)
                  }}
                  onSelectEvent={(event) => setSelectedEvent(event as CalendarEvent)}
                  eventPropGetter={eventPropGetter as never}
                  min={new Date(2020, 0, 1, 7, 0)}
                  max={new Date(2020, 0, 1, 20, 0)}
                  components={{
                    event: ({ event }: { event: CalendarEvent }) => (
                      <div className="flex items-center gap-1 truncate">
                        {(event.resource.recurrenceRule || event.resource.recurrenceParentId) && (
                          <Repeat className="size-2.5 shrink-0 opacity-70" />
                        )}
                        <span className="truncate">
                          {event.resource.title || event.title}
                        </span>
                      </div>
                    ),
                  }}
                  style={{ height: '100%' }}
                />
              </div>

              {/* Event Detail Slide-in Panel */}
              {selectedEvent && (
                <div className="w-80 shrink-0 overflow-y-auto border-l bg-card shadow-lg">
                  <div className="flex items-center justify-between border-b px-4 py-3">
                    <div className="flex items-center gap-2">
                      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Event Details</h3>
                      {selectedEvent.resource.source === 'google' && (
                        <span className="rounded bg-purple-100 px-1.5 py-0.5 text-[9px] font-semibold text-purple-700 dark:bg-purple-900/30 dark:text-purple-400">Google Calendar</span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedEvent(null)}
                      className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted/50 hover:text-foreground"
                      aria-label="Close"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                  <div className="space-y-4 p-4">
                    <div>
                      <h4 className="text-base font-semibold leading-snug">{selectedEvent.resource.title}</h4>
                      <p className="mt-1.5 text-sm text-muted-foreground">
                        {format(selectedEvent.start, 'EEEE, MMMM d, yyyy')}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {format(selectedEvent.start, 'h:mm a')} - {format(selectedEvent.end, 'h:mm a')}
                      </p>
                    </div>

                    {/* Event type badge */}
                    {(() => {
                      const typeKey = selectedEvent.resource.source === 'google'
                        ? 'google_meet'
                        : selectedEvent.resource.type === 'blocked'
                        ? 'focused_work'
                        : selectedEvent.resource.meetingType
                      const meta = typeKey ? EVENT_TYPE_META[typeKey] : null
                      if (!meta) return null
                      const MtIcon = meta.icon
                      return (
                        <div>
                          <span
                            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold"
                            style={{ backgroundColor: `${meta.color}14`, color: meta.color }}
                          >
                            <MtIcon className="size-3" />
                            {meta.label}
                          </span>
                        </div>
                      )
                    })()}

                    {/* Recurring series indicator */}
                    {(selectedEvent.resource.recurrenceRule || selectedEvent.resource.recurrenceParentId) && (
                      <div>
                        <span className="inline-flex items-center gap-1.5 rounded-md bg-blue-50 px-2.5 py-1 text-[11px] font-semibold text-blue-700">
                          <Repeat className="size-3" />
                          Recurring event
                        </span>
                      </div>
                    )}

                    {(selectedEvent.resource.guestName || selectedEvent.resource.guestEmail) &&
                      selectedEvent.resource.type !== 'blocked' && (
                      <div className="space-y-1.5 rounded-lg bg-muted/30 p-3">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Guest</p>
                        {selectedEvent.resource.guestName && (
                          <p className="text-sm font-medium">{selectedEvent.resource.guestName}</p>
                        )}
                        {selectedEvent.resource.guestEmail && selectedEvent.resource.guestEmail !== 'blocked@internal.local' && (
                          <p className="text-xs text-muted-foreground">{selectedEvent.resource.guestEmail}</p>
                        )}
                        {selectedEvent.resource.guestPhone && (
                          <p className="text-xs text-muted-foreground">{selectedEvent.resource.guestPhone}</p>
                        )}
                      </div>
                    )}

                    {selectedEvent.resource.meetLink && (
                      <a
                        href={selectedEvent.resource.meetLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700"
                      >
                        <Video className="size-3.5" />
                        Join Meeting
                        <ExternalLink className="size-3 opacity-70" />
                      </a>
                    )}

                    {selectedEvent.resource.status && (
                      <div>
                        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                          selectedEvent.resource.status === 'confirmed'
                            ? 'bg-emerald-50 text-emerald-700'
                            : selectedEvent.resource.status === 'pending'
                            ? 'bg-amber-50 text-amber-700'
                            : selectedEvent.resource.status === 'blocked'
                            ? 'bg-red-50 text-red-700'
                            : 'bg-gray-100 text-gray-600'
                        }`}>
                          {selectedEvent.resource.status === 'confirmed' && <CheckCircle2 className="size-3" />}
                          {selectedEvent.resource.status === 'pending' && <AlertCircle className="size-3" />}
                          {selectedEvent.resource.status === 'blocked' && <Clock className="size-3" />}
                          {selectedEvent.resource.status.charAt(0).toUpperCase() + selectedEvent.resource.status.slice(1)}
                        </span>
                      </div>
                    )}

                    {/* Actions */}
                    {selectedEvent.resource.source === 'crm' && (
                      <div className="flex flex-wrap gap-2 border-t pt-4">
                        {selectedEvent.resource.status === 'pending' && (
                          <Button
                            type="button"
                            size="sm"
                            className="h-8 gap-1 rounded-lg bg-emerald-600 text-xs font-semibold text-white hover:bg-emerald-700"
                            onClick={() => handleEventAction(selectedEvent.resource.id, 'confirm')}
                          >
                            <CheckCircle2 className="size-3.5" />
                            Confirm
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-8 gap-1 rounded-lg text-xs font-semibold"
                          onClick={() => prefillEditFromEvent(selectedEvent)}
                        >
                          <Pencil className="size-3.5" />
                          Edit
                        </Button>
                        {selectedEvent.resource.type !== 'blocked' && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 gap-1 rounded-lg text-xs font-semibold text-red-600 hover:bg-red-50 hover:text-red-700"
                            onClick={() => handleEventAction(selectedEvent.resource.id, 'cancel', selectedEvent.resource)}
                          >
                            <XCircle className="size-3.5" />
                            Cancel Event
                          </Button>
                        )}
                        {/* Delete button for blocked/recurring events */}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-8 gap-1 rounded-lg text-xs font-semibold text-red-600 hover:bg-red-50 hover:text-red-700"
                          onClick={() => {
                            const isRecurring = !!(selectedEvent.resource.recurrenceRule || selectedEvent.resource.recurrenceParentId)
                            if (isRecurring) {
                              setShowRecurringDeleteModal({
                                eventId: selectedEvent.resource.id,
                                parentId: selectedEvent.resource.recurrenceParentId,
                                hasRule: !!selectedEvent.resource.recurrenceRule,
                              })
                            } else {
                              if (!window.confirm('Delete this event? This cannot be undone.')) return
                              handleDeleteRecurring(selectedEvent.resource.id, false)
                            }
                          }}
                        >
                          <Trash2 className="size-3.5" />
                          Delete
                        </Button>
                      </div>
                    )}

                    {selectedEvent.resource.source === 'google' && (
                      <div className="mt-3 rounded-lg border border p-3">
                        <p className="text-[11px] text-muted-foreground">
                          This event is from Google Calendar and can only be edited there.
                        </p>
                        {selectedEvent.resource.googleHtmlLink && (
                          <a
                            href={selectedEvent.resource.googleHtmlLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-2 inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-muted"
                          >
                            <ExternalLink className="size-3" />
                            Edit in Google Calendar
                          </a>
                        )}
                      </div>
                    )}
                    {selectedEvent.resource.source === 'crm' && selectedEvent.resource.googleHtmlLink && (
                      <a
                        href={selectedEvent.resource.googleHtmlLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground"
                      >
                        <ExternalLink className="size-3" />
                        Open in Google Calendar
                      </a>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ======================== TAB 2: UPCOMING ======================== */}
        {tab === 'upcoming' && !showNewEvent && (
          <div className="h-full overflow-y-auto">
            <div className="mx-auto max-w-2xl px-6 py-6">
              {loadingUpcoming ? (
                <div className="flex items-center justify-center py-16">
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                </div>
              ) : groupedUpcoming.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 text-center">
                  <div className="flex size-14 items-center justify-center rounded-2xl bg-muted/50">
                    <CalendarCheck className="size-7 text-muted-foreground/40" />
                  </div>
                  <p className="mt-4 text-sm font-semibold text-foreground">No upcoming events</p>
                  <p className="mt-1 text-xs text-muted-foreground">Create one or share a booking link.</p>
                  <Button
                    type="button"
                    size="sm"
                    className="mt-5 h-8 gap-1.5 rounded-lg bg-blue-600 px-4 text-xs font-semibold text-white hover:bg-blue-700"
                    onClick={() => setShowNewEvent(true)}
                  >
                    <Plus className="size-3.5" />
                    New Event
                  </Button>
                </div>
              ) : (
                <div className="space-y-6">
                  {groupedUpcoming.map(group => (
                    <div key={group.label}>
                      <h3 className={`mb-3 text-xs font-bold uppercase tracking-wider ${
                        isToday(group.date) ? 'text-blue-600' : 'text-muted-foreground'
                      }`}>
                        {group.label}
                      </h3>
                      <div className="space-y-2">
                        {group.events.map(ev => {
                          const typeKey = ev.resource.source === 'google'
                            ? 'google_meet'
                            : ev.resource.type === 'blocked'
                            ? 'focused_work'
                            : ev.resource.meetingType
                          const meta = typeKey ? EVENT_TYPE_META[typeKey] : null
                          const MtIcon = meta?.icon || CalendarDays
                          const color = meta?.color || '#64748b'

                          return (
                            <div
                              key={ev.id}
                              className="group flex items-center gap-4 rounded-xl border bg-card p-4 transition hover:shadow-md"
                            >
                              {/* Color bar */}
                              <div
                                className="h-12 w-1 shrink-0 rounded-full"
                                style={{ backgroundColor: color }}
                              />

                              {/* Icon */}
                              <div
                                className="flex size-9 shrink-0 items-center justify-center rounded-lg"
                                style={{ backgroundColor: `${color}14`, color }}
                              >
                                <MtIcon className="size-4" />
                              </div>

                              {/* Content */}
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <h4 className="truncate text-sm font-semibold">{ev.resource.title}</h4>
                                  {meta && (
                                    <span
                                      className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold"
                                      style={{ backgroundColor: `${color}14`, color }}
                                    >
                                      {meta.label}
                                    </span>
                                  )}
                                </div>
                                <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                                  <span className="font-medium">{format(ev.start, 'h:mm a')}</span>
                                  <span>-</span>
                                  <span>{format(ev.end, 'h:mm a')}</span>
                                  {ev.resource.guestName && ev.resource.type !== 'blocked' && (
                                    <>
                                      <span className="text-muted-foreground/40">|</span>
                                      <span>{ev.resource.guestName}</span>
                                    </>
                                  )}
                                </div>
                                {ev.resource.status && (
                                  <span className={`mt-1.5 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                                    ev.resource.status === 'confirmed'
                                      ? 'bg-emerald-50 text-emerald-700'
                                      : ev.resource.status === 'pending'
                                      ? 'bg-amber-50 text-amber-700'
                                      : ev.resource.status === 'blocked'
                                      ? 'bg-red-50 text-red-700'
                                      : 'bg-gray-100 text-gray-600'
                                  }`}>
                                    {ev.resource.status === 'confirmed' && <CheckCircle2 className="size-2.5" />}
                                    {ev.resource.status === 'pending' && <AlertCircle className="size-2.5" />}
                                    {ev.resource.status.charAt(0).toUpperCase() + ev.resource.status.slice(1)}
                                  </span>
                                )}
                              </div>

                              {/* Actions — always visible */}
                              <div className="flex shrink-0 items-center gap-1.5">
                                {ev.resource.meetLink && (
                                  <button
                                    type="button"
                                    onClick={() => window.open(ev.resource.meetLink!, '_blank')}
                                    className="flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1.5 text-[11px] font-semibold text-white transition hover:bg-blue-700"
                                  >
                                    <Video className="size-3" />
                                    Join
                                  </button>
                                )}
                                {ev.resource.source === 'crm' && ev.resource.status === 'pending' && (
                                  <button
                                    type="button"
                                    onClick={() => handleEventAction(ev.resource.id, 'confirm')}
                                    className="flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1.5 text-[11px] font-semibold text-white transition hover:bg-emerald-700"
                                  >
                                    Confirm
                                  </button>
                                )}
                                {ev.resource.source === 'crm' ? (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => handleEventAction(ev.resource.id, 'cancel', ev.resource)}
                                      className="flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-[11px] font-medium text-red-600 transition hover:bg-red-50"
                                    >
                                      Cancel
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => prefillEditFromEvent(ev)}
                                      className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted/50 hover:text-foreground"
                                      aria-label="Edit event"
                                    >
                                      <Pencil className="size-3" />
                                    </button>
                                  </>
                                ) : ev.resource.googleHtmlLink ? (
                                  <a
                                    href={ev.resource.googleHtmlLink}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground transition hover:bg-muted"
                                  >
                                    <ExternalLink className="size-3" />
                                    Google Cal
                                  </a>
                                ) : null}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ======================== NEW EVENT OVERLAY ======================== */}
        {showNewEvent && (
          <div className="h-full overflow-y-auto">
            <div className="mx-auto max-w-xl px-6 py-8">
              <div className="rounded-xl border bg-card p-8 shadow-sm">
                <h2 className="text-lg font-semibold tracking-tight">{editingEventId ? 'Edit Event' : 'Create New Event'}</h2>
                <p className="mt-1 text-xs text-muted-foreground">{editingEventId ? 'Update the event details below.' : 'Schedule meetings, calls, or block focus time.'}</p>

                <div className="mt-7 space-y-6">
                  {/* Event Type */}
                  <div>
                    <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Event Type</label>
                    <div className="flex flex-wrap gap-1.5">
                      {(Object.entries(EVENT_TYPE_META) as [EventType, typeof EVENT_TYPE_META[string]][]).map(([key, meta]) => {
                        const MtIcon = meta.icon
                        const isSelected = newEventType === key
                        return (
                          <button
                            key={key}
                            type="button"
                            onClick={() => { setNewEventType(key); setNewLocation(''); setCustomTypeName('') }}
                            className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-all ${
                              isSelected
                                ? 'text-white shadow-sm'
                                : 'border bg-card text-muted-foreground hover:border-foreground/20 hover:text-foreground'
                            }`}
                            style={isSelected ? { backgroundColor: meta.color } : undefined}
                          >
                            <MtIcon className="size-3.5" />
                            {meta.label}
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  {/* Custom type name input for Other */}
                  {newEventType === 'other' && (
                    <div>
                      <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Type Label</label>
                      <Input
                        value={customTypeName}
                        onChange={(event) => setCustomTypeName(event.target.value)}
                        placeholder="e.g., Board Meeting, Workshop..."
                        className="h-9 rounded-lg text-sm"
                      />
                    </div>
                  )}

                  {/* Title */}
                  <div>
                    <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {newEventType === 'focused_work' || newEventType === 'personal_time' ? 'Label' : 'Title'}
                    </label>
                    <Input
                      value={newTitle}
                      onChange={(event) => setNewTitle(event.target.value)}
                      placeholder={newEventType === 'focused_work' ? 'Focused Work' : newEventType === 'personal_time' ? 'Personal Time' : 'Product Demo, Follow-up Call...'}
                      className="h-10 rounded-lg text-sm"
                    />
                    {(newEventType === 'focused_work' || newEventType === 'personal_time') && !newTitle.trim() && (
                      <p className="mt-1 text-[10px] text-muted-foreground">Defaults to &quot;{newEventType === 'personal_time' ? 'Personal Time' : 'Focused Work'}&quot; if left empty</p>
                    )}
                  </div>

                  {/* Date + Time */}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Date</label>
                      <Input
                        type="date"
                        value={newDate}
                        onChange={(event) => setNewDate(event.target.value)}
                        className="h-10 rounded-lg text-sm"
                      />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Start Time</label>
                      <Input
                        type="time"
                        value={newStartTime}
                        onChange={(event) => setNewStartTime(event.target.value)}
                        className="h-10 rounded-lg text-sm"
                      />
                    </div>
                  </div>

                  {/* Duration */}
                  <div>
                    <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Duration</label>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {DURATION_OPTIONS.map(d => {
                        const isSelected = newDuration === d
                        return (
                          <button
                            key={String(d)}
                            type="button"
                            onClick={() => setNewDuration(d)}
                            className={`rounded-lg px-3 py-2 text-xs font-semibold transition-all ${
                              isSelected
                                ? 'bg-foreground text-background shadow-sm'
                                : 'border bg-card text-muted-foreground hover:border-foreground/20 hover:text-foreground'
                            }`}
                          >
                            {DURATION_LABELS[String(d)]}
                          </button>
                        )
                      })}
                    </div>
                    {newDuration === 'custom' && (
                      <div className="mt-2 flex items-center gap-2">
                        <Input
                          type="number"
                          value={customDuration}
                          onChange={(event) => setCustomDuration(event.target.value)}
                          placeholder="Minutes"
                          min={5}
                          max={480}
                          className="h-9 w-24 rounded-lg text-sm"
                        />
                        <span className="text-xs text-muted-foreground">minutes</span>
                      </div>
                    )}
                  </div>

                  {/* Recurrence */}
                  {!editingEventId && (
                    <div className="space-y-3">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={newRecurring}
                          onChange={e => setNewRecurring(e.target.checked)}
                          className="size-4 rounded border-border accent-accent"
                        />
                        <Repeat className="size-3.5 text-muted-foreground" />
                        <span className="text-sm text-muted-foreground">Repeat this event</span>
                      </label>

                      {newRecurring && (
                        <div className="ml-6 space-y-4 rounded-lg border bg-muted/20 p-4">
                          {/* Recurrence type */}
                          <div>
                            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Frequency</label>
                            <select
                              value={newRecurrenceType}
                              onChange={e => setNewRecurrenceType(e.target.value as RecurrenceType)}
                              className="h-9 w-full rounded-lg border bg-transparent px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                            >
                              <option value="daily">Daily</option>
                              <option value="weekly">Weekly</option>
                              <option value="biweekly">Bi-weekly</option>
                              <option value="monthly">Monthly</option>
                            </select>
                          </div>

                          {/* Day-of-week selector for weekly/biweekly */}
                          {(newRecurrenceType === 'weekly' || newRecurrenceType === 'biweekly') && (
                            <div>
                              <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">On days</label>
                              <div className="flex gap-1.5">
                                {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((dayLabel, dayIndex) => {
                                  const isSelected = newRecurrenceDays.includes(dayIndex)
                                  return (
                                    <button
                                      key={dayIndex}
                                      type="button"
                                      onClick={() => {
                                        setNewRecurrenceDays(prev =>
                                          isSelected
                                            ? prev.filter(d => d !== dayIndex)
                                            : [...prev, dayIndex].sort()
                                        )
                                      }}
                                      className={`flex h-8 w-10 items-center justify-center rounded-full text-xs font-semibold transition-all ${
                                        isSelected
                                          ? 'bg-blue-600 text-white shadow-sm'
                                          : 'border bg-card text-muted-foreground hover:border-blue-300 hover:text-blue-600'
                                      }`}
                                    >
                                      {dayLabel}
                                    </button>
                                  )
                                })}
                              </div>
                              {newRecurrenceDays.length === 0 && (
                                <p className="mt-1.5 text-[10px] text-muted-foreground">
                                  Defaults to the selected date&apos;s day of week if none chosen
                                </p>
                              )}
                            </div>
                          )}

                          {/* End condition */}
                          <div>
                            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Ends</label>
                            <div className="flex items-center gap-2">
                              <select
                                value={newRecurrenceEndType}
                                onChange={e => setNewRecurrenceEndType(e.target.value as RecurrenceEndType)}
                                className="h-9 rounded-lg border bg-transparent px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                              >
                                <option value="never">Never (indefinite)</option>
                                <option value="weeks">After # weeks</option>
                                <option value="date">On specific date</option>
                              </select>
                              {newRecurrenceEndType === 'weeks' && (
                                <div className="flex items-center gap-1.5">
                                  <Input
                                    type="number"
                                    value={newRecurrenceWeeks}
                                    onChange={e => setNewRecurrenceWeeks(Math.max(1, Math.min(52, parseInt(e.target.value) || 1)))}
                                    min={1}
                                    max={52}
                                    className="h-9 w-16 rounded-lg text-sm"
                                  />
                                  <span className="text-xs text-muted-foreground">weeks</span>
                                </div>
                              )}
                              {newRecurrenceEndType === 'date' && (
                                <Input
                                  type="date"
                                  value={newRecurrenceEndDate}
                                  onChange={e => setNewRecurrenceEndDate(e.target.value)}
                                  className="h-9 rounded-lg text-sm"
                                />
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Conditional location field */}
                  {newEventType === 'zoom' && (
                    <div>
                      <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Zoom Link</label>
                      <Input
                        value={newLocation}
                        onChange={(event) => setNewLocation(event.target.value)}
                        placeholder="https://zoom.us/j/..."
                        className="h-10 rounded-lg text-sm"
                      />
                    </div>
                  )}
                  {newEventType === 'phone' && (
                    <div>
                      <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Phone Number</label>
                      <Input
                        value={newLocation}
                        onChange={(event) => setNewLocation(event.target.value)}
                        placeholder="+1 (555) 123-4567"
                        className="h-10 rounded-lg text-sm"
                      />
                    </div>
                  )}
                  {newEventType === 'in_person' && (
                    <div>
                      <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Address</label>
                      <Input
                        value={newLocation}
                        onChange={(event) => setNewLocation(event.target.value)}
                        placeholder="123 Main St, City..."
                        className="h-10 rounded-lg text-sm"
                      />
                    </div>
                  )}

                  {/* Attendees (hidden for focused work and personal time) */}
                  {newEventType !== 'focused_work' && newEventType !== 'personal_time' && (
                    <div ref={contactSearchRef}>
                      <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Attendees</label>
                      {newAttendees.length > 0 && (
                        <div className="mb-2 flex flex-wrap gap-1.5">
                          {newAttendees.map(att => (
                            <span
                              key={att.id}
                              className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700"
                            >
                              <span>{contactName(att)}</span>
                              {att.primary_email && att.primary_email !== att.display_name && (
                                <span className="text-blue-500">{att.primary_email}</span>
                              )}
                              <button
                                type="button"
                                onClick={() => setNewAttendees(prev => prev.filter(a => a.id !== att.id))}
                                className="ml-0.5 rounded-full p-0.5 transition hover:bg-blue-100"
                              >
                                <X className="size-3" />
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="relative">
                        <Input
                          value={contactSearch}
                          onChange={(event) => { setContactSearch(event.target.value); setShowContactDropdown(true); setContactSearchActive(true) }}
                          onFocus={() => { setShowContactDropdown(true); setContactSearchActive(true) }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && contactSearch.trim()) {
                              event.preventDefault()
                              const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
                              if (emailRegex.test(contactSearch.trim())) {
                                const rawEmail = contactSearch.trim()
                                if (!newAttendees.some(a => a.primary_email === rawEmail)) {
                                  setNewAttendees(prev => [...prev, {
                                    id: `raw-${rawEmail}`,
                                    display_name: rawEmail,
                                    primary_email: rawEmail,
                                    primary_phone: null,
                                  }])
                                }
                                setContactSearch('')
                                setShowContactDropdown(false)
                              }
                            }
                          }}
                          placeholder="Search contacts or type an email..."
                          className="h-10 rounded-lg text-sm"
                        />
                        {showContactDropdown && (contactResults.length > 0 || (contactSearch.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactSearch.trim()))) && contactSearchActive && (
                          <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-48 overflow-y-auto rounded-lg border bg-card shadow-lg">
                            {contactResults
                              .filter(c => !newAttendees.some(a => a.id === c.id))
                              .map(contact => (
                                <button
                                  key={contact.id}
                                  type="button"
                                  onClick={() => {
                                    setNewAttendees(prev => [...prev, contact])
                                    setContactSearch('')
                                    setShowContactDropdown(false)
                                  }}
                                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition hover:bg-muted/50"
                                >
                                  <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-blue-100 text-xs font-semibold text-blue-700">
                                    {(contact.display_name?.[0] || contact.primary_email?.[0] || '?').toUpperCase()}
                                  </div>
                                  <div className="min-w-0">
                                    <p className="truncate font-medium">{contactName(contact)}</p>
                                    {contact.primary_email && (
                                      <p className="truncate text-xs text-muted-foreground">{contact.primary_email}</p>
                                    )}
                                  </div>
                                </button>
                              ))}
                            {contactSearch.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactSearch.trim()) && !contactResults.some(c => c.primary_email === contactSearch.trim()) && (
                              <button
                                type="button"
                                onClick={() => {
                                  const rawEmail = contactSearch.trim()
                                  if (!newAttendees.some(a => a.primary_email === rawEmail)) {
                                    setNewAttendees(prev => [...prev, {
                                      id: `raw-${rawEmail}`,
                                      display_name: rawEmail,
                                      primary_email: rawEmail,
                                      primary_phone: null,
                                    }])
                                  }
                                  setContactSearch('')
                                  setShowContactDropdown(false)
                                }}
                                className="flex w-full items-center gap-3 border-t px-3 py-2.5 text-left text-sm transition hover:bg-muted/50"
                              >
                                <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
                                  @
                                </div>
                                <div>
                                  <p className="font-medium">Add &quot;{contactSearch.trim()}&quot;</p>
                                  <p className="text-xs text-muted-foreground">Invite by email</p>
                                </div>
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Google Calendar invite note / Send invite checkbox */}
                  {newEventType !== 'focused_work' && newEventType !== 'personal_time' && newAttendees.length > 0 && (
                    googleCalendarConnected
                      ? <p className="text-[11px] text-muted-foreground">Attendees will receive a calendar invite automatically via Google Calendar.</p>
                      : (
                        <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                          <input type="checkbox" checked={sendInviteEmail} onChange={e => setSendInviteEmail(e.target.checked)} className="rounded" />
                          Send attendees an invite via email
                        </label>
                      )
                  )}

                  {/* Status dropdown (edit mode only) */}
                  {editingEventId && (
                    <div>
                      <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Status</label>
                      <select
                        value={editStatus}
                        onChange={e => setEditStatus(e.target.value)}
                        className="h-10 w-full rounded-lg border bg-transparent px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      >
                        <option value="confirmed">Confirmed</option>
                        <option value="pending">Pending</option>
                        <option value="cancelled">Cancelled</option>
                      </select>
                    </div>
                  )}

                  {/* Notes */}
                  <div>
                    <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Notes</label>
                    <textarea
                      value={newNotes}
                      onChange={(event) => setNewNotes(event.target.value)}
                      placeholder="Add any notes for this event..."
                      rows={3}
                      className="w-full rounded-lg border bg-transparent px-3 py-2.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-3 border-t pt-6">
                    <Button
                      type="button"
                      onClick={handleCreateEvent}
                      disabled={(newEventType !== 'focused_work' && newEventType !== 'personal_time') && !newTitle.trim() || submittingEvent}
                      className="h-10 gap-1.5 rounded-lg bg-blue-600 px-6 text-sm font-semibold text-white shadow-sm hover:bg-blue-700"
                    >
                      {submittingEvent ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <CalendarCheck className="size-4" />
                      )}
                      {editingEventId ? 'Save Changes' : newEventType === 'focused_work' || newEventType === 'personal_time' ? 'Block Time' : 'Create Event'}
                    </Button>
                    <button
                      type="button"
                      onClick={resetNewEventForm}
                      className="text-xs font-medium text-muted-foreground transition hover:text-foreground"
                    >
                      Reset
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ======================== TAB 4: BOOKING PAGES ======================== */}
        {tab === 'booking-pages' && !showNewEvent && (
          <div className="h-full overflow-y-auto">
            <div className="mx-auto max-w-3xl px-6 py-6">
              {/* Header */}
              <div className="mb-6 flex items-center justify-between">
                <div>
                  <h2 className="text-base font-semibold tracking-tight">Booking Pages</h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Create shareable links for contacts to book time with you.
                  </p>
                </div>
                {!showNewPageForm && (
                  <Button
                    type="button"
                    size="sm"
                    className="h-8 gap-1.5 rounded-lg bg-blue-600 px-4 text-xs font-semibold text-white shadow-sm hover:bg-blue-700"
                    onClick={() => { setShowNewPageForm(true); setEditingPageId(null); resetPageForm() }}
                  >
                    <Plus className="size-3.5" />
                    New Booking Page
                  </Button>
                )}
              </div>

              {/* New booking page form */}
              {showNewPageForm && (
                <div className="mb-6 rounded-xl border bg-card p-6 shadow-sm">
                  <h3 className="mb-4 text-sm font-semibold">New Booking Page</h3>
                  <BookingPageForm
                    form={pageForm}
                    onChange={setPageForm}
                    saving={savingPage}
                    onSave={handleSaveBookingPage}
                    onCancel={() => { setShowNewPageForm(false); resetPageForm() }}
                  />
                </div>
              )}

              {/* Booking pages grid */}
              {loadingPages ? (
                <div className="flex items-center justify-center py-16">
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                </div>
              ) : bookingPages.length === 0 && !showNewPageForm ? (
                <div className="flex flex-col items-center justify-center py-20 text-center">
                  <div className="flex size-14 items-center justify-center rounded-2xl bg-muted/50">
                    <Link2 className="size-7 text-muted-foreground/40" />
                  </div>
                  <p className="mt-4 text-sm font-semibold text-foreground">No booking pages yet</p>
                  <p className="mt-1 text-xs text-muted-foreground">Create your first booking page to start accepting meetings.</p>
                  <Button
                    type="button"
                    size="sm"
                    className="mt-5 h-8 gap-1.5 rounded-lg bg-blue-600 px-4 text-xs font-semibold text-white hover:bg-blue-700"
                    onClick={() => { setShowNewPageForm(true); resetPageForm() }}
                  >
                    <Plus className="size-3.5" />
                    Create Booking Page
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  {bookingPages.map(page => {
                    const isEditing = editingPageId === page.id
                    const mtMeta = EVENT_TYPE_META[page.meeting_type || 'in_person']
                    const MtIcon = mtMeta?.icon || MapPin
                    const color = mtMeta?.color || '#F59E0B'
                    const bookingUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/api/calendar/book/${page.slug}`

                    if (isEditing) {
                      return (
                        <div key={page.id} className="rounded-xl border bg-card p-6 shadow-sm">
                          <h3 className="mb-4 text-sm font-semibold">Edit Booking Page</h3>
                          <BookingPageForm
                            form={pageForm}
                            onChange={setPageForm}
                            saving={savingPage}
                            onSave={handleSaveBookingPage}
                            onCancel={() => { setEditingPageId(null); resetPageForm() }}
                            isEdit
                          />
                        </div>
                      )
                    }

                    return (
                      <div
                        key={page.id}
                        className="group flex items-center gap-4 rounded-xl border bg-card p-4 transition hover:shadow-md"
                      >
                        {/* Color bar */}
                        <div
                          className="h-12 w-1 shrink-0 rounded-full"
                          style={{ backgroundColor: color }}
                        />

                        {/* Icon */}
                        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/50">
                          <MtIcon className="size-4 text-muted-foreground" />
                        </div>

                        {/* Content */}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <h4 className="truncate text-sm font-semibold">{page.title}</h4>
                            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                              page.is_active
                                ? 'bg-emerald-50 text-emerald-700'
                                : 'bg-gray-100 text-gray-500'
                            }`}>
                              <span className={`size-1.5 rounded-full ${page.is_active ? 'bg-emerald-500' : 'bg-gray-400'}`} />
                              {page.is_active ? 'Active' : 'Inactive'}
                            </span>
                          </div>
                          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                            <span className="font-medium">{page.duration_minutes} min</span>
                            <span className="text-muted-foreground/40">|</span>
                            <span>{mtMeta?.label || 'In-Person'}</span>
                          </div>
                          <p className="mt-1 max-w-xs truncate font-mono text-[10px] text-muted-foreground/70">
                            {bookingUrl}
                          </p>
                        </div>

                        {/* Actions */}
                        <div className="flex shrink-0 items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => copyBookingLink(page.slug, page.id)}
                            className="flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-[11px] font-semibold transition hover:bg-muted"
                          >
                            {copiedId === page.id
                              ? <><Check className="size-3 text-emerald-600" />Copied</>
                              : <><Copy className="size-3" />Copy Link</>}
                          </button>
                          <button
                            type="button"
                            className="flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-[11px] font-semibold transition hover:bg-muted"
                            onClick={() => {
                              setSendEmailPageId(page.id)
                              setSendEmailSubject('Book a meeting with me')
                              setSendEmailBody(`Hi,\n\nI'd like to invite you to book a meeting with me. You can choose a time that works for you here:\n\n${bookingUrl}\n\nLooking forward to connecting!`)
                              setSendEmailTo('')
                              setSendEmailCc('')
                              setSendEmailBcc('')
                              setSendEmailSelectedContact(null)
                              setShowSendEmailCcBcc(false)
                            }}
                          >
                            <Send className="size-3" />
                            Send
                          </button>
                          <button
                            type="button"
                            onClick={() => startEditPage(page)}
                            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted/50 hover:text-foreground"
                            aria-label="Edit"
                          >
                            <Pencil className="size-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteBookingPage(page.id)}
                            disabled={deletingPageId === page.id}
                            className="flex size-7 items-center justify-center rounded-md text-red-500 transition hover:bg-red-50"
                            aria-label="Delete"
                          >
                            {deletingPageId === page.id
                              ? <Loader2 className="size-3 animate-spin" />
                              : <Trash2 className="size-3" />}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ======================== CANCELLATION EMAIL MODAL ======================== */}
      {showCancelEmail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-md rounded-xl border bg-card p-6 shadow-xl">
            <h3 className="text-sm font-semibold">Notify attendee about cancellation?</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Send a cancellation email to {showCancelEmail.guestName || showCancelEmail.guestEmail}
            </p>
            <div className="mt-4 space-y-3">
              <div>
                <label className="mb-1 block text-xs font-semibold text-muted-foreground">To</label>
                <Input value={showCancelEmail.guestEmail} disabled className="h-8 rounded-lg text-xs opacity-70" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-muted-foreground">Subject</label>
                <Input
                  value={cancelEmailSubject}
                  onChange={(event) => setCancelEmailSubject(event.target.value)}
                  className="h-8 rounded-lg text-xs"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-muted-foreground">Message</label>
                <textarea
                  value={cancelEmailBody}
                  onChange={(event) => setCancelEmailBody(event.target.value)}
                  rows={5}
                  className="w-full rounded-lg border bg-transparent px-3 py-2 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>
            <div className="mt-4 flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                className="h-8 gap-1.5 rounded-lg bg-blue-600 px-4 text-xs font-semibold text-white hover:bg-blue-700"
                onClick={handleSendCancellationEmail}
                disabled={sendingCancelEmail}
              >
                {sendingCancelEmail ? <Loader2 className="size-3.5 animate-spin" /> : <Mail className="size-3.5" />}
                Send Cancellation Email
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 rounded-lg text-xs font-semibold"
                onClick={() => setShowCancelEmail(null)}
              >
                Skip
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ======================== RECURRING DELETE MODAL ======================== */}
      {showRecurringDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-sm rounded-xl border bg-card p-6 shadow-xl">
            <h3 className="text-sm font-semibold">Delete Recurring Event</h3>
            <p className="mt-2 text-xs text-muted-foreground">
              This event is part of a recurring series. What would you like to delete?
            </p>
            <div className="mt-5 space-y-2">
              <button
                type="button"
                onClick={() => handleDeleteRecurring(showRecurringDeleteModal.eventId, false)}
                className="flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left text-sm font-medium transition hover:bg-muted/50"
              >
                <Trash2 className="size-4 text-muted-foreground" />
                <div>
                  <p>This event only</p>
                  <p className="text-xs text-muted-foreground">Remove just this single occurrence</p>
                </div>
              </button>
              <button
                type="button"
                onClick={() => handleDeleteRecurring(showRecurringDeleteModal.eventId, true)}
                className="flex w-full items-center gap-3 rounded-lg border border-red-200 px-4 py-3 text-left text-sm font-medium text-red-700 transition hover:bg-red-50"
              >
                <Trash2 className="size-4" />
                <div>
                  <p>All events in this series</p>
                  <p className="text-xs text-red-500">Remove all recurring occurrences</p>
                </div>
              </button>
            </div>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => setShowRecurringDeleteModal(null)}
                className="text-xs font-medium text-muted-foreground transition hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ======================== SEND BOOKING LINK EMAIL COMPOSE ======================== */}
      {sendEmailPageId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-lg rounded-xl border bg-card p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Send Booking Link</h3>
              <button
                type="button"
                onClick={() => setSendEmailPageId(null)}
                className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </div>
            <div className="mt-4 space-y-3">
              <div ref={sendEmailDropdownRef} className="relative">
                <label className="mb-1 block text-xs font-semibold text-muted-foreground">To</label>
                {sendEmailSelectedContact ? (
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">
                      {contactName(sendEmailSelectedContact)}
                      {sendEmailSelectedContact.primary_email && sendEmailSelectedContact.primary_email !== sendEmailSelectedContact.display_name && (
                        <span className="text-blue-500">{sendEmailSelectedContact.primary_email}</span>
                      )}
                      <button
                        type="button"
                        onClick={() => { setSendEmailSelectedContact(null); setSendEmailTo('') }}
                        className="ml-0.5 rounded-full p-0.5 hover:bg-blue-100"
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  </div>
                ) : (
                  <Input
                    value={sendEmailTo}
                    onChange={(event) => { setSendEmailTo(event.target.value); setShowSendEmailDropdown(true) }}
                    onFocus={() => { if (sendEmailTo.trim()) setShowSendEmailDropdown(true) }}
                    placeholder="Search contacts or type email..."
                    className="h-8 rounded-lg text-xs"
                  />
                )}
                {showSendEmailDropdown && sendEmailToResults.length > 0 && !sendEmailSelectedContact && (
                  <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-40 overflow-y-auto rounded-lg border bg-card shadow-lg">
                    {sendEmailToResults.map(contact => (
                      <button
                        key={contact.id}
                        type="button"
                        onClick={() => {
                          setSendEmailSelectedContact(contact)
                          setSendEmailTo(contact.primary_email || '')
                          setShowSendEmailDropdown(false)
                        }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition hover:bg-muted/50"
                      >
                        <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-blue-100 text-[10px] font-semibold text-blue-700">
                          {(contact.display_name?.[0] || contact.primary_email?.[0] || '?').toUpperCase()}
                        </div>
                        <div>
                          <p className="font-medium">{contactName(contact)}</p>
                          {contact.primary_email && <p className="text-muted-foreground">{contact.primary_email}</p>}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {!showSendEmailCcBcc && (
                <button
                  type="button"
                  onClick={() => setShowSendEmailCcBcc(true)}
                  className="text-[10px] font-medium text-muted-foreground hover:text-foreground"
                >
                  + CC / BCC
                </button>
              )}
              {showSendEmailCcBcc && (
                <>
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-muted-foreground">CC</label>
                    <Input
                      value={sendEmailCc}
                      onChange={(event) => setSendEmailCc(event.target.value)}
                      placeholder="email@example.com"
                      className="h-8 rounded-lg text-xs"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-muted-foreground">BCC</label>
                    <Input
                      value={sendEmailBcc}
                      onChange={(event) => setSendEmailBcc(event.target.value)}
                      placeholder="email@example.com"
                      className="h-8 rounded-lg text-xs"
                    />
                  </div>
                </>
              )}
              <div>
                <label className="mb-1 block text-xs font-semibold text-muted-foreground">Subject</label>
                <Input
                  value={sendEmailSubject}
                  onChange={(event) => setSendEmailSubject(event.target.value)}
                  className="h-8 rounded-lg text-xs"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-muted-foreground">Message</label>
                <textarea
                  value={sendEmailBody}
                  onChange={(event) => setSendEmailBody(event.target.value)}
                  rows={6}
                  className="w-full rounded-lg border bg-transparent px-3 py-2 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>
            <div className="mt-4 flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                className="h-8 gap-1.5 rounded-lg bg-blue-600 px-4 text-xs font-semibold text-white hover:bg-blue-700"
                disabled={(!sendEmailSelectedContact && !sendEmailTo.trim()) || sendingEmail}
                onClick={async () => {
                  setSendingEmail(true)
                  try {
                    const toEmail = sendEmailSelectedContact?.primary_email || sendEmailTo.trim()
                    await fetch('/api/email/send', {
                      method: 'POST', credentials: 'include',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        to: toEmail,
                        cc: sendEmailCc || undefined,
                        bcc: sendEmailBcc || undefined,
                        subject: sendEmailSubject,
                        body: sendEmailBody,
                      }),
                    })
                    setSendEmailPageId(null)
                  } catch { /* empty */ }
                  setSendingEmail(false)
                }}
              >
                {sendingEmail ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
                Send Email
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 rounded-lg text-xs font-semibold"
                onClick={() => setSendEmailPageId(null)}
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// =============================================
// BOOKING PAGE FORM (shared between create/edit)
// =============================================

function BookingPageForm({
  form,
  onChange,
  saving,
  onSave,
  onCancel,
  isEdit = false,
}: {
  form: {
    title: string; slug: string; description: string; duration_minutes: number
    meeting_type: string; auto_confirm: boolean; meeting_location: string; zoom_link: string
    reminder_24h: boolean; reminder_1h: boolean
  }
  onChange: (form: any) => void
  saving: boolean
  onSave: () => void
  onCancel: () => void
  isEdit?: boolean
}) {
  function update(patch: Partial<typeof form>) {
    const next = { ...form, ...patch }
    // Auto-generate a unique slug only when the slug is empty (user hasn't
    // customized it) so editing the title doesn't mint a new random suffix
    // mid-edit. Slug keeps its random suffix to avoid cross-tenant collisions.
    if ('title' in patch && patch.title !== undefined && !form.slug.trim()) {
      next.slug = slugifyWithSuffix(patch.title)
    }
    onChange(next)
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Title</label>
          <Input
            value={form.title}
            onChange={(event) => update({ title: event.target.value })}
            placeholder="30 Minute Meeting"
            className="h-9 rounded-lg text-sm"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Slug</label>
          <Input
            value={form.slug}
            onChange={(event) => update({ slug: event.target.value })}
            placeholder="30-minute-meeting"
            className="h-9 rounded-lg text-sm"
          />
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Description</label>
        <Input
          value={form.description}
          onChange={(event) => update({ description: event.target.value })}
          placeholder="A short meeting to discuss..."
          className="h-9 rounded-lg text-sm"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Duration</label>
          <select
            value={form.duration_minutes}
            onChange={(event) => update({ duration_minutes: Number(event.target.value) })}
            className="h-9 w-full rounded-lg border bg-transparent px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {([15, 30, 45, 60, 90, 120] as const).map(d => (
              <option key={d} value={d}>{DURATION_LABELS[String(d)]}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Event Type</label>
          <select
            value={form.meeting_type}
            onChange={(event) => update({ meeting_type: event.target.value, meeting_location: '', zoom_link: '' })}
            className="h-9 w-full rounded-lg border bg-transparent px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {Object.entries(EVENT_TYPE_META)
              .filter(([key]) => key !== 'focused_work' && key !== 'personal_time')
              .map(([key, meta]) => (
                <option key={key} value={key}>{meta.label}</option>
              ))}
          </select>
        </div>
      </div>

      {form.meeting_type === 'zoom' && (
        <div>
          <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Zoom Link</label>
          <Input
            value={form.zoom_link}
            onChange={(event) => update({ zoom_link: event.target.value })}
            placeholder="https://zoom.us/j/..."
            className="h-9 rounded-lg text-sm"
          />
        </div>
      )}
      {form.meeting_type === 'phone' && (
        <div>
          <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Phone Number</label>
          <Input
            value={form.meeting_location}
            onChange={(event) => update({ meeting_location: event.target.value })}
            placeholder="+1 (555) 123-4567"
            className="h-9 rounded-lg text-sm"
          />
        </div>
      )}
      {form.meeting_type === 'in_person' && (
        <div>
          <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Address</label>
          <Input
            value={form.meeting_location}
            onChange={(event) => update({ meeting_location: event.target.value })}
            placeholder="123 Main St, City..."
            className="h-9 rounded-lg text-sm"
          />
        </div>
      )}

      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Attendee Reminders</p>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form.reminder_24h}
              onChange={(e) => update({ reminder_24h: e.target.checked })}
              className="size-4 rounded border" />
            <span className="text-xs">24-hour reminder</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form.reminder_1h}
              onChange={(e) => update({ reminder_1h: e.target.checked })}
              className="size-4 rounded border" />
            <span className="text-xs">1-hour reminder</span>
          </label>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="auto-confirm"
          checked={form.auto_confirm}
          onChange={(event) => update({ auto_confirm: event.target.checked })}
          className="size-4 rounded border"
        />
        <label htmlFor="auto-confirm" className="text-xs font-medium">
          Auto-confirm bookings
        </label>
      </div>

      <div className="flex items-center gap-2 border-t pt-4">
        <Button
          type="button"
          size="sm"
          className="h-8 gap-1.5 rounded-lg bg-blue-600 px-4 text-xs font-semibold text-white hover:bg-blue-700"
          onClick={onSave}
          disabled={!form.title.trim() || saving}
        >
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {saving ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Booking Page'}
        </Button>
        <Button type="button" variant="outline" size="sm" className="h-8 rounded-lg text-xs font-semibold" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
