'use client'

import { useState, useEffect } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Plus, Search, X, Mail, DollarSign, Tag, StickyNote, Phone, Building2, ExternalLink, CheckCircle2, Circle, Send, Loader2, Upload, MessageSquare } from 'lucide-react'
import { EmailComposeModal } from '@/components/EmailComposeModal'
import { CreateDealModal } from '@/components/CreateDealModal'
import { SmsComposeModal } from '@/components/SmsComposeModal'

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

type Note = { id: string; content: string; created_at: string }
type Task = { id: string; title: string; due_date: string | null; is_done: boolean; created_at: string }
type ContactTag = { id: string; name: string; slug: string; color: string }

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const [notes, setNotes] = useState<Note[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [contactTags, setContactTags] = useState<ContactTag[]>([])
  const [newTagName, setNewTagName] = useState('')
  const [showImport, setShowImport] = useState(false)
  const [importData, setImportData] = useState('')
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<any>(null)
  const [tab, setTab] = useState<'people' | 'companies'>('people')
  const [panelTab, setPanelTab] = useState<'details' | 'notes' | 'tasks'>('details')
  const [showEmailModal, setShowEmailModal] = useState(false)
  const [showDealModal, setShowDealModal] = useState(false)
  const [showSmsModal, setShowSmsModal] = useState(false)
  const [newNote, setNewNote] = useState('')
  const [newTask, setNewTask] = useState('')
  const [savingNote, setSavingNote] = useState(false)
  const [savingTask, setSavingTask] = useState(false)

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
    setPanelTab('details')
    setNewNote('')
    setNewTask('')
    // Load notes, tasks, and tags
    fetch(`/api/notes?contactId=${contact.id}`, { credentials: 'include' })
      .then(r => r.json()).then(d => { if (d.ok) setNotes(d.data || []) }).catch(() => {})
    fetch(`/api/tasks?contactId=${contact.id}`, { credentials: 'include' })
      .then(r => r.json()).then(d => { if (d.ok) setTasks(d.data || []) }).catch(() => {})
    fetch(`/api/contact-tags?contactId=${contact.id}`, { credentials: 'include' })
      .then(r => r.json()).then(d => { if (d.ok) setContactTags(d.data || []) }).catch(() => {})
  }

  function closePanel() {
    setSelectedId(null)
    setSelectedContact(null)
    setNotes([])
    setTasks([])
    setContactTags([])
  }

  async function addTag() {
    if (!newTagName.trim() || !selectedContact) return
    try {
      const res = await fetch('/api/contact-tags', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ contactId: selectedContact.id, tagName: newTagName }),
      })
      const data = await res.json()
      if (data.ok && data.data) {
        setContactTags(prev => [...prev.filter(t => t.id !== data.data.id), data.data])
        setNewTagName('')
      }
    } catch {}
  }

  async function removeTag(tagId: string) {
    if (!selectedContact) return
    try {
      await fetch('/api/contact-tags', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ contactId: selectedContact.id, tagId, action: 'remove' }),
      })
      setContactTags(prev => prev.filter(t => t.id !== tagId))
    } catch {}
  }

  async function importContacts() {
    if (!importData.trim()) return
    setImporting(true)
    setImportResult(null)
    try {
      // Parse CSV-like data (name, email per line)
      const lines = importData.trim().split('\n').filter(l => l.trim())
      const contacts = lines.map(line => {
        const parts = line.split(/[,\t]+/).map(p => p.trim())
        // Try to detect: name, email, phone
        const email = parts.find(p => p.includes('@'))
        const phone = parts.find(p => /^\+?\d[\d\s()-]{6,}$/.test(p))
        const name = parts.find(p => p !== email && p !== phone) || email
        return { name, email, phone }
      }).filter(c => c.name || c.email)

      const res = await fetch('/api/contacts/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ contacts }),
      })
      const data = await res.json()
      if (data.ok) {
        setImportResult(data.data)
        if (data.data.imported > 0) loadContacts()
      }
    } catch {}
    setImporting(false)
  }

  async function addNote() {
    if (!newNote.trim() || !selectedContact) return
    setSavingNote(true)
    try {
      const res = await fetch('/api/notes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ contactId: selectedContact.id, content: newNote }),
      })
      const data = await res.json()
      if (data.ok) { setNotes(prev => [data.data, ...prev]); setNewNote('') }
    } catch {}
    setSavingNote(false)
  }

  async function addTask() {
    if (!newTask.trim() || !selectedContact) return
    setSavingTask(true)
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ title: newTask, contactId: selectedContact.id }),
      })
      const data = await res.json()
      if (data.ok) { setTasks(prev => [data.data, ...prev]); setNewTask('') }
    } catch {}
    setSavingTask(false)
  }

  async function toggleTask(task: Task) {
    try {
      await fetch('/api/tasks', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ id: task.id, is_done: !task.is_done }),
      })
      setTasks(prev => prev.map(t => t.id === task.id ? { ...t, is_done: !t.is_done } : t))
    } catch {}
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
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setShowImport(true)}>
                <Upload className="size-3.5 mr-1.5" /> Import
              </Button>
              <Button type="button" size="sm" onClick={() => window.location.href = '/backend/customers/people/create'}>
                <Plus className="size-3.5 mr-1.5" /> Add Contact
              </Button>
            </div>
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

      {/* Import Modal */}
      {showImport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-background rounded-xl border shadow-2xl w-full max-w-lg mx-4">
            <div className="flex items-center justify-between px-5 py-3 border-b">
              <h2 className="text-sm font-semibold">Import Contacts</h2>
              <IconButton type="button" variant="ghost" size="sm" onClick={() => { setShowImport(false); setImportResult(null); setImportData('') }} aria-label="Close">
                <X className="size-4" />
              </IconButton>
            </div>
            <div className="p-5 space-y-3">
              {importResult ? (
                <div className="text-center py-4">
                  <CheckCircle2 className="size-8 mx-auto mb-2 text-emerald-500" />
                  <p className="text-sm font-medium">{importResult.imported} contacts imported</p>
                  {importResult.skipped > 0 && <p className="text-xs text-muted-foreground">{importResult.skipped} skipped (duplicates)</p>}
                  <Button type="button" size="sm" className="mt-4" onClick={() => { setShowImport(false); setImportResult(null); setImportData('') }}>Done</Button>
                </div>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">Paste contacts below — one per line. Format: <code className="bg-muted px-1 rounded">Name, email, phone</code></p>
                  <textarea value={importData} onChange={e => setImportData(e.target.value)}
                    placeholder="Jane Doe, jane@example.com, +1-555-1234&#10;John Smith, john@company.com&#10;Sarah Chen, sarah@startup.io"
                    className="w-full rounded-md border bg-card px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring h-32 font-mono" autoFocus />
                  <div className="flex justify-between items-center">
                    <p className="text-xs text-muted-foreground">{importData.trim().split('\n').filter(l => l.trim()).length} contacts</p>
                    <Button type="button" size="sm" onClick={importContacts} disabled={importing || !importData.trim()}>
                      {importing ? <><Loader2 className="size-3 animate-spin mr-1" /> Importing...</> : <><Upload className="size-3 mr-1" /> Import</>}
                    </Button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* SMS Modal */}
      {showSmsModal && selectedContact && (
        <SmsComposeModal
          contactName={selectedContact.display_name}
          contactPhone={selectedContact.primary_phone || ''}
          contactId={selectedContact.id}
          onClose={() => setShowSmsModal(false)}
          onSent={() => setShowSmsModal(false)}
        />
      )}

      {/* Deal Modal */}
      {showDealModal && selectedContact && (
        <CreateDealModal
          contactName={selectedContact.display_name}
          contactId={selectedContact.id}
          onClose={() => setShowDealModal(false)}
          onCreated={() => setShowDealModal(false)}
        />
      )}

      {/* Email Modal */}
      {showEmailModal && selectedContact && (
        <EmailComposeModal
          contactName={selectedContact.display_name}
          contactEmail={selectedContact.primary_email || ''}
          contactId={selectedContact.id}
          onClose={() => setShowEmailModal(false)}
          onSent={() => setShowEmailModal(false)}
        />
      )}

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
            <Button type="button" variant="outline" size="sm" onClick={() => setShowEmailModal(true)}
              disabled={!selectedContact?.primary_email}>
              <Mail className="size-3.5 mr-1.5" /> Email
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setShowDealModal(true)}>
              <DollarSign className="size-3.5 mr-1.5" /> Deal
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setPanelTab('notes')}>
              <StickyNote className="size-3.5 mr-1.5" /> Note
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setShowSmsModal(true)}
              disabled={!selectedContact?.primary_phone}>
              <MessageSquare className="size-3.5 mr-1.5" /> Text
            </Button>
          </div>

          {/* Panel Tabs */}
          <div className="flex border-b px-5">
            {(['details', 'notes', 'tasks'] as const).map(t => (
              <button key={t} type="button" onClick={() => setPanelTab(t)}
                className={`text-xs font-medium px-3 py-2.5 border-b-2 transition capitalize ${
                  panelTab === t ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}>{t}</button>
            ))}
          </div>

          {/* Panel Content */}
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {/* Details Tab */}
            {panelTab === 'details' && (
              <div className="space-y-3">
                <DetailRow icon={Mail} label="Email" value={selectedContact.primary_email} />
                <DetailRow icon={Phone} label="Phone" value={selectedContact.primary_phone} />
                <DetailRow icon={Building2} label="Type" value={selectedContact.kind === 'person' ? 'Person' : 'Company'} />
                <DetailRow icon={Tag} label="Source" value={selectedContact.source} />
                <DetailRow icon={Tag} label="Stage" value={selectedContact.lifecycle_stage} />

                {/* Tags */}
                <div className="pt-3 border-t">
                  <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-2">Tags</label>
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {contactTags.map(tag => (
                      <span key={tag.id} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full"
                        style={{ backgroundColor: tag.color + '20', color: tag.color }}>
                        {tag.name}
                        <button type="button" onClick={() => removeTag(tag.id)} className="hover:opacity-70">
                          <X className="size-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                  <div className="flex gap-1.5">
                    <Input value={newTagName} onChange={e => setNewTagName(e.target.value)}
                      placeholder="Add tag..." className="h-7 text-xs flex-1"
                      onKeyDown={e => { if (e.key === 'Enter') addTag() }} />
                    <Button type="button" size="sm" variant="outline" onClick={addTag}
                      disabled={!newTagName.trim()} className="h-7 text-xs px-2">
                      <Plus className="size-3" />
                    </Button>
                  </div>
                </div>

                <div className="pt-3 border-t">
                  <a href={`/backend/customers/people/${selectedContact.id}`}
                    className="text-xs text-accent hover:underline flex items-center gap-1">
                    View full profile <ExternalLink className="size-3" />
                  </a>
                </div>
              </div>
            )}

            {/* Notes Tab */}
            {panelTab === 'notes' && (
              <div className="space-y-3">
                <div className="flex gap-2">
                  <textarea value={newNote} onChange={e => setNewNote(e.target.value)}
                    placeholder="Add a note..."
                    className="flex-1 rounded-md border bg-card px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring h-16"
                    onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) addNote() }} />
                </div>
                <Button type="button" size="sm" onClick={addNote} disabled={savingNote || !newNote.trim()} className="w-full">
                  {savingNote ? <Loader2 className="size-3 animate-spin mr-1" /> : <Plus className="size-3 mr-1" />} Add Note
                </Button>
                {notes.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-4">No notes yet.</p>
                ) : (
                  <div className="space-y-2 pt-2">
                    {notes.map(note => (
                      <div key={note.id} className="rounded-lg border p-3">
                        <p className="text-sm whitespace-pre-wrap">{note.content}</p>
                        <p className="text-[10px] text-muted-foreground mt-2">{formatRelativeTime(note.created_at)}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Tasks Tab */}
            {panelTab === 'tasks' && (
              <div className="space-y-3">
                <div className="flex gap-2">
                  <Input value={newTask} onChange={e => setNewTask(e.target.value)}
                    placeholder="Add a task..."
                    className="flex-1 h-9 text-sm"
                    onKeyDown={e => { if (e.key === 'Enter') addTask() }} />
                  <Button type="button" size="sm" onClick={addTask} disabled={savingTask || !newTask.trim()}>
                    <Plus className="size-3" />
                  </Button>
                </div>
                {tasks.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-4">No tasks yet.</p>
                ) : (
                  <div className="space-y-1 pt-2">
                    {tasks.map(task => (
                      <button key={task.id} type="button" onClick={() => toggleTask(task)}
                        className="w-full flex items-start gap-2.5 px-2 py-2 rounded-md hover:bg-muted/50 transition text-left">
                        {task.is_done
                          ? <CheckCircle2 className="size-4 text-emerald-500 shrink-0 mt-0.5" />
                          : <Circle className="size-4 text-muted-foreground/40 shrink-0 mt-0.5" />
                        }
                        <div className="flex-1 min-w-0">
                          <p className={`text-sm ${task.is_done ? 'line-through text-muted-foreground' : ''}`}>{task.title}</p>
                          {task.due_date && (
                            <p className="text-[10px] text-muted-foreground">
                              Due {new Date(task.due_date).toLocaleDateString()}
                            </p>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
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
