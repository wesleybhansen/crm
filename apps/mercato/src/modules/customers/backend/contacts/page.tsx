'use client'

import { useState, useEffect } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { Plus, Search, X, Mail, DollarSign, Tag, StickyNote, Phone, Building2, ExternalLink, CheckCircle2, Circle, Send, Loader2, Upload, MessageSquare, Flame, FileText, Activity, CheckSquare, Calendar, BookOpen, TrendingUp, Clock, Bell, Paperclip, Download, Trash2, Briefcase, Sparkles, RefreshCw, Camera, Users, Pencil, Check, ChevronDown, Filter } from 'lucide-react'
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
type TimelineEvent = { type: string; title: string; description?: string; icon: string; timestamp: string; metadata?: Record<string, unknown> }
type Attachment = { id: string; filename: string; file_size: number; mime_type: string | null; file_url: string; created_at: string }

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

  // Photo scan
  const [showScan, setShowScan] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [scanResults, setScanResults] = useState<any[] | null>(null)
  const [scanTags, setScanTags] = useState('')
  const [scanSaving, setScanSaving] = useState(false)
  const [scanFile, setScanFile] = useState<File | null>(null)
  const [scanStage, setScanStage] = useState('')
  const [pipelineStages, setPipelineStages] = useState<string[]>([])
  const [stagesLoaded, setStagesLoaded] = useState(false)
  const [tab, setTab] = useState<'people' | 'companies' | 'tasks'>('people')

  // Filters
  const [showFilters, setShowFilters] = useState(false)
  const [filterTag, setFilterTag] = useState('')
  const [filterStage, setFilterStage] = useState('')
  const [filterEngagement, setFilterEngagement] = useState<'' | 'hot' | 'warm' | 'cold'>('')
  const [availableFilterTags, setAvailableFilterTags] = useState<Array<{ id: string; name: string; slug: string }>>([])

  const [filterTagsLoaded, setFilterTagsLoaded] = useState(false)
  const [allTasks, setAllTasks] = useState<Task[]>([])
  const [allTasksLoading, setAllTasksLoading] = useState(false)
  const [completedTasks, setCompletedTasks] = useState<Task[]>([])
  const [completedOpen, setCompletedOpen] = useState(false)
  const [showCreateCompany, setShowCreateCompany] = useState(false)
  const [companyName, setCompanyName] = useState('')
  const [companyEmail, setCompanyEmail] = useState('')
  const [companyPhone, setCompanyPhone] = useState('')
  const [companyWebsite, setCompanyWebsite] = useState('')
  const [companyCreating, setCompanyCreating] = useState(false)
  const [companyLinkPeople, setCompanyLinkPeople] = useState<string[]>([])
  const [companyLinkSearch, setCompanyLinkSearch] = useState('')
  const [companyLinkDropdown, setCompanyLinkDropdown] = useState(false)
  const [editCompanyId, setEditCompanyId] = useState<string | null>(null)
  const [editCompanyName, setEditCompanyName] = useState('')

  // Company detail
  const [companyPeople, setCompanyPeople] = useState<Array<{ entityId: string; display_name: string; primary_email: string | null; job_title: string | null }>>([])
  const [companyPeopleLoading, setCompanyPeopleLoading] = useState(false)
  const [linkPersonSearch, setLinkPersonSearch] = useState('')
  const [linkPersonDropdown, setLinkPersonDropdown] = useState(false)
  const [allPeopleForLink, setAllPeopleForLink] = useState<Contact[]>([])

  // Person company link
  const [personCompany, setPersonCompany] = useState<{ entityId: string; displayName: string } | null>(null)
  const [linkCompanySearch, setLinkCompanySearch] = useState('')
  const [linkCompanyDropdown, setLinkCompanyDropdown] = useState(false)
  const [allCompaniesForLink, setAllCompaniesForLink] = useState<Contact[]>([])
  const [panelTab, setPanelTab] = useState<'timeline' | 'details' | 'notes' | 'tasks'>('timeline')
  const [showEmailModal, setShowEmailModal] = useState(false)
  const [showDealModal, setShowDealModal] = useState(false)
  const [showSmsModal, setShowSmsModal] = useState(false)
  const [newNote, setNewNote] = useState('')
  const [newTask, setNewTask] = useState('')
  const [newTaskDue, setNewTaskDue] = useState('')
  const [savingNote, setSavingNote] = useState(false)
  const [savingTask, setSavingTask] = useState(false)
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null)
  const [editingTaskTitle, setEditingTaskTitle] = useState('')
  const [engagementScore, setEngagementScore] = useState<number>(0)
  const [timeline, setTimeline] = useState<TimelineEvent[]>([])
  const [timelineLoading, setTimelineLoading] = useState(false)
  const [showRemindForm, setShowRemindForm] = useState(false)
  const [remindDate, setRemindDate] = useState('')
  const [remindMessage, setRemindMessage] = useState('')
  const [savingReminder, setSavingReminder] = useState(false)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [uploadingFile, setUploadingFile] = useState(false)
  const [contactPerson, setContactPerson] = useState<{ job_title: string | null; department: string | null; company_name: string | null; company_id: string | null } | null>(null)
  const [companyColleagues, setCompanyColleagues] = useState<Array<{ id: string; display_name: string; primary_email: string | null }>>([])
  const [loadingCompanyInfo, setLoadingCompanyInfo] = useState(false)
  const [contactSummary, setContactSummary] = useState<string | null>(null)
  const [summaryIsAi, setSummaryIsAi] = useState(false)
  const [loadingSummary, setLoadingSummary] = useState(false)

  useEffect(() => {
    loadContacts()
    // Load pipeline stages for the stage dropdown
    if (!stagesLoaded) {
      setStagesLoaded(true)
      fetch('/api/customers/business-profile', { credentials: 'include' }).then(r => r.json()).then(d => {
        if (d.ok && d.data?.pipeline_stages) {
          const ps = typeof d.data.pipeline_stages === 'string' ? JSON.parse(d.data.pipeline_stages) : d.data.pipeline_stages
          setPipelineStages(ps.map((s: any) => s.name || s).filter(Boolean))
        }
        if (pipelineStages.length === 0) setPipelineStages(['New Lead', 'Contacted', 'Qualified', 'Proposal', 'Won', 'Lost'])
      }).catch(() => setPipelineStages(['New Lead', 'Contacted', 'Qualified', 'Proposal', 'Won', 'Lost']))
    }
  }, [tab, search, filterTag, filterStage, filterEngagement])

  function loadContacts() {
    setLoading(true)
    const endpoint = tab === 'people' ? '/api/customers/people' : '/api/customers/companies'
    const params = new URLSearchParams({ pageSize: '50' })
    if (search) params.set('search', search)
    if (filterTag) params.set('tagIds', filterTag)
    if (filterStage) params.set('lifecycleStage', filterStage)
    if (filterEngagement === 'hot') params.set('status', 'hot')
    if (filterEngagement === 'warm') params.set('status', 'warm')
    if (filterEngagement === 'cold') params.set('status', 'cold')

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
    setPanelTab('timeline')
    setNewNote('')
    setNewTask('')
    // Load timeline
    setTimelineLoading(true)
    fetch(`/api/contacts/${contact.id}/timeline`, { credentials: 'include' })
      .then(r => r.json()).then(d => { console.log('[timeline-ui] Response:', d.ok, d.data?.length || 0, d.error || ''); if (d.ok) setTimeline(d.data || []) }).catch(err => { console.error('[timeline-ui] Fetch error:', err); setTimeline([]) })
      .finally(() => setTimelineLoading(false))
    // Load notes, tasks, and tags
    fetch(`/api/customers/notes?contactId=${contact.id}`, { credentials: 'include' })
      .then(r => r.json()).then(d => { if (d.ok) setNotes(d.data || []) }).catch(() => {})
    fetch(`/api/customers/tasks?contactId=${contact.id}`, { credentials: 'include' })
      .then(r => r.json()).then(d => { if (d.ok) setTasks(d.data || []) }).catch(() => {})
    fetch(`/api/crm-contact-tags?contactId=${contact.id}`, { credentials: 'include' })
      .then(r => r.json()).then(d => { if (d.ok) setContactTags(d.data || []) }).catch(() => {})
    fetch(`/api/customers/engagement?contactId=${contact.id}`, { credentials: 'include' })
      .then(r => r.json()).then(d => { if (d.ok) setEngagementScore(d.data?.score || 0) }).catch(() => setEngagementScore(0))
    fetch(`/api/contacts/${contact.id}/attachments`, { credentials: 'include' })
      .then(r => r.json()).then(d => { if (d.ok) setAttachments(d.data || []) }).catch(() => setAttachments([]))
    // Reset AI summary — user must click button to generate
    setContactSummary(null)
    setSummaryIsAi(false)
    setLoadingSummary(false)
    // Load company people (if selecting a company) or person's company link
    setCompanyPeople([]); setPersonCompany(null)
    if (tab === 'companies') {
      loadCompanyPeople(contact.id)
      loadAllPeopleForLink()
    } else {
      loadPersonCompany(contact.id)
    }
    // Load person/company info
    setContactPerson(null)
    setCompanyColleagues([])
    setLoadingCompanyInfo(true)
    fetch(`/api/contacts/${contact.id}/company-info`, { credentials: 'include' })
      .then(r => r.json()).then(d => {
        if (d.ok) {
          setContactPerson(d.data?.person || null)
          setCompanyColleagues(d.data?.colleagues || [])
        }
      }).catch(() => {}).finally(() => setLoadingCompanyInfo(false))
  }

  function closePanel() {
    setSelectedId(null)
    setSelectedContact(null)
    setNotes([])
    setTasks([])
    setContactTags([])
    setTimeline([])
    setAttachments([])
    setContactPerson(null)
    setCompanyColleagues([])
    setContactSummary(null)
    setSummaryIsAi(false)
  }

  async function addTag() {
    if (!newTagName.trim() || !selectedContact) return
    try {
      const res = await fetch('/api/crm-contact-tags', {
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
      await fetch('/api/crm-contact-tags', {
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
      const res = await fetch('/api/customers/notes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ contactId: selectedContact.id, content: newNote }),
      })
      const data = await res.json()
      if (data.ok) { setNotes(prev => [data.data, ...prev]); setNewNote('') }
    } catch {}
    setSavingNote(false)
  }

  async function addTask() {
    if (!newTask.trim()) return
    setSavingTask(true)
    try {
      const res = await fetch('/api/customers/tasks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ title: newTask, contactId: selectedContact?.id || null, dueDate: newTaskDue || null }),
      })
      const data = await res.json()
      if (data.ok) {
        if (selectedContact) setTasks(prev => [data.data, ...prev])
        if (tab === 'tasks') setAllTasks(prev => [data.data, ...prev])
        setNewTask(''); setNewTaskDue('')
      }
    } catch {}
    setSavingTask(false)
  }

  async function toggleTask(task: Task) {
    try {
      await fetch('/api/customers/tasks', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ id: task.id, is_done: !task.is_done }),
      })
      const toggled = { ...task, is_done: !task.is_done }
      // Update contact-scoped tasks
      setTasks(prev => prev.map(t => t.id === task.id ? toggled : t))
      // Move between open and completed lists
      if (toggled.is_done) {
        setAllTasks(prev => prev.filter(t => t.id !== task.id))
        setCompletedTasks(prev => [toggled, ...prev])
      } else {
        setCompletedTasks(prev => prev.filter(t => t.id !== task.id))
        setAllTasks(prev => [toggled, ...prev])
      }
    } catch {}
  }

  async function saveTaskEdit(taskId: string) {
    if (!editingTaskTitle.trim()) return
    try {
      await fetch('/api/customers/tasks', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ id: taskId, title: editingTaskTitle.trim() }),
      })
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, title: editingTaskTitle.trim() } : t))
    } catch {}
    setEditingTaskId(null); setEditingTaskTitle('')
  }

  async function deleteTask(taskId: string) {
    if (!confirm('Delete this task?')) return
    try {
      await fetch(`/api/customers/tasks?id=${taskId}`, { method: 'DELETE', credentials: 'include' })
      setTasks(prev => prev.filter(t => t.id !== taskId))
      setAllTasks(prev => prev.filter(t => t.id !== taskId))
    } catch {}
  }

  function loadCompanyPeople(companyEntityId: string) {
    setCompanyPeopleLoading(true)
    fetch(`/api/crm-company-links?companyEntityId=${companyEntityId}`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.ok) setCompanyPeople(d.data || []) })
      .catch(() => {})
      .finally(() => setCompanyPeopleLoading(false))
  }

  function loadPersonCompany(personEntityId: string) {
    fetch(`/api/crm-company-links?personEntityId=${personEntityId}`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.ok) setPersonCompany(d.data || null) })
      .catch(() => {})
  }

  async function linkPersonToCompany(personEntityId: string, companyEntityId: string | null) {
    await fetch('/api/crm-company-links', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ personEntityId, companyEntityId }),
    })
    // Reload relevant data
    if (selectedContact && tab === 'companies') loadCompanyPeople(selectedContact.id)
    if (selectedContact && tab === 'people') loadPersonCompany(selectedContact.id)
    setLinkPersonSearch(''); setLinkPersonDropdown(false)
    setLinkCompanySearch(''); setLinkCompanyDropdown(false)
  }

  function loadAllPeopleForLink() {
    // Always reload to ensure fresh data
    fetch('/api/customers/people?pageSize=100', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        let items: Contact[] = []
        if (Array.isArray(d.data?.items)) items = d.data.items
        else if (Array.isArray(d.data)) items = d.data
        else if (Array.isArray(d.items)) items = d.items
        else if (Array.isArray(d)) items = d
        if (items.length > 0) setAllPeopleForLink(items)
      }).catch(() => {})
  }

  function loadAllCompaniesForLink() {
    fetch('/api/customers/companies?pageSize=100', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        let items: Contact[] = []
        if (Array.isArray(d.data?.items)) items = d.data.items
        else if (Array.isArray(d.data)) items = d.data
        else if (Array.isArray(d.items)) items = d.items
        else if (Array.isArray(d)) items = d
        // Filter out contacts with encrypted display names
        items = items.filter(c => c.display_name && !/^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:v\d+$/.test(c.display_name))
        if (items.length > 0) setAllCompaniesForLink(items)
      }).catch(() => {})
  }

  async function deleteContact(id: string, name: string) {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return
    try {
      const res = await fetch('/api/customers/people', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ id }),
      })
      if (res.ok) {
        // Remove from local state immediately
        setContacts(prev => prev.filter(c => c.id !== id))
        if (selectedId === id) closePanel()
      }
    } catch {}
  }

  async function updateCompany(id: string, name: string) {
    try {
      await fetch(`/api/customers/companies/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ displayName: name.trim() }),
      })
      loadContacts()
    } catch {}
    setEditCompanyId(null)
  }

  async function deleteCompany(id: string, name: string) {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return
    try {
      const res = await fetch('/api/customers/companies', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ id }),
      })
      if (res.ok) {
        setContacts(prev => prev.filter(c => c.id !== id))
        if (selectedId === id) closePanel()
      }
    } catch {}
  }

  function loadAllTasks() {
    setAllTasksLoading(true)
    fetch('/api/customers/tasks', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.ok) setAllTasks(d.data || []); setAllTasksLoading(false) })
      .catch(() => setAllTasksLoading(false))
    fetch('/api/customers/tasks?done=true', { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (d.ok) setCompletedTasks((d.data || []).filter((t: Task) => t.is_done)) })
      .catch(() => {})
  }

  async function createCompany() {
    if (!companyName.trim()) return
    setCompanyCreating(true)
    try {
      const res = await fetch('/api/customers/companies', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({
          displayName: companyName.trim(),
          primaryEmail: companyEmail.trim() || undefined,
          primaryPhone: companyPhone.trim() || undefined,
          websiteUrl: companyWebsite.trim() || undefined,
        }),
      })
      if (res.ok) {
        const d = await res.json().catch(() => null)
        const newCompanyId = d?.id || d?.data?.id
        // Link selected people to this company
        if (newCompanyId && companyLinkPeople.length > 0) {
          for (const personId of companyLinkPeople) {
            await fetch('/api/crm-company-links', {
              method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
              body: JSON.stringify({ personEntityId: personId, companyEntityId: newCompanyId }),
            }).catch(() => {})
          }
        }
        setCompanyName(''); setCompanyEmail(''); setCompanyPhone(''); setCompanyWebsite('')
        setCompanyLinkPeople([]); setCompanyLinkSearch(''); setShowCreateCompany(false); loadContacts()
      }
    } catch {}
    setCompanyCreating(false)
  }

  async function addReminder() {
    if (!remindDate || !remindMessage.trim() || !selectedContact) return
    setSavingReminder(true)
    try {
      const res = await fetch('/api/customers/reminders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ entityType: 'contact', entityId: selectedContact.id, message: remindMessage, remindAt: new Date(remindDate).toISOString() }),
      })
      const data = await res.json()
      if (data.ok) {
        setShowRemindForm(false)
        setRemindDate('')
        setRemindMessage('')
      }
    } catch {}
    setSavingReminder(false)
  }

  async function uploadAttachment(file: File) {
    if (!selectedContact || !file) return
    if (file.size > 10 * 1024 * 1024) {
      alert('File too large. Maximum size is 10MB.')
      return
    }
    setUploadingFile(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const res = await fetch(`/api/contacts/${selectedContact.id}/attachments`, {
        method: 'POST', credentials: 'include', body: formData,
      })
      const data = await res.json()
      if (data.ok && data.data) {
        setAttachments(prev => [data.data, ...prev])
      }
    } catch {}
    setUploadingFile(false)
  }

  async function deleteAttachment(attachmentId: string) {
    if (!selectedContact) return
    try {
      const res = await fetch(`/api/contacts/${selectedContact.id}/attachments?attachmentId=${attachmentId}`, {
        method: 'DELETE', credentials: 'include',
      })
      const data = await res.json()
      if (data.ok) {
        setAttachments(prev => prev.filter(a => a.id !== attachmentId))
      }
    } catch {}
  }

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const stageColors: Record<string, string> = {
    prospect: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    customer: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
    active: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  }

  return (
    <div className="flex flex-col md:flex-row h-[calc(100vh-52px)]">
      {/* Contact List — hidden on mobile when a contact is selected */}
      <div className={`flex-1 flex flex-col overflow-hidden ${selectedId ? 'hidden md:flex border-r' : ''}`}>
        {/* Header */}
        <div className="px-3 sm:px-6 py-3 sm:py-4 border-b">
          <div className="flex items-center justify-between mb-3">
            <h1 className="text-lg font-semibold">Contacts</h1>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => window.location.href = '/api/contacts/export'}>
                Export
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => {
                setShowScan(true)
                if (!stagesLoaded) {
                  setStagesLoaded(true)
                  fetch('/api/customers/business-profile', { credentials: 'include' }).then(r => r.json()).then(d => {
                    if (d.ok && d.data?.pipeline_stages) {
                      const ps = typeof d.data.pipeline_stages === 'string' ? JSON.parse(d.data.pipeline_stages) : d.data.pipeline_stages
                      setPipelineStages(ps.map((s: any) => s.name || s).filter(Boolean))
                    }
                    if (pipelineStages.length === 0) setPipelineStages(['New Lead', 'Contacted', 'Qualified', 'Proposal', 'Won', 'Lost'])
                  }).catch(() => setPipelineStages(['New Lead', 'Contacted', 'Qualified', 'Proposal', 'Won', 'Lost']))
                }
              }}>
                <Camera className="size-3.5 mr-1.5" /> Scan
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setShowImport(true)}>
                <Upload className="size-3.5 mr-1.5" /> Import
              </Button>
              {tab === 'companies' ? (
                <Button type="button" size="sm" onClick={() => { setShowCreateCompany(true); loadAllPeopleForLink() }}>
                  <Plus className="size-3.5 mr-1.5" /> Add Company
                </Button>
              ) : tab === 'people' ? (
                <Button type="button" size="sm" onClick={() => window.location.href = '/backend/customers/people/create'}>
                  <Plus className="size-3.5 mr-1.5" /> Add Contact
                </Button>
              ) : null}
            </div>
          </div>

          {/* Tabs */}
          <div className="flex gap-4 mb-3">
            {(['people', 'companies', 'tasks'] as const).map(t => (
              <button key={t} type="button" onClick={() => { setTab(t); closePanel(); if (t === 'tasks') loadAllTasks() }}
                className={`text-sm font-medium pb-1 border-b-2 transition ${
                  tab === t ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}>
                {t === 'people' ? 'People' : t === 'companies' ? 'Companies' : 'Tasks'}
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

          {/* Filter toggle */}
          {tab !== 'tasks' && (
            <div className="mt-2">
              <button type="button" onClick={() => {
                setShowFilters(!showFilters)
                if (!filterTagsLoaded) {
                  setFilterTagsLoaded(true)
                  fetch('/api/crm-contact-tags', { credentials: 'include' }).then(r => r.json())
                    .then(d => { if (d.ok) setAvailableFilterTags(d.data || []) }).catch(() => {})
                }
              }} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition">
                <Filter className="size-3" />
                {showFilters ? 'Hide Filters' : 'Filters'}
                {(filterTag || filterStage || filterEngagement) && (
                  <span className="size-1.5 rounded-full bg-blue-500" />
                )}
              </button>

              {showFilters && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <select value={filterTag} onChange={e => setFilterTag(e.target.value)}
                    className="h-7 text-xs rounded-md border bg-background px-2">
                    <option value="">All Tags</option>
                    {availableFilterTags.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                  <select value={filterStage} onChange={e => setFilterStage(e.target.value)}
                    className="h-7 text-xs rounded-md border bg-background px-2">
                    <option value="">All Stages</option>
                    {pipelineStages.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <select value={filterEngagement} onChange={e => setFilterEngagement(e.target.value as any)}
                    className="h-7 text-xs rounded-md border bg-background px-2">
                    <option value="">All Contacts</option>
                    <option value="hot">Hot</option>
                    <option value="warm">Warm</option>
                    <option value="cold">Cold</option>
                  </select>
                  {(filterTag || filterStage || filterEngagement) && (
                    <button type="button" onClick={() => { setFilterTag(''); setFilterStage(''); setFilterEngagement('') }}
                      className="h-7 text-xs text-muted-foreground hover:text-foreground px-2">
                      Clear
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Tasks Tab */}
        {tab === 'tasks' && (
          <div className="flex-1 overflow-y-auto p-4">
            <div className="flex gap-2 mb-4">
              <Input value={newTask} onChange={e => setNewTask(e.target.value)}
                placeholder="Add a task..." className="flex-1 h-9 text-sm"
                onKeyDown={e => { if (e.key === 'Enter' && newTask.trim()) { addTask(); } }} />
              <Input type="date" value={newTaskDue} onChange={e => setNewTaskDue(e.target.value)} className="w-32 h-9 text-xs" />
              <Button type="button" size="sm" onClick={addTask} disabled={savingTask || !newTask.trim()}>
                <Plus className="size-3 mr-1" /> Add
              </Button>
            </div>
            {allTasksLoading ? (
              <div className="text-center py-8 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin mx-auto mb-2" /> Loading tasks...</div>
            ) : allTasks.length === 0 ? (
              <p className="text-center text-sm text-muted-foreground py-8">No tasks yet. Add one above.</p>
            ) : (
              <div className="space-y-1">
                {allTasks.map(task => (
                  <div key={task.id} className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg border hover:bg-muted/30 transition group">
                    <button type="button" onClick={() => toggleTask(task)} className="shrink-0">
                      {task.is_done ? <CheckCircle2 className="size-4 text-emerald-500" /> : <Circle className="size-4 text-muted-foreground/40 group-hover:text-accent transition" />}
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm ${task.is_done ? 'line-through text-muted-foreground' : ''}`}>{task.title}</p>
                      {task.due_date && (
                        <p className={`text-[10px] ${new Date(task.due_date) < new Date() && !task.is_done ? 'text-red-500 font-medium' : 'text-muted-foreground'}`}>
                          {new Date(task.due_date) < new Date() && !task.is_done ? 'Overdue — ' : 'Due '}{new Date(task.due_date).toLocaleDateString()}
                        </p>
                      )}
                    </div>
                    <button type="button" onClick={() => deleteTask(task.id)}
                      className="p-1.5 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition shrink-0" title="Delete">
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Completed tasks - collapsible */}
            {completedTasks.length > 0 && (
              <div className="mt-4">
                <button type="button" onClick={() => setCompletedOpen(!completedOpen)}
                  className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition w-full">
                  <ChevronDown className={`size-3.5 transition-transform ${completedOpen ? 'rotate-180' : ''}`} />
                  <span className="font-medium text-xs">Completed ({completedTasks.length})</span>
                  <div className="flex-1 h-px bg-border ml-2" />
                </button>
                {completedOpen && (
                  <div className="space-y-1 mt-2">
                    {completedTasks.map(task => (
                      <div key={task.id} className="flex items-start gap-2.5 px-3 py-2 rounded-lg hover:bg-muted/30 transition group opacity-60">
                        <button type="button" onClick={() => toggleTask(task)} className="shrink-0 mt-0.5">
                          <CheckCircle2 className="size-4 text-emerald-500" />
                        </button>
                        <p className="flex-1 text-sm line-through text-muted-foreground">{task.title}</p>
                        <button type="button" onClick={() => deleteTask(task.id)}
                          className="p-1 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition" title="Delete">
                          <Trash2 className="size-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Contact List */}
        {tab !== 'tasks' && <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-6 text-sm text-muted-foreground">Loading...</div>
          ) : contacts.length === 0 ? (
            <div className="p-6 text-center">
              <p className="text-sm text-muted-foreground">{search ? `No ${tab === 'companies' ? 'companies' : 'contacts'} match your search.` : `No ${tab === 'companies' ? 'companies' : 'contacts'} yet.`}</p>
              {!search && tab === 'companies' && (
                <Button type="button" size="sm" className="mt-3" onClick={() => { setShowCreateCompany(true); loadAllPeopleForLink() }}>
                  <Plus className="size-3.5 mr-1.5" /> Add your first company
                </Button>
              )}
              {!search && tab === 'people' && (
                <Button type="button" size="sm" className="mt-3" onClick={() => window.location.href = '/backend/customers/people/create'}>
                  <Plus className="size-3.5 mr-1.5" /> Add your first contact
                </Button>
              )}
            </div>
          ) : (
            <div>
              {contacts.map(contact => (
                <div key={contact.id}
                  className={`w-full text-left px-6 py-3 border-b hover:bg-muted/50 transition flex items-center gap-3 cursor-pointer group ${
                    selectedId === contact.id ? 'bg-muted/70' : ''
                  }`}
                  onClick={() => selectContact(contact)}>
                  <div className="w-9 h-9 rounded-full bg-accent/10 flex items-center justify-center text-accent text-xs font-semibold shrink-0">
                    {tab === 'companies' ? <Building2 className="size-4" /> : contact.display_name?.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase() || '?'}
                  </div>
                  <div className="flex-1 min-w-0">
                    {editCompanyId === contact.id ? (
                      <div className="flex gap-1.5" onClick={e => e.stopPropagation()}>
                        <Input value={editCompanyName} onChange={e => setEditCompanyName(e.target.value)}
                          className="h-7 text-sm flex-1" autoFocus
                          onKeyDown={e => { if (e.key === 'Enter') updateCompany(contact.id, editCompanyName); if (e.key === 'Escape') setEditCompanyId(null) }} />
                        <Button type="button" size="sm" className="h-7 px-2" onClick={() => updateCompany(contact.id, editCompanyName)}>
                          <Check className="size-3" />
                        </Button>
                      </div>
                    ) : (
                      <>
                        <p className="text-sm font-medium truncate">{contact.display_name}</p>
                        <p className="text-xs text-muted-foreground truncate">{contact.primary_email || contact.primary_phone || 'No contact info'}</p>
                      </>
                    )}
                  </div>
                  {contact.lifecycle_stage && editCompanyId !== contact.id && (
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${stageColors[contact.lifecycle_stage] || 'bg-muted text-muted-foreground'}`}>
                      {contact.lifecycle_stage}
                    </span>
                  )}
                  {tab === 'companies' && editCompanyId !== contact.id && (
                    <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition shrink-0" onClick={e => e.stopPropagation()}>
                      <button type="button" onClick={() => { setEditCompanyId(contact.id); setEditCompanyName(contact.display_name) }}
                        className="p-1.5 text-muted-foreground hover:text-foreground" title="Edit"><Pencil className="size-3.5" /></button>
                      <button type="button" onClick={() => deleteCompany(contact.id, contact.display_name)}
                        className="p-1.5 text-muted-foreground hover:text-destructive" title="Delete"><Trash2 className="size-3.5" /></button>
                    </div>
                  )}
                  {tab === 'people' && (
                    <div className="flex items-center gap-0.5 shrink-0" onClick={e => e.stopPropagation()}>
                      <span role="link" tabIndex={0}
                        onClick={() => window.location.href = `/backend/customers/people/${contact.id}`}
                        className="p-1 text-accent hover:text-accent/80 cursor-pointer" title="View full profile">
                        <ExternalLink className="size-3" />
                      </span>
                      <button type="button" onClick={() => deleteContact(contact.id, contact.display_name)}
                        className="p-1 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition" title="Delete">
                        <Trash2 className="size-3" />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>}
      </div>

      {/* Create Company Modal */}
      {showCreateCompany && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-background rounded-xl border shadow-2xl w-full max-w-md mx-4 p-5 max-h-[85vh] overflow-y-auto">
            <h2 className="text-sm font-semibold mb-4">Add Company</h2>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Company Name *</label>
                <Input value={companyName} onChange={e => setCompanyName(e.target.value)}
                  placeholder="Acme Inc." className="text-sm" autoFocus />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Email</label>
                  <Input type="email" value={companyEmail} onChange={e => setCompanyEmail(e.target.value)}
                    placeholder="info@acme.com" className="text-sm" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Phone</label>
                  <Input value={companyPhone} onChange={e => setCompanyPhone(e.target.value)}
                    placeholder="+1 555-0100" className="text-sm" />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Website</label>
                <Input value={companyWebsite} onChange={e => setCompanyWebsite(e.target.value)}
                  placeholder="https://acme.com" className="text-sm" />
              </div>

              {/* Link People */}
              <div className="border-t pt-3">
                <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Link People (optional)</label>
                {companyLinkPeople.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {companyLinkPeople.map(pId => {
                      const person = allPeopleForLink.find(p => p.id === pId)
                      return person ? (
                        <span key={pId} className="inline-flex items-center gap-1 bg-accent/10 text-accent text-xs px-2 py-0.5 rounded-full">
                          {person.display_name}
                          <button type="button" onClick={() => setCompanyLinkPeople(prev => prev.filter(id => id !== pId))}
                            className="hover:text-destructive"><X className="size-2.5" /></button>
                        </span>
                      ) : null
                    })}
                  </div>
                )}
                <div className="relative">
                  <Input value={companyLinkSearch}
                    onChange={e => { setCompanyLinkSearch(e.target.value); setCompanyLinkDropdown(true); loadAllPeopleForLink() }}
                    onFocus={() => { setCompanyLinkDropdown(true); loadAllPeopleForLink() }}
                    onBlur={() => setTimeout(() => setCompanyLinkDropdown(false), 200)}
                    placeholder="Search contacts to link..." className="h-8 text-xs" />
                  {companyLinkDropdown && (
                    <div className="absolute z-20 bottom-full left-0 right-0 mb-1 bg-background border rounded-lg shadow-lg max-h-48 overflow-y-auto">
                      {allPeopleForLink.length === 0 ? (
                        <p className="text-xs text-muted-foreground text-center py-3"><Loader2 className="size-3 animate-spin inline mr-1" />Loading contacts...</p>
                      ) : (
                        <>
                          {allPeopleForLink
                            .filter(p => !companyLinkPeople.includes(p.id))
                            .filter(p => !companyLinkSearch.trim() || p.display_name.toLowerCase().includes(companyLinkSearch.toLowerCase()) || (p.primary_email || '').toLowerCase().includes(companyLinkSearch.toLowerCase()))
                            .slice(0, 10)
                            .map(p => (
                              <button key={p.id} type="button"
                                className="w-full text-left px-3 py-2.5 hover:bg-muted/50 flex items-center gap-2.5 text-xs border-b last:border-0"
                                onClick={() => { setCompanyLinkPeople(prev => [...prev, p.id]); setCompanyLinkSearch(''); setCompanyLinkDropdown(false) }}>
                                <div className="size-7 rounded-full bg-accent/10 flex items-center justify-center text-[10px] font-bold text-accent shrink-0">
                                  {p.display_name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase()}
                                </div>
                                <div className="min-w-0">
                                  <p className="font-medium truncate">{p.display_name}</p>
                                  {p.primary_email && <p className="text-[10px] text-muted-foreground truncate">{p.primary_email}</p>}
                                </div>
                              </button>
                            ))
                          }
                          {allPeopleForLink.filter(p => !companyLinkPeople.includes(p.id)).filter(p => !companyLinkSearch.trim() || p.display_name.toLowerCase().includes(companyLinkSearch.toLowerCase())).length === 0 && (
                            <p className="text-xs text-muted-foreground text-center py-2">No matching contacts</p>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <Button type="button" variant="outline" size="sm" onClick={() => { setShowCreateCompany(false); setCompanyName(''); setCompanyEmail(''); setCompanyPhone(''); setCompanyWebsite(''); setCompanyLinkPeople([]); setCompanyLinkSearch('') }}>Cancel</Button>
              <Button type="button" size="sm" onClick={createCompany} disabled={companyCreating || !companyName.trim()}>
                {companyCreating ? <Loader2 className="size-3.5 mr-1.5 animate-spin" /> : <Plus className="size-3.5 mr-1.5" />}
                {companyCreating ? 'Creating...' : 'Create Company'}
              </Button>
            </div>
          </div>
        </div>
      )}

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
                  {/* CSV File Upload */}
                  <div className="rounded-lg border hover:border-accent/50 transition p-4 text-center">
                    <input
                      type="file"
                      accept=".csv,.txt,.tsv"
                      className="hidden"
                      id="csv-upload"
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (!file) return
                        const reader = new FileReader()
                        reader.onload = (ev) => {
                          const text = ev.target?.result
                          if (typeof text === 'string') {
                            // If it has a header row, skip it
                            const lines = text.trim().split('\n')
                            const firstLine = lines[0]?.toLowerCase() || ''
                            const hasHeader = firstLine.includes('name') || firstLine.includes('email') || firstLine.includes('first')
                            setImportData(hasHeader ? lines.slice(1).join('\n') : text)
                          }
                        }
                        reader.readAsText(file)
                        e.target.value = ''
                      }}
                    />
                    <label htmlFor="csv-upload" className="cursor-pointer">
                      <Upload className="size-5 mx-auto mb-1.5 text-muted-foreground" />
                      <p className="text-sm font-medium">Upload CSV file</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">Supports .csv, .tsv, .txt</p>
                    </label>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex-1 border-t" />
                    <span className="text-[10px] text-muted-foreground uppercase">or paste manually</span>
                    <div className="flex-1 border-t" />
                  </div>
                  <textarea value={importData} onChange={e => setImportData(e.target.value)}
                    placeholder="Jane Doe, jane@example.com, +1-555-1234&#10;John Smith, john@company.com&#10;Sarah Chen, sarah@startup.io"
                    className="w-full rounded-md border bg-card px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring h-28 font-mono" />
                  <div className="flex justify-between items-center">
                    <p className="text-xs text-muted-foreground">{importData.trim() ? importData.trim().split('\n').filter(l => l.trim()).length + ' contacts' : 'No data'}</p>
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

      {/* Scan from Photo Modal */}
      {showScan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-background rounded-xl border shadow-2xl w-full max-w-xl mx-4 max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between px-5 py-3 border-b shrink-0">
              <div>
                <h2 className="text-sm font-semibold">Import from Photo</h2>
                <p className="text-xs text-muted-foreground">Business cards, sign-in sheets, or any document with contact info.</p>
              </div>
              <IconButton type="button" variant="ghost" size="sm" onClick={() => { setShowScan(false); setScanResults(null); setScanFile(null); setScanTags(''); setScanStage('') }} aria-label="Close">
                <X className="size-4" />
              </IconButton>
            </div>
            <div className="p-5 flex-1 overflow-y-auto">
              {scanResults ? (
                <div className="space-y-3">
                  <p className="text-sm font-medium">{scanResults.length} contact{scanResults.length !== 1 ? 's' : ''} extracted</p>
                  <div className="space-y-3">
                    {scanResults.map((c, i) => (
                      <div key={i} className="border rounded-lg p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] text-muted-foreground font-medium">Contact {i + 1}</span>
                          <button type="button" onClick={() => setScanResults(prev => prev!.filter((_, j) => j !== i))}
                            className="text-muted-foreground hover:text-destructive"><X className="size-3" /></button>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <Input value={c.firstName || ''} onChange={e => { const u = [...scanResults!]; u[i] = { ...c, firstName: e.target.value }; setScanResults(u) }}
                            placeholder="First name" className="h-7 text-xs" />
                          <Input value={c.lastName || ''} onChange={e => { const u = [...scanResults!]; u[i] = { ...c, lastName: e.target.value }; setScanResults(u) }}
                            placeholder="Last name" className="h-7 text-xs" />
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <Input value={c.email || ''} onChange={e => { const u = [...scanResults!]; u[i] = { ...c, email: e.target.value }; setScanResults(u) }}
                            placeholder="Email" className="h-7 text-xs" />
                          <Input value={c.phone || ''} onChange={e => { const u = [...scanResults!]; u[i] = { ...c, phone: e.target.value }; setScanResults(u) }}
                            placeholder="Phone" className="h-7 text-xs" />
                        </div>
                        <Input value={c.company || ''} onChange={e => { const u = [...scanResults!]; u[i] = { ...c, company: e.target.value }; setScanResults(u) }}
                          placeholder="Company" className="h-7 text-xs" />
                      </div>
                    ))}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t">
                    <div>
                      <label className="text-xs font-medium text-muted-foreground mb-1 block">Pipeline Stage</label>
                      <select value={scanStage} onChange={e => setScanStage(e.target.value)}
                        className="w-full h-8 rounded-lg border bg-background px-2.5 text-sm">
                        <option value="">No stage</option>
                        {pipelineStages.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground mb-1 block">Tags</label>
                      <Input value={scanTags} onChange={e => setScanTags(e.target.value)} placeholder="e.g. prospect, open-house" className="h-8 text-sm" />
                    </div>
                  </div>
                  <div className="flex justify-between pt-3">
                    <Button type="button" variant="outline" size="sm" onClick={() => { setScanResults(null); setScanFile(null) }}>Scan Another</Button>
                    <Button type="button" size="sm" onClick={async () => {
                      setScanSaving(true)
                      try {
                        const payload = { contacts: scanResults, tags: scanTags, lifecycleStage: scanStage || undefined }
                        const res = await fetch('/api/contacts/scan', {
                          method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
                          body: JSON.stringify(payload),
                        })
                        const d = await res.json()
                        if (d.ok) {
                          setShowScan(false); setScanResults(null); setScanFile(null); setScanTags(''); setScanStage('')
                          loadContacts()
                        } else { alert(d.error || 'Failed to save') }
                      } catch { alert('Failed to save contacts') }
                      setScanSaving(false)
                    }} disabled={scanSaving || scanResults.length === 0}>
                      {scanSaving ? <><Loader2 className="size-3.5 mr-1.5 animate-spin" /> Adding...</> : <><Plus className="size-3.5 mr-1.5" /> Add {scanResults.length} Contact{scanResults.length !== 1 ? 's' : ''}</>}
                    </Button>
                  </div>
                </div>
              ) : (
                <div
                  className={`flex flex-col items-center justify-center border-2 border-dashed rounded-xl p-10 cursor-pointer transition ${scanning ? 'border-accent/40 bg-accent/5' : 'hover:border-accent/40 hover:bg-accent/5'}`}
                  onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('border-accent', 'bg-accent/5') }}
                  onDragLeave={e => { e.currentTarget.classList.remove('border-accent', 'bg-accent/5') }}
                  onDrop={async e => {
                    e.preventDefault(); e.currentTarget.classList.remove('border-accent', 'bg-accent/5')
                    const file = e.dataTransfer.files?.[0]
                    if (!file || !file.type.startsWith('image/')) return
                    setScanFile(file); setScanning(true)
                    try {
                      const fd = new FormData(); fd.append('image', file)
                      const res = await fetch('/api/contacts/scan', { method: 'POST', credentials: 'include', body: fd })
                      const d = await res.json()
                      if (d.ok && d.data?.contacts) setScanResults(d.data.contacts)
                      else alert(d.error || 'Could not extract contacts')
                    } catch { alert('Failed to process image') }
                    setScanning(false)
                  }}
                  onClick={() => { if (!scanning) (document.getElementById('scan-upload') as HTMLInputElement)?.click() }}
                >
                  <Camera className="size-10 text-muted-foreground/30 mb-3" />
                  <p className="text-sm font-medium">{scanning ? 'Extracting contacts...' : 'Drop a photo here or click to upload'}</p>
                  <p className="text-xs text-muted-foreground mt-1">Business card, sign-in sheet, or any document with contact info</p>
                  <p className="text-[10px] text-muted-foreground/60 mt-0.5">JPG, PNG, HEIC</p>
                  <input id="scan-upload" type="file" accept="image/*" capture="environment" className="hidden" disabled={scanning}
                    onChange={async (e) => {
                      const file = e.target.files?.[0]
                      if (!file) return
                      setScanFile(file); setScanning(true)
                      try {
                        const fd = new FormData(); fd.append('image', file)
                        const res = await fetch('/api/contacts/scan', { method: 'POST', credentials: 'include', body: fd })
                        const d = await res.json()
                        if (d.ok && d.data?.contacts) setScanResults(d.data.contacts)
                        else alert(d.error || 'Could not extract contacts')
                      } catch { alert('Failed to process image') }
                      setScanning(false); e.target.value = ''
                    }} />
                  {scanning && <Loader2 className="size-5 animate-spin text-accent mt-4" />}
                </div>
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

      {/* Company Side Panel */}
      {selectedContact && tab === 'companies' && (
        <div className="w-full md:w-full md:w-[400px] shrink-0 flex flex-col overflow-hidden md:border-l">
          <div className="px-5 py-4 border-b">
            <div className="flex items-start justify-between mb-2">
              <div className="flex items-center gap-3">
                <div className="size-10 rounded-lg bg-accent/10 flex items-center justify-center"><Building2 className="size-5 text-accent" /></div>
                <div>
                  <h2 className="text-lg font-semibold">{selectedContact.display_name}</h2>
                  {selectedContact.primary_email && <p className="text-xs text-muted-foreground">{selectedContact.primary_email}</p>}
                </div>
              </div>
              <IconButton type="button" variant="ghost" size="sm" onClick={closePanel} aria-label="Close"><X className="size-4" /></IconButton>
            </div>
            {selectedContact.primary_phone && <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1"><Phone className="size-3" /> {selectedContact.primary_phone}</p>}
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            {/* People at this company */}
            <div className="mb-6">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">People ({companyPeople.length})</h3>
              </div>

              {companyPeopleLoading ? (
                <p className="text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin inline mr-1" /> Loading...</p>
              ) : companyPeople.length === 0 ? (
                <p className="text-xs text-muted-foreground">No people linked to this company yet.</p>
              ) : (
                <div className="space-y-2">
                  {companyPeople.map(p => (
                    <div key={p.entityId} className="flex items-center gap-2.5 px-3 py-2 rounded-lg border group">
                      <div className="size-7 rounded-full bg-accent/10 flex items-center justify-center text-[10px] font-bold text-accent shrink-0">
                        {(p.display_name || '?')[0].toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{p.display_name}</p>
                        <p className="text-[10px] text-muted-foreground truncate">{[p.job_title, p.primary_email].filter(Boolean).join(' · ')}</p>
                      </div>
                      <button type="button" onClick={() => linkPersonToCompany(p.entityId, null)}
                        className="text-[10px] text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition">Unlink</button>
                    </div>
                  ))}
                </div>
              )}

              {/* Link existing person */}
              <div className="mt-3 relative">
                <Input value={linkPersonSearch}
                  onChange={e => { setLinkPersonSearch(e.target.value); setLinkPersonDropdown(true); loadAllPeopleForLink() }}
                  onFocus={() => { setLinkPersonDropdown(true); loadAllPeopleForLink() }}
                  onBlur={() => setTimeout(() => setLinkPersonDropdown(false), 200)}
                  placeholder="Search contacts to link..." className="h-8 text-xs" />
                {linkPersonDropdown && (
                  <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-background border rounded-lg shadow-lg max-h-48 overflow-y-auto">
                    {allPeopleForLink
                      .filter(p => !companyPeople.some(cp => cp.entityId === p.id))
                      .filter(p => !linkPersonSearch.trim() || p.display_name.toLowerCase().includes(linkPersonSearch.toLowerCase()) || (p.primary_email || '').toLowerCase().includes(linkPersonSearch.toLowerCase()))
                      .slice(0, 10)
                      .map(p => (
                        <button key={p.id} type="button"
                          className="w-full text-left px-3 py-2.5 hover:bg-muted/50 flex items-center gap-2.5 text-xs border-b last:border-0"
                          onClick={() => { linkPersonToCompany(p.id, selectedContact!.id); setLinkPersonDropdown(false); setLinkPersonSearch('') }}>
                          <div className="size-7 rounded-full bg-accent/10 flex items-center justify-center text-[10px] font-bold text-accent shrink-0">
                            {p.display_name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase()}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="font-medium truncate">{p.display_name}</p>
                            {p.primary_email && <p className="text-[10px] text-muted-foreground truncate">{p.primary_email}</p>}
                          </div>
                        </button>
                      ))
                    }
                    {allPeopleForLink.filter(p => !companyPeople.some(cp => cp.entityId === p.id)).filter(p => !linkPersonSearch.trim() || p.display_name.toLowerCase().includes(linkPersonSearch.toLowerCase())).length === 0 && (
                      <p className="text-xs text-muted-foreground text-center py-3">No contacts found</p>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Notes for company */}
            <div>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Notes</h3>
              <div className="flex gap-2 mb-3">
                <Input value={newNote} onChange={e => setNewNote(e.target.value)}
                  placeholder="Add a note..." className="flex-1 h-8 text-xs"
                  onKeyDown={e => { if (e.key === 'Enter') addNote() }} />
                <Button type="button" size="sm" className="h-8" onClick={addNote} disabled={!newNote.trim()}>
                  <Plus className="size-3" />
                </Button>
              </div>
              {notes.length > 0 && (
                <div className="space-y-2">
                  {notes.map(note => (
                    <div key={note.id} className="bg-muted/30 rounded-lg px-3 py-2">
                      <p className="text-xs whitespace-pre-wrap">{note.content}</p>
                      <p className="text-[10px] text-muted-foreground mt-1">{new Date(note.created_at).toLocaleDateString()}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Person Side Panel */}
      {selectedContact && tab !== 'companies' && (
        <div className="w-full md:w-[400px] shrink-0 flex flex-col overflow-hidden">
          {/* Panel Header — name, role, company */}
          <div className="px-5 py-4 border-b">
            <div className="flex items-start justify-between mb-2">
              <div>
                <h2 className="text-lg font-semibold">{selectedContact.display_name}</h2>
                {contactPerson?.job_title && (
                  <p className="text-sm text-foreground/70">
                    {contactPerson.job_title}
                    {contactPerson.company_name && <span> at <strong>{contactPerson.company_name}</strong></span>}
                  </p>
                )}
                {!contactPerson?.job_title && contactPerson?.company_name && (
                  <p className="text-sm text-foreground/70">{contactPerson.company_name}</p>
                )}
              </div>
              <IconButton type="button" variant="ghost" size="sm" onClick={closePanel} aria-label="Close">
                <X className="size-4" />
              </IconButton>
            </div>
            {/* Contact info row */}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {selectedContact.primary_email && (
                <span className="flex items-center gap-1"><Mail className="size-3" /> {selectedContact.primary_email}</span>
              )}
              {selectedContact.primary_phone && (
                <span className="flex items-center gap-1"><Phone className="size-3" /> {selectedContact.primary_phone}</span>
              )}
              {selectedContact.lifecycle_stage && (
                <span className="flex items-center gap-1"><Tag className="size-3" /> {selectedContact.lifecycle_stage}</span>
              )}
            </div>
            {/* Colleagues at same company */}
            {companyColleagues.length > 0 && contactPerson?.company_name && (
              <div className="mt-3 pt-3 border-t">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">
                  Also at {contactPerson.company_name}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {companyColleagues.map(c => (
                    <button key={c.id} type="button"
                      onClick={() => { const match = contacts.find(x => x.id === c.id); if (match) selectContact(match) }}
                      className="inline-flex items-center gap-1.5 text-xs bg-muted/50 hover:bg-muted rounded-full px-2 py-1 transition">
                      <div className="w-4 h-4 rounded-full bg-accent/10 flex items-center justify-center text-accent text-[8px] font-semibold">
                        {c.display_name?.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase() || '?'}
                      </div>
                      {c.display_name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* AI Relationship Summary */}
          <div className="px-5 py-3 border-b">
            {contactSummary ? (
              <div className="rounded-lg border border-violet-200 dark:border-violet-800/50 bg-gradient-to-br from-violet-50/80 via-fuchsia-50/40 to-transparent dark:from-violet-950/30 dark:via-fuchsia-950/20 dark:to-transparent p-3">
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-1.5">
                    <Sparkles className="size-3.5 text-violet-500 dark:text-violet-400" />
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-violet-600 dark:text-violet-400">
                      {summaryIsAi ? 'AI Summary' : 'Summary'}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (!selectedContact || loadingSummary) return
                      setLoadingSummary(true)
                      fetch(`/api/contacts/${selectedContact.id}/summary`, { method: 'POST', credentials: 'include' })
                        .then(r => r.json()).then(d => {
                          if (d.ok && d.data) {
                            setContactSummary(d.data.summary)
                            setSummaryIsAi(d.data.isAi || false)
                          }
                        }).catch(() => {})
                        .finally(() => setLoadingSummary(false))
                    }}
                    disabled={loadingSummary}
                    className="text-violet-400 hover:text-violet-600 dark:hover:text-violet-300 transition disabled:opacity-50"
                    title="Refresh summary"
                  >
                    <RefreshCw className={`size-3 ${loadingSummary ? 'animate-spin' : ''}`} />
                  </button>
                </div>
                {loadingSummary ? (
                  <div className="space-y-1.5">
                    <div className="h-3 bg-violet-200/50 dark:bg-violet-800/30 rounded animate-pulse w-full" />
                    <div className="h-3 bg-violet-200/50 dark:bg-violet-800/30 rounded animate-pulse w-4/5" />
                  </div>
                ) : (
                  <p className="text-xs leading-relaxed text-violet-900/80 dark:text-violet-200/80">{contactSummary}</p>
                )}
              </div>
            ) : (
              <Button
                type="button"
                size="sm"
                className="w-full bg-accent text-accent-foreground hover:bg-accent/90"
                onClick={() => {
                  if (!selectedContact || loadingSummary) return
                  setLoadingSummary(true)
                  fetch(`/api/contacts/${selectedContact.id}/summary`, { method: 'POST', credentials: 'include' })
                    .then(r => r.json()).then(d => {
                      if (d.ok && d.data) {
                        setContactSummary(d.data.summary)
                        setSummaryIsAi(d.data.isAi || false)
                      }
                    }).catch(() => {})
                    .finally(() => setLoadingSummary(false))
                }}
                disabled={loadingSummary}
              >
                {loadingSummary ? (
                  <><Loader2 className="size-3.5 mr-1.5 animate-spin" /> Generating Summary...</>
                ) : (
                  <><Sparkles className="size-3.5 mr-1.5" /> Generate AI Summary</>
                )}
              </Button>
            )}
          </div>

          {/* Quick Actions */}
          <div className="px-5 py-3 border-b flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setShowEmailModal(true)}
              disabled={!selectedContact?.primary_email}>
              <Mail className="size-3.5 mr-1.5" /> Email
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setShowDealModal(true)}
              title="Create a deal/opportunity for this contact">
              <DollarSign className="size-3.5 mr-1.5" /> New Deal
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
            {(['timeline', 'details', 'notes', 'tasks'] as const).map(t => (
              <button key={t} type="button" onClick={() => setPanelTab(t)}
                className={`text-xs font-medium px-3 py-2.5 border-b-2 transition capitalize ${
                  panelTab === t ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}>{t}</button>
            ))}
          </div>

          {/* Panel Content */}
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {/* Timeline Tab */}
            {panelTab === 'timeline' && (
              <div className="space-y-1">
                {timelineLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    <span className="ml-2 text-sm text-muted-foreground">Loading timeline...</span>
                  </div>
                ) : timeline.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-8">No activity yet.</p>
                ) : (
                  <div className="relative">
                    {/* Vertical line */}
                    <div className="absolute left-[15px] top-2 bottom-2 w-px bg-border" />
                    {timeline.map((event, index) => (
                      <div key={`${event.type}-${event.timestamp}-${index}`} className="relative flex gap-3 py-2.5 group">
                        <div className={`relative z-10 w-[31px] h-[31px] rounded-full flex items-center justify-center shrink-0 ${getTimelineEventColor(event.type)}`}>
                          <TimelineIcon name={event.icon} />
                        </div>
                        <div className="flex-1 min-w-0 pt-0.5">
                          <p className="text-sm font-medium leading-tight">{event.title}</p>
                          {event.description && (
                            <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{event.description}</p>
                          )}
                          <p className="text-[10px] text-muted-foreground/70 mt-1">{formatRelativeTime(event.timestamp)}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Details Tab */}
            {panelTab === 'details' && (
              <div className="space-y-3">
                <DetailRow icon={Mail} label="Email" value={selectedContact.primary_email} />
                <DetailRow icon={Phone} label="Phone" value={selectedContact.primary_phone} />
                <DetailRow icon={Tag} label="Source" value={selectedContact.source} />
                <div className="flex items-center gap-2">
                  <Tag className="size-4 text-muted-foreground shrink-0" />
                  <div className="flex-1">
                    <p className="text-[11px] text-muted-foreground">Stage</p>
                    <select
                      value={selectedContact.lifecycle_stage || ''}
                      onChange={async (e) => {
                        const newStage = e.target.value
                        try {
                          await fetch(`/api/customers/people`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            credentials: 'include',
                            body: JSON.stringify({ id: selectedContact.id, lifecycleStage: newStage }),
                          })
                          setContacts(prev => prev.map(c => c.id === selectedContact.id ? { ...c, lifecycle_stage: newStage } : c))
                          selectContact({ ...selectedContact, lifecycle_stage: newStage })
                        } catch {}
                      }}
                      className="h-7 text-sm rounded-md border border-input bg-background px-2 w-full max-w-[200px]"
                    >
                      <option value="">No stage</option>
                      {(pipelineStages.length > 0 ? pipelineStages : ['New Lead', 'Contacted', 'Qualified', 'Proposal', 'Won', 'Lost']).map(s => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                      {selectedContact.lifecycle_stage && !pipelineStages.includes(selectedContact.lifecycle_stage) && !['New Lead', 'Contacted', 'Qualified', 'Proposal', 'Won', 'Lost'].includes(selectedContact.lifecycle_stage) && (
                        <option value={selectedContact.lifecycle_stage}>{selectedContact.lifecycle_stage}</option>
                      )}
                    </select>
                  </div>
                </div>

                {/* Company link */}
                <div className="flex items-center gap-2">
                  <Building2 className="size-4 text-muted-foreground shrink-0" />
                  <div className="flex-1">
                    <p className="text-[11px] text-muted-foreground">Company</p>
                    {personCompany ? (
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium truncate max-w-[180px]">{personCompany.displayName}</span>
                        <button type="button" onClick={() => linkPersonToCompany(selectedContact!.id, null)}
                          className="text-muted-foreground hover:text-destructive shrink-0" title="Remove company">
                          <X className="size-3" />
                        </button>
                      </div>
                    ) : (
                      <div className="relative">
                        <Input value={linkCompanySearch}
                          onChange={e => { setLinkCompanySearch(e.target.value); setLinkCompanyDropdown(true); loadAllCompaniesForLink() }}
                          onFocus={() => { setLinkCompanyDropdown(true); loadAllCompaniesForLink() }}
                          onBlur={() => setTimeout(() => setLinkCompanyDropdown(false), 200)}
                          placeholder="Search companies..." className="h-7 text-xs" />
                        {linkCompanyDropdown && (
                          <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-background border rounded-lg shadow-lg max-h-40 overflow-y-auto">
                            {allCompaniesForLink
                              .filter(c => !linkCompanySearch.trim() || c.display_name.toLowerCase().includes(linkCompanySearch.toLowerCase()))
                              .slice(0, 8)
                              .map(c => (
                                <button key={c.id} type="button"
                                  className="w-full text-left px-3 py-2.5 hover:bg-muted/50 flex items-center gap-2.5 text-xs border-b last:border-0"
                                  onClick={() => linkPersonToCompany(selectedContact!.id, c.id)}>
                                  <Building2 className="size-4 text-muted-foreground shrink-0" />
                                  <span className="font-medium">{c.display_name}</span>
                                </button>
                              ))
                            }
                            {allCompaniesForLink.filter(c => !linkCompanySearch.trim() || c.display_name.toLowerCase().includes(linkCompanySearch.toLowerCase())).length === 0 && (
                              <p className="text-xs text-muted-foreground text-center py-2">No companies found</p>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Flame className="size-4 text-muted-foreground shrink-0" />
                  <div className="flex-1">
                    <p className="text-[11px] text-muted-foreground">Engagement</p>
                    <div className="flex items-center gap-2">
                      <span className={`text-sm font-semibold tabular-nums ${
                        engagementScore >= 20 ? 'text-emerald-600 dark:text-emerald-400' :
                        engagementScore >= 5 ? 'text-amber-600 dark:text-amber-400' :
                        'text-muted-foreground'
                      }`}>{engagementScore}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {engagementScore >= 20 ? 'Hot' : engagementScore >= 5 ? 'Warm' : 'Cold'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Remind Me */}
                <div className="pt-3 border-t">
                  {!showRemindForm ? (
                    <Button type="button" variant="outline" size="sm" onClick={() => setShowRemindForm(true)} className="w-full">
                      <Bell className="size-3.5 mr-1.5" /> Remind Me
                    </Button>
                  ) : (
                    <div className="space-y-2 rounded-lg border p-3">
                      <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block">Set Reminder</label>
                      <input
                        type="datetime-local"
                        value={remindDate}
                        onChange={e => setRemindDate(e.target.value)}
                        min={new Date().toISOString().slice(0, 16)}
                        className="w-full rounded-md border bg-card px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                      <Input
                        value={remindMessage}
                        onChange={e => setRemindMessage(e.target.value)}
                        placeholder="Follow up with this contact..."
                        className="h-8 text-sm"
                        onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) addReminder() }}
                      />
                      <div className="flex gap-1.5">
                        <Button type="button" size="sm" onClick={addReminder}
                          disabled={savingReminder || !remindDate || !remindMessage.trim()} className="flex-1 h-7 text-xs">
                          {savingReminder ? <Loader2 className="size-3 animate-spin mr-1" /> : <Bell className="size-3 mr-1" />} Save
                        </Button>
                        <Button type="button" size="sm" variant="outline" onClick={() => { setShowRemindForm(false); setRemindDate(''); setRemindMessage('') }} className="h-7 text-xs px-2">
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </div>

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

                {/* Files */}
                <div className="pt-3 border-t">
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Files</label>
                    <label className="cursor-pointer">
                      <input type="file" className="hidden" onChange={e => {
                        const file = e.target.files?.[0]
                        if (file) uploadAttachment(file)
                        e.target.value = ''
                      }} />
                      <span className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
                        {uploadingFile ? <Loader2 className="size-3 animate-spin" /> : <Paperclip className="size-3" />}
                        {uploadingFile ? 'Uploading...' : 'Attach file'}
                      </span>
                    </label>
                  </div>
                  {attachments.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No files attached.</p>
                  ) : (
                    <div className="space-y-1.5">
                      {attachments.map(att => (
                        <div key={att.id} className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 group">
                          <FileText className="size-3.5 text-muted-foreground shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium truncate">{att.filename}</p>
                            <p className="text-[10px] text-muted-foreground">{formatFileSize(att.file_size)}</p>
                          </div>
                          <a href={att.file_url} download className="text-muted-foreground hover:text-foreground shrink-0">
                            <Download className="size-3.5" />
                          </a>
                          <button type="button" onClick={() => deleteAttachment(att.id)}
                            className="text-muted-foreground hover:text-destructive shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
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
                  <Input type="date" value={newTaskDue} onChange={e => setNewTaskDue(e.target.value)}
                    className="w-32 h-9 text-xs" title="Due date (optional)" />
                  <Button type="button" size="sm" onClick={addTask} disabled={savingTask || !newTask.trim()}>
                    <Plus className="size-3" />
                  </Button>
                </div>
                {tasks.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-4">No tasks yet.</p>
                ) : (
                  <div className="space-y-1 pt-2">
                    {tasks.map(task => (
                      <div key={task.id} className="flex items-start gap-2.5 px-2 py-2 rounded-md hover:bg-muted/50 transition group">
                        <button type="button" onClick={() => toggleTask(task)} className="shrink-0 mt-0.5">
                          {task.is_done
                            ? <CheckCircle2 className="size-4 text-emerald-500" />
                            : <Circle className="size-4 text-muted-foreground/40 group-hover:text-accent transition" />
                          }
                        </button>
                        {editingTaskId === task.id ? (
                          <div className="flex-1 flex gap-1.5">
                            <Input value={editingTaskTitle} onChange={e => setEditingTaskTitle(e.target.value)}
                              className="flex-1 h-7 text-sm" autoFocus
                              onKeyDown={e => { if (e.key === 'Enter') saveTaskEdit(task.id); if (e.key === 'Escape') setEditingTaskId(null) }} />
                            <Button type="button" size="sm" className="h-7 px-2" onClick={() => saveTaskEdit(task.id)}>
                              <Check className="size-3" />
                            </Button>
                          </div>
                        ) : (
                          <div className="flex-1 min-w-0">
                            <p className={`text-sm ${task.is_done ? 'line-through text-muted-foreground' : ''}`}>{task.title}</p>
                            {task.due_date && (
                              <p className={`text-[10px] ${new Date(task.due_date) < new Date() && !task.is_done ? 'text-red-500 font-medium' : 'text-muted-foreground'}`}>
                                {new Date(task.due_date) < new Date() && !task.is_done ? 'Overdue — ' : 'Due '}
                                {new Date(task.due_date).toLocaleDateString()}
                              </p>
                            )}
                          </div>
                        )}
                        {editingTaskId !== task.id && (
                          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition shrink-0">
                            <button type="button" onClick={() => { setEditingTaskId(task.id); setEditingTaskTitle(task.title) }}
                              className="p-1 text-muted-foreground hover:text-foreground" title="Edit">
                              <Pencil className="size-3" />
                            </button>
                            <button type="button" onClick={() => deleteTask(task.id)}
                              className="p-1 text-muted-foreground hover:text-destructive" title="Delete">
                              <Trash2 className="size-3" />
                            </button>
                          </div>
                        )}
                      </div>
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

function getTimelineEventColor(type: string): string {
  const colors: Record<string, string> = {
    email: 'bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400',
    form_submission: 'bg-purple-100 text-purple-600 dark:bg-purple-900/40 dark:text-purple-400',
    activity: 'bg-orange-100 text-orange-600 dark:bg-orange-900/40 dark:text-orange-400',
    note: 'bg-yellow-100 text-yellow-600 dark:bg-yellow-900/40 dark:text-yellow-400',
    task: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/40 dark:text-emerald-400',
    invoice: 'bg-green-100 text-green-600 dark:bg-green-900/40 dark:text-green-400',
    booking: 'bg-indigo-100 text-indigo-600 dark:bg-indigo-900/40 dark:text-indigo-400',
    sms: 'bg-cyan-100 text-cyan-600 dark:bg-cyan-900/40 dark:text-cyan-400',
    course_enrollment: 'bg-pink-100 text-pink-600 dark:bg-pink-900/40 dark:text-pink-400',
    course: 'bg-pink-100 text-pink-600 dark:bg-pink-900/40 dark:text-pink-400',
    event: 'bg-violet-100 text-violet-600 dark:bg-violet-900/40 dark:text-violet-400',
    tag: 'bg-rose-100 text-rose-600 dark:bg-rose-900/40 dark:text-rose-400',
    engagement: 'bg-amber-100 text-amber-600 dark:bg-amber-900/40 dark:text-amber-400',
    contact_created: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/40 dark:text-emerald-400',
    deal: 'bg-green-100 text-green-600 dark:bg-green-900/40 dark:text-green-400',
  }
  return colors[type] || 'bg-muted text-muted-foreground'
}

function TimelineIcon({ name }: { name: string }) {
  const iconClass = 'size-3.5'
  switch (name) {
    case 'Mail': return <Mail className={iconClass} />
    case 'FileText': return <FileText className={iconClass} />
    case 'Activity': return <Activity className={iconClass} />
    case 'StickyNote': return <StickyNote className={iconClass} />
    case 'CheckSquare': return <CheckSquare className={iconClass} />
    case 'DollarSign': return <DollarSign className={iconClass} />
    case 'Calendar': return <Calendar className={iconClass} />
    case 'MessageSquare': return <MessageSquare className={iconClass} />
    case 'BookOpen': return <BookOpen className={iconClass} />
    case 'Tag': return <Tag className={iconClass} />
    case 'TrendingUp': return <TrendingUp className={iconClass} />
    case 'CalendarCheck': return <Calendar className={iconClass} />
    case 'UserPlus': return <Users className={iconClass} />
    case 'Handshake': return <DollarSign className={iconClass} />
    case 'Flame': return <Flame className={iconClass} />
    default: return <Clock className={iconClass} />
  }
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
