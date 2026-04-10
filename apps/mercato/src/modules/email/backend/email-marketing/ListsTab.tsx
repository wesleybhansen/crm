'use client'

import { useState, useEffect, useRef } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Plus, X, Loader2, Users, Trash2, ArrowLeft, Search, Upload, Download, Zap, Pencil } from 'lucide-react'

type EmailList = { id: string; name: string; description: string | null; source_type: string; member_count: number; created_at: string }
type ListMember = { contact_id: string; display_name: string; primary_email: string | null; added_at: string }
type Contact = { id: string; display_name: string; primary_email: string | null }

const AUTO_TRIGGER_TYPES = [
  { value: '', label: 'No auto-add (manual only)' },
  { value: 'form_submitted', label: 'Submitted a form' },
  { value: 'product_purchased', label: 'Purchased a product' },
  { value: 'tag_added', label: 'Were tagged with' },
  { value: 'booking_created', label: 'Booked an appointment' },
  { value: 'invoice_paid', label: 'Paid an invoice' },
]

// ============ Contact Picker (extracted to prevent re-mount on parent re-render) ============
function ContactPickerInline({ contacts, loading, search, onSearch, selected, onSelected, excludeIds }: {
  contacts: Contact[]; loading: boolean
  search: string; onSearch: (v: string) => void
  selected: Set<string>; onSelected: (s: Set<string>) => void
  excludeIds?: Set<string>
}) {
  const filtered = contacts
    .filter(c => !excludeIds?.has(c.id))
    .filter(c => {
      if (!search.trim()) return true
      const q = search.toLowerCase()
      return (c.display_name || '').toLowerCase().includes(q) || (c.primary_email || '').toLowerCase().includes(q)
    })
  const allSelected = filtered.length > 0 && filtered.every(c => selected.has(c.id))

  return (
    <div className="rounded-lg border overflow-hidden">
      <div className="flex items-center gap-2 px-3 h-9 border-b bg-muted/20">
        <Search className="size-3.5 text-muted-foreground shrink-0" />
        <input value={search} onChange={e => onSearch(e.target.value)}
          placeholder="Search by name or email..."
          className="text-sm bg-transparent outline-none flex-1 placeholder:text-muted-foreground" />
        {selected.size > 0 && <span className="text-[10px] font-medium text-accent shrink-0">{selected.size} selected</span>}
      </div>
      {filtered.length > 0 && (
        <label className="flex items-center gap-2 px-3 py-1.5 border-b bg-muted/10 cursor-pointer text-[11px] font-medium text-muted-foreground hover:bg-muted/20">
          <input type="checkbox" checked={allSelected}
            onChange={() => onSelected(allSelected ? new Set() : new Set(filtered.map(c => c.id)))}
            className="rounded border-border size-3.5" />
          {allSelected ? 'Deselect all' : `Select all${search ? ' matching' : ''} (${filtered.length})`}
        </label>
      )}
      <div className="max-h-[220px] overflow-y-auto">
        {loading ? (
          <div className="p-4 text-center text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin inline mr-1" /> Loading contacts...</div>
        ) : filtered.length === 0 ? (
          <div className="p-4 text-center text-xs text-muted-foreground">{search ? 'No matching contacts' : contacts.length === 0 ? 'No contacts with email addresses yet' : 'All contacts already in this list'}</div>
        ) : filtered.map(c => (
          <label key={c.id} className={`flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-muted/20 transition border-b last:border-0 ${selected.has(c.id) ? 'bg-accent/5' : ''}`}>
            <input type="checkbox" checked={selected.has(c.id)}
              onChange={() => {
                const next = new Set(selected)
                if (next.has(c.id)) next.delete(c.id); else next.add(c.id)
                onSelected(next)
              }}
              className="rounded border-border size-3.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium truncate">{c.display_name || c.primary_email}</p>
              {c.primary_email && c.display_name && <p className="text-[10px] text-muted-foreground truncate">{c.primary_email}</p>}
            </div>
          </label>
        ))}
      </div>
    </div>
  )
}

// ============ Main Component ============
export default function ListsTab() {
  const [lists, setLists] = useState<EmailList[]>([])
  const [loading, setLoading] = useState(true)

  // Contacts cache
  const [allContacts, setAllContacts] = useState<Contact[]>([])
  const contactsLoadedRef = useRef(false)
  const [contactsLoading, setContactsLoading] = useState(false)

  // Auto-trigger options
  const [forms, setForms] = useState<Array<{ id: string; name: string }>>([])
  const [products, setProducts] = useState<Array<{ id: string; name: string }>>([])
  const [tags, setTags] = useState<Array<{ id: string; name: string }>>([])
  const [bookingPages, setBookingPages] = useState<Array<{ id: string; name: string }>>([])

  // Create form
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [creating, setCreating] = useState(false)
  const [createSearch, setCreateSearch] = useState('')
  const [createSelected, setCreateSelected] = useState<Set<string>>(new Set())
  const [autoTrigger, setAutoTrigger] = useState('')
  const [autoTriggerValues, setAutoTriggerValues] = useState<Set<string>>(new Set())

  // Detail view
  const [selectedList, setSelectedList] = useState<EmailList | null>(null)
  const [members, setMembers] = useState<ListMember[]>([])
  const [membersLoading, setMembersLoading] = useState(false)

  // Edit list
  const [editingName, setEditingName] = useState('')
  const [editingDesc, setEditingDesc] = useState('')
  const [showEdit, setShowEdit] = useState(false)
  const [savingEdit, setSavingEdit] = useState(false)

  // Add modal
  const [showAddModal, setShowAddModal] = useState(false)
  const [addSearch, setAddSearch] = useState('')
  const [addSelected, setAddSelected] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)

  // CSV import
  const [showImport, setShowImport] = useState(false)
  const [importCsv, setImportCsv] = useState('')
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<string | null>(null)

  useEffect(() => { loadLists() }, [])

  function loadLists() {
    setLoading(true)
    fetch('/api/email/lists', { credentials: 'include' })
      .then(r => r.json()).then(d => { if (d.ok) setLists(d.data || []) })
      .catch(() => {}).finally(() => setLoading(false))
  }

  function loadContacts() {
    if (contactsLoadedRef.current && allContacts.length > 0) return
    contactsLoadedRef.current = true
    setContactsLoading(true)
    fetch('/api/email-lists/contacts', { credentials: 'include' })
      .then(r => r.json()).then(d => {
        if (d.ok && Array.isArray(d.data)) {
          setAllContacts(d.data.map((c: any) => ({
            id: c.id,
            display_name: c.display_name || '',
            primary_email: c.primary_email || null,
          })))
        }
      }).catch(() => {})
      .finally(() => setContactsLoading(false))
  }

  function loadTriggerOptions(trigger: string) {
    if (trigger === 'form_submitted' && forms.length === 0) {
      fetch('/api/forms?pageSize=50', { credentials: 'include' }).then(r => r.json())
        .then(d => { const items = d.data || d.items || []; setForms(items.map((f: any) => ({ id: f.id, name: f.name || f.title }))) }).catch(() => {})
    }
    if (trigger === 'product_purchased' && products.length === 0) {
      fetch('/api/payments/products', { credentials: 'include' }).then(r => r.json())
        .then(d => { setProducts((d.data || []).map((p: any) => ({ id: p.id, name: p.name }))) }).catch(() => {})
    }
    if (trigger === 'tag_added' && tags.length === 0) {
      fetch('/api/crm-contact-tags', { credentials: 'include' }).then(r => r.json())
        .then(d => { setTags((d.data || []).map((t: any) => ({ id: t.id || t.slug, name: t.name || t.label }))) }).catch(() => {})
    }
    if (trigger === 'booking_created' && bookingPages.length === 0) {
      fetch('/api/calendar/booking-pages', { credentials: 'include' }).then(r => r.json())
        .then(d => { setBookingPages((d.data || []).map((b: any) => ({ id: b.id, name: b.title }))) }).catch(() => {})
    }
  }

  // --- Create ---
  function openCreateForm() {
    setShowCreate(true); setNewName(''); setNewDescription('')
    setCreateSelected(new Set()); setCreateSearch('')
    setAutoTrigger(''); setAutoTriggerValues(new Set())
    loadContacts()
  }

  async function createList() {
    if (!newName.trim()) return
    setCreating(true)
    try {
      const res = await fetch('/api/email/lists', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({
          name: newName.trim(),
          description: newDescription.trim() || undefined,
          sourceType: autoTrigger || 'manual',
          triggerValues: autoTriggerValues.size > 0 ? [...autoTriggerValues] : undefined,
        }),
      })
      const data = await res.json()
      if (data.ok && data.data) {
        if (createSelected.size > 0) {
          await fetch(`/api/email-lists/${data.data.id}/members`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
            body: JSON.stringify({ contactIds: [...createSelected] }),
          }).catch(() => {})
        }
        setShowCreate(false)
        loadLists()
        openList({ ...data.data, member_count: createSelected.size })
      }
    } catch {}
    setCreating(false)
  }

  // --- Detail ---
  function openList(list: EmailList) {
    setSelectedList(list); setMembersLoading(true)
    fetch(`/api/email-lists/${list.id}/members?limit=200`, { credentials: 'include' })
      .then(r => r.json()).then(d => { if (d.ok) setMembers(d.data || []) })
      .catch(() => {}).finally(() => setMembersLoading(false))
  }

  async function deleteList(listId: string, name: string) {
    if (!confirm(`Delete "${name}"?`)) return
    try {
      await fetch(`/api/email/lists?id=${listId}`, { method: 'DELETE', credentials: 'include' })
      if (selectedList?.id === listId) setSelectedList(null)
      loadLists()
    } catch {}
  }

  async function removeMember(contactId: string) {
    if (!selectedList) return
    await fetch(`/api/email-lists/${selectedList.id}/members`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ contactIds: [contactId] }),
    }).catch(() => {})
    setMembers(prev => prev.filter(m => m.contact_id !== contactId))
    loadLists()
  }

  // --- Edit List ---
  function startEditList() {
    if (!selectedList) return
    setEditingName(selectedList.name)
    // Clean description for editing — strip auto_trigger JSON
    const rawDesc = selectedList.description || ''
    setEditingDesc(rawDesc.replace(/\n?\[auto_trigger:[^\]]*\]/g, '').trim())
    // Load current auto-trigger
    const currentTrigger = selectedList.source_type !== 'manual' ? selectedList.source_type : ''
    setAutoTrigger(currentTrigger)
    if (currentTrigger) loadTriggerOptions(currentTrigger)
    // Parse existing trigger values
    const match = rawDesc.match(/\[auto_trigger:(.+?)\]/)
    if (match) {
      try { setAutoTriggerValues(new Set(JSON.parse(match[1]))) } catch { setAutoTriggerValues(new Set()) }
    } else {
      setAutoTriggerValues(new Set())
    }
    setShowEdit(true)
  }

  async function saveEditList() {
    if (!selectedList || !editingName.trim()) return
    setSavingEdit(true)
    try {
      // Build description with trigger config appended
      let desc = editingDesc.trim()
      if (autoTrigger && autoTriggerValues.size > 0) {
        desc = (desc ? desc + '\n' : '') + `[auto_trigger:${JSON.stringify([...autoTriggerValues])}]`
      }
      const newSourceType = autoTrigger || 'manual'

      await fetch('/api/email/lists', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ id: selectedList.id, name: editingName.trim(), description: desc || null, sourceType: newSourceType }),
      })
      setSelectedList({ ...selectedList, name: editingName.trim(), description: desc || null, source_type: newSourceType })
      setShowEdit(false)
      loadLists()
    } catch {}
    setSavingEdit(false)
  }

  // --- Add Modal ---
  function openAddModal() {
    setShowAddModal(true); setAddSelected(new Set()); setAddSearch('')
    loadContacts()
  }

  async function bulkAdd() {
    if (!selectedList || addSelected.size === 0) return
    setAdding(true)
    await fetch(`/api/email-lists/${selectedList.id}/members`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ contactIds: [...addSelected] }),
    }).catch(() => {})
    setShowAddModal(false); openList(selectedList); loadLists()
    setAdding(false)
  }

  // --- CSV Import ---
  async function importCsvToList() {
    if (!selectedList || !importCsv.trim()) return
    setImporting(true); setImportResult(null)
    try {
      const lines = importCsv.trim().split('\n').filter(l => l.trim())
      const contactIds: string[] = []
      for (const line of lines) {
        const parts = line.split(',').map(p => p.trim())
        const email = parts.find(p => p.includes('@'))
        if (!email) continue
        const name = parts.find(p => !p.includes('@')) || email.split('@')[0]
        await fetch('/api/contacts/import', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ contacts: [{ name, email }] }),
        })
        const sr = await fetch(`/api/customers/people?pageSize=1&search=${encodeURIComponent(email)}`, { credentials: 'include' })
        const sd = await sr.json()
        const items = Array.isArray(sd.data?.items) ? sd.data.items : (Array.isArray(sd.data) ? sd.data : [])
        const c = items.find((c: any) => (c.primary_email || c.primaryEmail || '').toLowerCase() === email.toLowerCase())
        if (c) contactIds.push(c.id)
      }
      if (contactIds.length > 0) {
        await fetch(`/api/email-lists/${selectedList.id}/members`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ contactIds }),
        })
      }
      setImportResult(`Imported ${contactIds.length} of ${lines.length}`); setImportCsv(''); openList(selectedList); loadLists()
    } catch { setImportResult('Import failed') }
    setImporting(false)
  }

  // --- Trigger options for auto-add ---
  function getTriggerOptions(): Array<{ id: string; name: string }> {
    if (autoTrigger === 'form_submitted') return forms
    if (autoTrigger === 'product_purchased') return products
    if (autoTrigger === 'tag_added') return tags
    if (autoTrigger === 'booking_created') return bookingPages
    return []
  }

  const triggerNeedsOptions = ['form_submitted', 'product_purchased', 'tag_added', 'booking_created'].includes(autoTrigger)
  const triggerOptions = getTriggerOptions()

  const sourceBadge: Record<string, string> = {
    manual: 'bg-muted text-muted-foreground',
    event: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    course: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
    form_submitted: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
    product_purchased: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
    tag_added: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400',
    booking_created: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
    invoice_paid: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  }
  const sourceLabel: Record<string, string> = {
    manual: 'Manual', event: 'Event', course: 'Course',
    form_submitted: 'Form', product_purchased: 'Purchase',
    tag_added: 'Tag', booking_created: 'Booking', invoice_paid: 'Invoice',
  }
  function cleanDescription(desc: string | null): string | null {
    if (!desc) return null
    return desc.replace(/\n?\[auto_trigger:[^\]]*\]/g, '').replace(/^\s*\]?\s*$/, '').trim() || null
  }

  // ========== DETAIL VIEW ==========
  if (selectedList) {
    const memberIds = new Set(members.map(m => m.contact_id))
    const listDesc = cleanDescription(selectedList.description)
    return (
      <div>
        <button type="button" onClick={() => { setSelectedList(null); setShowEdit(false) }}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4 transition">
          <ArrowLeft className="size-3.5" /> Back to lists
        </button>

        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold">{selectedList.name}</h2>
              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${sourceBadge[selectedList.source_type] || 'bg-muted text-muted-foreground'}`}>
                {sourceLabel[selectedList.source_type] || selectedList.source_type}
              </span>
            </div>
            {listDesc && <p className="text-xs text-muted-foreground mt-0.5">{listDesc}</p>}
            <p className="text-xs text-muted-foreground mt-0.5">{members.length} member{members.length !== 1 ? 's' : ''}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" onClick={openAddModal}><Plus className="size-3.5 mr-1.5" /> Add Contacts</Button>
            <Button type="button" variant="outline" size="sm" onClick={() => {
              const csv = 'Name,Email\n' + members.map(m => `"${(m.display_name || '').replace(/"/g, '""')}","${m.primary_email || ''}"`).join('\n')
              const blob = new Blob([csv], { type: 'text/csv' })
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a'); a.href = url; a.download = `${selectedList.name.replace(/[^a-zA-Z0-9]/g, '-')}-members.csv`; a.click()
              URL.revokeObjectURL(url)
            }}><Download className="size-3.5 mr-1.5" /> Export</Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setShowImport(!showImport)}><Upload className="size-3.5 mr-1.5" /> Import</Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setShowEdit(!showEdit)}>
              <Pencil className="size-3.5 mr-1.5" /> Edit
            </Button>
            <Button type="button" variant="outline" size="sm" className="text-red-600 border-red-200 hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-950/30"
              onClick={() => deleteList(selectedList.id, selectedList.name)}><Trash2 className="size-3.5" /></Button>
          </div>
        </div>

        {/* Edit form — only shows when Edit button is clicked */}
        {showEdit && (
          <div className="rounded-lg border bg-card p-4 mb-4 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">List Name</label>
                <Input value={editingName} onChange={e => setEditingName(e.target.value)} className="h-9 text-sm" autoFocus />
              </div>
              <div>
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Description</label>
                <Input value={editingDesc} onChange={e => setEditingDesc(e.target.value)} placeholder="Optional" className="h-9 text-sm" />
              </div>
            </div>
            {/* Auto-add criteria editing */}
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">
                <Zap className="size-3 inline mr-1" />Auto-Add Criteria
              </label>
              <select value={autoTrigger} onChange={e => { setAutoTrigger(e.target.value); setAutoTriggerValues(new Set()); loadTriggerOptions(e.target.value) }}
                className="h-9 text-sm rounded-md border bg-background px-2 w-full">
                {AUTO_TRIGGER_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              {triggerNeedsOptions && triggerOptions.length > 0 && (
                <div className="mt-2 rounded-md border max-h-[120px] overflow-y-auto">
                  {triggerOptions.map(opt => (
                    <label key={opt.id} className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-muted/20 text-xs border-b last:border-0 ${autoTriggerValues.has(opt.id) ? 'bg-accent/5' : ''}`}>
                      <input type="checkbox" checked={autoTriggerValues.has(opt.id)}
                        onChange={() => setAutoTriggerValues(prev => { const n = new Set(prev); if (n.has(opt.id)) n.delete(opt.id); else n.add(opt.id); return n })}
                        className="rounded border-border size-3.5" />
                      {opt.name}
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setShowEdit(false)}>Cancel</Button>
              <Button type="button" size="sm" onClick={saveEditList} disabled={savingEdit || !editingName.trim()}>
                {savingEdit ? <Loader2 className="size-3 animate-spin mr-1" /> : null} Save
              </Button>
            </div>
          </div>
        )}

        {showImport && (
          <div className="rounded-lg border bg-card p-4 mb-4 space-y-2">
            <p className="text-xs text-muted-foreground">Paste emails (one per line) or name, email:</p>
            <textarea value={importCsv} onChange={e => setImportCsv(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm resize-none h-24 focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder={"john@example.com\nJane Smith, jane@example.com"} />
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" onClick={importCsvToList} disabled={importing || !importCsv.trim()}>
                {importing ? <><Loader2 className="size-3 animate-spin mr-1" /> Importing...</> : <><Upload className="size-3 mr-1" /> Import</>}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => { setShowImport(false); setImportCsv('') }}>Cancel</Button>
              {importResult && <span className="text-xs text-muted-foreground">{importResult}</span>}
            </div>
          </div>
        )}

        {showAddModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
            <div className="bg-background rounded-xl border shadow-2xl w-full max-w-lg mx-4 flex flex-col" style={{ maxHeight: '80vh' }}>
              <div className="flex items-center justify-between px-5 py-3 border-b shrink-0">
                <h3 className="text-sm font-semibold">Add Contacts to {selectedList.name}</h3>
                <button type="button" onClick={() => setShowAddModal(false)} className="text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
              </div>
              <div className="p-4 flex-1 min-h-0 overflow-y-auto">
                <ContactPickerInline contacts={allContacts} loading={contactsLoading}
                  search={addSearch} onSearch={setAddSearch}
                  selected={addSelected} onSelected={setAddSelected} excludeIds={memberIds} />
              </div>
              <div className="px-5 py-3 border-t flex items-center justify-between shrink-0">
                <Button type="button" variant="outline" size="sm" onClick={() => setShowAddModal(false)}>Cancel</Button>
                <Button type="button" size="sm" onClick={bulkAdd} disabled={adding || addSelected.size === 0}>
                  {adding ? <Loader2 className="size-3 animate-spin mr-1.5" /> : <Plus className="size-3 mr-1.5" />}
                  Add {addSelected.size > 0 ? `${addSelected.size} Contact${addSelected.size !== 1 ? 's' : ''}` : 'Selected'}
                </Button>
              </div>
            </div>
          </div>
        )}

        {membersLoading ? (
          <div className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="size-3 animate-spin" /> Loading...</div>
        ) : members.length === 0 ? (
          <div className="rounded-lg border p-8 text-center">
            <Users className="size-8 mx-auto mb-3 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground mb-3">No members yet.</p>
            <Button type="button" size="sm" onClick={openAddModal}><Plus className="size-3.5 mr-1.5" /> Add Contacts</Button>
          </div>
        ) : (
          <div className="rounded-lg border divide-y">
            {members.map(m => (
              <div key={m.contact_id} className="flex items-center justify-between px-4 py-2.5">
                <div>
                  <p className="text-sm font-medium">{m.display_name}</p>
                  {m.primary_email && <p className="text-xs text-muted-foreground">{m.primary_email}</p>}
                </div>
                <button type="button" onClick={() => removeMember(m.contact_id)}
                  className="text-muted-foreground hover:text-red-600 transition"><X className="size-3.5" /></button>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  // ========== LIST INDEX ==========
  return (
    <div>
      <div className="flex items-center justify-end mb-4">
        <Button type="button" size="sm" onClick={openCreateForm}><Plus className="size-3.5 mr-1.5" /> New List</Button>
      </div>

      {showCreate && (
        <div className="rounded-lg border bg-card mb-4 overflow-hidden">
          <div className="flex items-center justify-between px-5 pt-4 pb-2">
            <h3 className="text-sm font-semibold">New Mailing List</h3>
            <button type="button" onClick={() => setShowCreate(false)} className="text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
          </div>
          <div className="px-5 pb-4 space-y-4">
            {/* Name + Description */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">List Name</label>
                <Input value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. Newsletter Subscribers" className="h-9 text-sm" autoFocus />
              </div>
              <div>
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Description</label>
                <Input value={newDescription} onChange={e => setNewDescription(e.target.value)} placeholder="Optional" className="h-9 text-sm" />
              </div>
            </div>

            {/* Auto-add trigger */}
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">
                <Zap className="size-3 inline mr-1" />Auto-Add Contacts Who...
              </label>
              <select value={autoTrigger} onChange={e => { setAutoTrigger(e.target.value); setAutoTriggerValues(new Set()); loadTriggerOptions(e.target.value) }}
                className="h-9 text-sm rounded-md border bg-background px-2 w-full">
                {AUTO_TRIGGER_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              {triggerNeedsOptions && (
                <div className="mt-2">
                  {triggerOptions.length === 0 ? (
                    <p className="text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin inline mr-1" />Loading options...</p>
                  ) : (
                    <div className="rounded-md border max-h-[120px] overflow-y-auto">
                      {triggerOptions.map(opt => (
                        <label key={opt.id} className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-muted/20 text-xs border-b last:border-0 ${autoTriggerValues.has(opt.id) ? 'bg-accent/5' : ''}`}>
                          <input type="checkbox" checked={autoTriggerValues.has(opt.id)}
                            onChange={() => setAutoTriggerValues(prev => {
                              const next = new Set(prev); if (next.has(opt.id)) next.delete(opt.id); else next.add(opt.id); return next
                            })} className="rounded border-border size-3.5" />
                          {opt.name}
                        </label>
                      ))}
                    </div>
                  )}
                  {autoTriggerValues.size > 0 && <p className="text-[10px] text-accent mt-1">{autoTriggerValues.size} selected</p>}
                </div>
              )}
              {autoTrigger && triggerNeedsOptions && autoTriggerValues.size === 0 && (
                <p className="text-[10px] text-muted-foreground mt-1">Selecting specific {autoTrigger === 'form_submitted' ? 'forms' : autoTrigger === 'product_purchased' ? 'products' : autoTrigger === 'tag_added' ? 'tags' : 'booking pages'} is optional. Leave blank to auto-add from all.</p>
              )}
              {autoTrigger && <p className="text-[10px] text-muted-foreground mt-1">Contacts will be automatically added to this list when they match this criteria going forward.</p>}
            </div>

            {/* Contact picker */}
            <div>
              <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">
                Add Contacts {createSelected.size > 0 && <span className="text-accent normal-case">({createSelected.size} selected)</span>}
              </label>
              <ContactPickerInline contacts={allContacts} loading={contactsLoading}
                search={createSearch} onSearch={setCreateSearch}
                selected={createSelected} onSelected={setCreateSelected} />
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t">
              <Button type="button" variant="outline" size="sm" onClick={() => setShowCreate(false)}>Cancel</Button>
              <Button type="button" size="sm" onClick={createList} disabled={creating || !newName.trim()}>
                {creating ? <Loader2 className="size-3 animate-spin mr-1" /> : <Plus className="size-3 mr-1" />}
                Create{createSelected.size > 0 ? ` with ${createSelected.size} contact${createSelected.size !== 1 ? 's' : ''}` : ''}
              </Button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading...</div>
      ) : lists.length === 0 && !showCreate ? (
        <div className="rounded-lg border p-12 text-center">
          <Users className="size-8 mx-auto mb-3 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">No mailing lists yet. Create one to organize contacts for campaigns.</p>
        </div>
      ) : (
        <div className="rounded-lg border divide-y">
          {lists.map(list => (
            <button key={list.id} type="button" onClick={() => openList(list)}
              className="w-full text-left px-5 py-4 hover:bg-muted/30 transition flex items-center gap-4">
              <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center shrink-0">
                <Users className="size-5 text-accent" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">{list.name}</p>
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${sourceBadge[list.source_type] || 'bg-muted text-muted-foreground'}`}>
                    {sourceLabel[list.source_type] || list.source_type}
                  </span>
                </div>
                {cleanDescription(list.description) && <p className="text-xs text-muted-foreground truncate">{cleanDescription(list.description)}</p>}
              </div>
              <div className="text-right shrink-0">
                <p className="text-sm font-semibold tabular-nums">{list.member_count}</p>
                <p className="text-[11px] text-muted-foreground">member{list.member_count !== 1 ? 's' : ''}</p>
              </div>
              <button type="button" onClick={e => { e.stopPropagation(); deleteList(list.id, list.name) }}
                className="text-muted-foreground hover:text-red-600 transition shrink-0"><Trash2 className="size-3.5" /></button>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
