'use client'

import { useState, useEffect } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Plus, Calendar, Clock, User, X, Link2, ExternalLink, Loader2 } from 'lucide-react'

type BookingPage = {
  id: string; title: string; slug: string; description: string | null
  duration_minutes: number; is_active: boolean; created_at: string
}

type Booking = {
  id: string; guest_name: string; guest_email: string; start_time: string
  end_time: string; status: string; booking_page_id: string
}

type Tab = 'upcoming' | 'pages'

export default function CalendarPage() {
  const [tab, setTab] = useState<Tab>('upcoming')
  const [bookingPages, setBookingPages] = useState<BookingPage[]>([])
  const [bookings, setBookings] = useState<Booking[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newSlug, setNewSlug] = useState('')
  const [newDuration, setNewDuration] = useState('30')
  const [newDescription, setNewDescription] = useState('')
  const [creating, setCreating] = useState(false)

  useEffect(() => { loadData() }, [tab])

  function loadData() {
    setLoading(true)
    if (tab === 'upcoming') {
      fetch('/api/calendar/bookings?upcoming=true', { credentials: 'include' })
        .then(r => r.json()).then(d => { if (d.ok) setBookings(d.data || []); setLoading(false) }).catch(() => setLoading(false))
    } else {
      fetch('/api/calendar/booking-pages', { credentials: 'include' })
        .then(r => r.json()).then(d => { if (d.ok) setBookingPages(d.data || []); setLoading(false) }).catch(() => setLoading(false))
    }
  }

  async function createBookingPage() {
    if (!newTitle.trim() || !newSlug.trim()) return
    setCreating(true)
    try {
      const res = await fetch('/api/calendar/booking-pages', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ title: newTitle, slug: newSlug, description: newDescription, durationMinutes: parseInt(newDuration) }),
      })
      const data = await res.json()
      if (data.ok) {
        setNewTitle(''); setNewSlug(''); setNewDescription(''); setShowCreate(false); loadData()
      } else alert(data.error)
    } catch {}
    setCreating(false)
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold">Calendar</h1>
        {tab === 'pages' && (
          <Button type="button" size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="size-3.5 mr-1.5" /> New Booking Page
          </Button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-4 mb-6">
        {([
          { id: 'upcoming' as Tab, label: 'Upcoming Bookings', icon: Calendar },
          { id: 'pages' as Tab, label: 'Booking Pages', icon: Link2 },
        ]).map(t => (
          <button key={t.id} type="button" onClick={() => { setTab(t.id); setShowCreate(false) }}
            className={`flex items-center gap-2 text-sm font-medium pb-1 border-b-2 transition ${
              tab === t.id ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}>
            <t.icon className="size-4" /> {t.label}
          </button>
        ))}
      </div>

      {/* Create Booking Page */}
      {showCreate && (
        <div className="rounded-lg border bg-card p-5 mb-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">New Booking Page</h3>
            <IconButton type="button" variant="ghost" size="sm" onClick={() => setShowCreate(false)} aria-label="Close"><X className="size-4" /></IconButton>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Title</label>
              <Input value={newTitle} onChange={e => { setNewTitle(e.target.value); if (!newSlug || newSlug === newTitle.toLowerCase().replace(/[^a-z0-9]+/g,'-')) setNewSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g,'-')) }}
                placeholder="e.g. Free Strategy Call" className="h-9 text-sm" autoFocus />
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">URL Slug</label>
              <Input value={newSlug} onChange={e => setNewSlug(e.target.value)} placeholder="strategy-call" className="h-9 text-sm" />
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Duration (min)</label>
              <select value={newDuration} onChange={e => setNewDuration(e.target.value)}
                className="w-full h-9 rounded-md border bg-card px-3 text-sm">
                <option value="15">15 minutes</option>
                <option value="30">30 minutes</option>
                <option value="45">45 minutes</option>
                <option value="60">60 minutes</option>
                <option value="90">90 minutes</option>
              </select>
            </div>
            <div className="col-span-2">
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Description</label>
              <Input value={newDescription} onChange={e => setNewDescription(e.target.value)} placeholder="What will you discuss?" className="h-9 text-sm" />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button type="button" size="sm" onClick={createBookingPage} disabled={creating || !newTitle.trim() || !newSlug.trim()}>
              {creating ? <Loader2 className="size-3 animate-spin mr-1" /> : <Plus className="size-3 mr-1" />} Create
            </Button>
          </div>
        </div>
      )}

      {/* Upcoming Bookings */}
      {tab === 'upcoming' && (
        loading ? <div className="text-sm text-muted-foreground">Loading...</div> :
        bookings.length === 0 ? (
          <div className="rounded-lg border p-12 text-center">
            <Calendar className="size-8 mx-auto mb-3 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">No upcoming bookings.</p>
            <p className="text-xs text-muted-foreground mt-1">Create a booking page and share the link to start getting booked.</p>
          </div>
        ) : (
          <div className="rounded-lg border divide-y">
            {bookings.map(b => (
              <div key={b.id} className="flex items-center gap-4 px-5 py-4">
                <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center shrink-0">
                  <Clock className="size-5 text-accent" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{b.guest_name}</p>
                  <p className="text-xs text-muted-foreground">{b.guest_email}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-sm font-medium">{new Date(b.start_time).toLocaleDateString()}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(b.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — {new Date(b.end_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {/* Booking Pages */}
      {tab === 'pages' && (
        loading ? <div className="text-sm text-muted-foreground">Loading...</div> :
        bookingPages.length === 0 ? (
          <div className="rounded-lg border p-12 text-center">
            <Link2 className="size-8 mx-auto mb-3 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">No booking pages yet.</p>
            <Button type="button" size="sm" className="mt-3" onClick={() => setShowCreate(true)}>
              <Plus className="size-3.5 mr-1.5" /> Create Booking Page
            </Button>
          </div>
        ) : (
          <div className="rounded-lg border divide-y">
            {bookingPages.map(p => (
              <div key={p.id} className="flex items-center gap-4 px-5 py-4">
                <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center shrink-0">
                  <Calendar className="size-5 text-accent" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{p.title}</p>
                  <p className="text-xs text-muted-foreground">{p.duration_minutes} min · /book/{p.slug}</p>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={() => {
                  const url = `${window.location.origin}/book/${p.slug}`
                  navigator.clipboard.writeText(url).then(() => alert('Booking link copied!'))
                }}>
                  <Link2 className="size-3 mr-1" /> Copy Link
                </Button>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  )
}
