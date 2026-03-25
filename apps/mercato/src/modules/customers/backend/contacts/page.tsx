'use client'

import { useState, useEffect } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Plus, Search, X, Mail, DollarSign, Tag, StickyNote, Phone, Building2, ExternalLink } from 'lucide-react'

type Contact = {
  id: string
  display_name: string
  primary_email: string | null
  primary_phone: string | null
  kind: string
  status: string
  lifecycle_stage: string | null
  source: string | null
  created_at: string
  updated_at: string
}

type Activity = {
  id: string
  activity_type: string
  subject: string
  occurred_at: string
}

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const [activities, setActivities] = useState<Activity[]>([])
  const [tab, setTab] = useState<'people' | 'companies'>('people')

  useEffect(() => {
    loadContacts()
  }, [tab, search])

  function loadContacts() {
    setLoading(true)
    const endpoint = tab === 'people' ? '/api/customers/people' : '/api/customers/companies'
    const params = new URLSearchParams({ pageSize: '50' })
    if (search) params.set('search', search)

    fetch(`${endpoint}?${params}`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        // CRUD factory returns { data: [...], pagination: {...} } or { items: [...] }
        let items: Contact[] = []
        if (Array.isArray(d.data)) items = d.data
        else if (Array.isArray(d.items)) items = d.items
        else if (d.data?.items) items = d.data.items
        else if (Array.isArray(d)) items = d
        setContacts(items)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }

  function selectContact(contact: Contact) {
    setSelectedId(contact.id)
    setSelectedContact(contact)
    // Load activities
    fetch(`/api/customers/activities?entityId=${contact.id}&pageSize=10`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (d.data) setActivities(Array.isArray(d.data) ? d.data : d.data.items || [])
      })
      .catch(() => {})
  }

  function closePanel() {
    setSelectedId(null)
    setSelectedContact(null)
    setActivities([])
  }

  const stageColors: Record<string, string> = {
    prospect: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    customer: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
    active: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  }

  return (
    <div className="flex h-[calc(100vh-52px)]">
      {/* Contact List */}
      <div className={`flex-1 flex flex-col overflow-hidden ${selectedId ? 'border-r' : ''}`}>
        {/* Header */}
        <div className="px-6 py-4 border-b">
          <div className="flex items-center justify-between mb-3">
            <h1 className="text-lg font-semibold">Contacts</h1>
            <Button type="button" size="sm" onClick={() => window.location.href = '/backend/customers/people/create'}>
              <Plus className="size-3.5 mr-1.5" /> Add Contact
            </Button>
          </div>

          {/* Tabs */}
          <div className="flex gap-4 mb-3">
            {(['people', 'companies'] as const).map(t => (
              <button key={t} type="button" onClick={() => { setTab(t); closePanel() }}
                className={`text-sm font-medium pb-1 border-b-2 transition ${
                  tab === t ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}>
                {t === 'people' ? 'People' : 'Companies'}
              </button>
            ))}
          </div>

          {/* Search */}
          <div className="relative">
            <Search className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search contacts..."
              className="pl-9 h-9 text-sm"
            />
            {search && (
              <button type="button" onClick={() => setSearch('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <X className="size-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Contact List */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-6 text-sm text-muted-foreground">Loading...</div>
          ) : contacts.length === 0 ? (
            <div className="p-6 text-center">
              <p className="text-sm text-muted-foreground">{search ? 'No contacts match your search.' : 'No contacts yet.'}</p>
              {!search && (
                <Button type="button" size="sm" className="mt-3" onClick={() => window.location.href = '/backend/customers/people/create'}>
                  <Plus className="size-3.5 mr-1.5" /> Add your first contact
                </Button>
              )}
            </div>
          ) : (
            <div>
              {contacts.map(contact => (
                <button key={contact.id} type="button" onClick={() => selectContact(contact)}
                  className={`w-full text-left px-6 py-3 border-b hover:bg-muted/50 transition flex items-center gap-3 ${
                    selectedId === contact.id ? 'bg-muted/70' : ''
                  }`}>
                  {/* Avatar */}
                  <div className="w-9 h-9 rounded-full bg-accent/10 flex items-center justify-center text-accent text-xs font-semibold shrink-0">
                    {contact.display_name?.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase() || '?'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{contact.display_name}</p>
                    <p className="text-xs text-muted-foreground truncate">{contact.primary_email || contact.primary_phone || 'No contact info'}</p>
                  </div>
                  {contact.lifecycle_stage && (
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${stageColors[contact.lifecycle_stage] || 'bg-muted text-muted-foreground'}`}>
                      {contact.lifecycle_stage}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Side Panel */}
      {selectedContact && (
        <div className="w-[400px] shrink-0 flex flex-col overflow-hidden">
          {/* Panel Header */}
          <div className="px-5 py-4 border-b flex items-start justify-between">
            <div>
              <h2 className="text-lg font-semibold">{selectedContact.display_name}</h2>
              {selectedContact.primary_email && (
                <p className="text-sm text-muted-foreground">{selectedContact.primary_email}</p>
              )}
            </div>
            <IconButton type="button" variant="ghost" size="sm" onClick={closePanel} aria-label="Close">
              <X className="size-4" />
            </IconButton>
          </div>

          {/* Quick Actions */}
          <div className="px-5 py-3 border-b flex gap-2">
            <Button type="button" variant="outline" size="sm">
              <Mail className="size-3.5 mr-1.5" /> Email
            </Button>
            <Button type="button" variant="outline" size="sm">
              <DollarSign className="size-3.5 mr-1.5" /> Deal
            </Button>
            <Button type="button" variant="outline" size="sm">
              <StickyNote className="size-3.5 mr-1.5" /> Note
            </Button>
          </div>

          {/* Contact Details */}
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            <div className="space-y-3">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Details</h3>
              <DetailRow icon={Mail} label="Email" value={selectedContact.primary_email} />
              <DetailRow icon={Phone} label="Phone" value={selectedContact.primary_phone} />
              <DetailRow icon={Building2} label="Type" value={selectedContact.kind === 'person' ? 'Person' : 'Company'} />
              <DetailRow icon={Tag} label="Source" value={selectedContact.source} />
              <DetailRow icon={Tag} label="Stage" value={selectedContact.lifecycle_stage} />
            </div>

            {/* Activity Timeline */}
            <div className="pt-3 border-t">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Activity</h3>
              {activities.length === 0 ? (
                <p className="text-xs text-muted-foreground">No activity yet.</p>
              ) : (
                <div className="space-y-3">
                  {activities.map(a => (
                    <div key={a.id} className="flex gap-3">
                      <div className="w-1.5 h-1.5 rounded-full bg-accent mt-1.5 shrink-0" />
                      <div>
                        <p className="text-sm">{a.subject}</p>
                        <p className="text-[11px] text-muted-foreground">{formatRelativeTime(a.occurred_at)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* View Full Profile Link */}
            <div className="pt-3 border-t">
              <a href={`/backend/customers/people/${selectedContact.id}`}
                className="text-xs text-accent hover:underline flex items-center gap-1">
                View full profile <ExternalLink className="size-3" />
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function DetailRow({ icon: Icon, label, value }: { icon: any; label: string; value: string | null | undefined }) {
  if (!value) return null
  return (
    <div className="flex items-center gap-3">
      <Icon className="size-3.5 text-muted-foreground shrink-0" />
      <div>
        <p className="text-[11px] text-muted-foreground">{label}</p>
        <p className="text-sm">{value}</p>
      </div>
    </div>
  )
}

function formatRelativeTime(time: string): string {
  const diff = Date.now() - new Date(time).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
