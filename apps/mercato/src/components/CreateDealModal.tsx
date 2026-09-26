'use client'

import { useEffect, useState } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { X, DollarSign, Loader2, Search, UserPlus, User } from 'lucide-react'
import { DEFAULT_DEAL_STAGES, dealStageNames, openDealStageNames } from '@/modules/customers/lib/deal-board'
import { useServerContactSearch, type PickerContact } from '@/lib/useServerContactSearch'

interface CreateDealProps {
  contactName?: string
  contactId?: string
  onClose: () => void
  onCreated?: () => void
}

type PickedContact = { id: string; name: string; email: string | null }

/**
 * New Deal. From a contact's record the contact is fixed (contactId). From
 * the pipeline board there is none yet, so the modal lets the owner search
 * their contacts or add a new one right here, and the deal is created linked
 * to that contact (personIds), exactly as New Deal from a contact's record.
 */
export function CreateDealModal({ contactName, contactId, onClose, onCreated }: CreateDealProps) {
  const [title, setTitle] = useState(contactName ? `Deal with ${contactName}` : '')
  const [titleEdited, setTitleEdited] = useState(!!contactName)
  const [value, setValue] = useState('')
  // The organization's own stages (the list the pipeline board shows), minus
  // Won/Lost: a new deal starts open.
  const [stages, setStages] = useState<string[] | null>(null)
  const [stage, setStage] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Contact (board only): pick an existing one or add a new one.
  const [contactMode, setContactMode] = useState<'pick' | 'new'>('pick')
  const [picked, setPicked] = useState<PickedContact | null>(null)
  const [search, setSearch] = useState('')
  const [newName, setNewName] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [newPhone, setNewPhone] = useState('')
  const remote = useServerContactSearch(contactId ? '' : search, { limit: 8 })

  useEffect(() => {
    let cancelled = false
    fetch('/api/customers/business-profile', { credentials: 'include' })
      .then(r => r.json())
      .then(d => dealStageNames(d?.ok ? d.data : null))
      .catch(() => [...DEFAULT_DEAL_STAGES])
      .then(names => {
        if (cancelled) return
        const open = openDealStageNames(names)
        setStages(open)
        setStage(current => (current && open.includes(current) ? current : open[0] ?? ''))
      })
    return () => { cancelled = true }
  }, [])

  function suggestTitle(name: string) {
    if (!titleEdited && name.trim()) setTitle(`Deal with ${name.trim()}`)
  }

  function pick(contact: PickerContact) {
    const name = contact.display_name || contact.primary_email || 'Contact'
    setPicked({ id: contact.id, name, email: contact.primary_email ?? null })
    setSearch('')
    suggestTitle(name)
  }

  /** The contact to link: the fixed one, the picked one, or a new one created now. */
  async function resolveContactId(): Promise<string | null | false> {
    if (contactId) return contactId
    if (contactMode === 'pick') return picked?.id ?? null
    const name = newName.trim()
    if (!name) {
      setError("Enter the new contact's name, or pick an existing contact.")
      return false
    }
    const [firstName, ...rest] = name.split(/\s+/)
    const res = await fetch('/api/customers/people', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        displayName: name,
        firstName,
        ...(rest.length ? { lastName: rest.join(' ') } : {}),
        ...(newEmail.trim() ? { primaryEmail: newEmail.trim() } : {}),
        ...(newPhone.trim() ? { primaryPhone: newPhone.trim() } : {}),
        source: 'manual',
      }),
    })
    const data = await res.json().catch(() => ({}))
    if (!data?.id) {
      setError(data?.error || 'Could not add the contact')
      return false
    }
    // Keep it picked, so a retry after a failed deal never adds them twice.
    setPicked({ id: String(data.id), name, email: newEmail.trim() || null })
    setContactMode('pick')
    return String(data.id)
  }

  async function createDeal() {
    if (!title.trim()) return
    setCreating(true)
    setError(null)
    try {
      const personId = await resolveContactId()
      if (personId === false) {
        setCreating(false)
        return
      }
      // Use the customers API to create a deal
      const res = await fetch('/api/customers/deals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          title: title.trim(),
          valueAmount: value ? Number(value) : null,
          valueCurrency: 'USD',
          pipelineStage: stage || undefined,
          status: 'open',
          // Link to the contact (the create command reads personIds)
          ...(personId ? { personIds: [personId] } : {}),
        }),
      })
      const data = await res.json()
      if (data.ok !== false && (data.id || data.data?.id)) {
        onCreated?.()
        onClose()
      } else {
        setError(data.error || 'Failed to create deal')
      }
    } catch {
      setError('Failed to create deal')
    }
    setCreating(false)
  }

  const results = remote.results ?? []

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-background rounded-xl border shadow-2xl w-full max-w-md max-h-[calc(100dvh-2rem)] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b shrink-0">
          <h2 className="text-sm font-semibold">New Deal</h2>
          <button type="button" onClick={onClose} aria-label="Close"
            className="w-7 h-7 rounded-md hover:bg-muted flex items-center justify-center text-muted-foreground">
            <X className="size-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 overflow-y-auto">
          {error && <p className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded">{error}</p>}

          {!contactId && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Contact</label>
                {!picked && (
                  <button type="button"
                    onClick={() => { setContactMode(contactMode === 'pick' ? 'new' : 'pick'); setError(null) }}
                    className="text-xs font-medium text-accent hover:underline">
                    {contactMode === 'pick' ? 'Add a new contact' : 'Pick an existing contact'}
                  </button>
                )}
              </div>

              {picked ? (
                <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
                  <User className="size-4 text-muted-foreground shrink-0" aria-hidden />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{picked.name}</p>
                    {picked.email && <p className="text-xs text-muted-foreground truncate">{picked.email}</p>}
                  </div>
                  <button type="button" onClick={() => setPicked(null)}
                    className="text-xs font-medium text-accent hover:underline shrink-0">
                    Change
                  </button>
                </div>
              ) : contactMode === 'pick' ? (
                <div>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" aria-hidden />
                    <Input value={search} onChange={e => setSearch(e.target.value)}
                      placeholder="Search by name, email or phone" className="h-9 pl-9 text-sm" autoFocus />
                  </div>
                  {search.trim().length >= 2 && (
                    <div className="mt-1.5 rounded-md border max-h-44 overflow-y-auto">
                      {remote.loading && results.length === 0 ? (
                        <p className="px-3 py-2 text-xs text-muted-foreground flex items-center gap-1.5">
                          <Loader2 className="size-3 animate-spin" aria-hidden /> Searching...
                        </p>
                      ) : results.length === 0 ? (
                        <div className="px-3 py-2 text-xs text-muted-foreground">
                          No contact matches.{' '}
                          <button type="button" className="font-medium text-accent hover:underline"
                            onClick={() => { setContactMode('new'); setNewName(search.includes('@') ? '' : search.trim()); setNewEmail(search.includes('@') ? search.trim() : '') }}>
                            Add them as a new contact
                          </button>
                        </div>
                      ) : (
                        results.map(c => (
                          <button key={c.id} type="button" onClick={() => pick(c)}
                            className="w-full text-left px-3 py-2 border-b last:border-0 hover:bg-muted/40">
                            <p className="text-sm truncate">{c.display_name || c.primary_email || 'Unnamed contact'}</p>
                            {c.primary_email && c.display_name && <p className="text-xs text-muted-foreground truncate">{c.primary_email}</p>}
                          </button>
                        ))
                      )}
                    </div>
                  )}
                  {search.trim().length < 2 && (
                    <p className="text-xs text-muted-foreground mt-1">Optional. The deal shows on this contact's record.</p>
                  )}
                </div>
              ) : (
                <div className="space-y-2 rounded-md border p-3">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-foreground/80">
                    <UserPlus className="size-3.5" aria-hidden /> New contact
                  </div>
                  <Input value={newName} onChange={e => { setNewName(e.target.value); suggestTitle(e.target.value) }}
                    placeholder="Full name" className="h-9 text-sm" autoFocus />
                  <Input type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)}
                    placeholder="Email (optional)" className="h-9 text-sm" />
                  <Input type="tel" inputMode="tel" value={newPhone} onChange={e => setNewPhone(e.target.value)}
                    placeholder="Phone (optional)" className="h-9 text-sm" />
                </div>
              )}
            </div>
          )}

          <div>
            <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Deal Title</label>
            <Input value={title} onChange={e => { setTitle(e.target.value); setTitleEdited(true) }}
              placeholder="e.g. Website redesign for Acme Co" className="h-9 text-sm" autoFocus={!!contactId} />
          </div>

          <div>
            <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Value ($)</label>
            <Input type="number" value={value} onChange={e => setValue(e.target.value)} placeholder="0.00" className="h-9 text-sm" step="0.01" />
          </div>

          <div>
            <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Pipeline Stage</label>
            <select value={stage} onChange={e => setStage(e.target.value)} disabled={!stages}
              className="w-full h-9 rounded-md border bg-card px-3 text-sm">
              {!stages && <option value="">Loading stages...</option>}
              {(stages ?? []).map(name => <option key={name} value={name}>{name}</option>)}
            </select>
          </div>
        </div>

        <div className="px-5 py-3 border-t flex items-center justify-between shrink-0">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="button" size="sm" onClick={createDeal} disabled={creating || !title.trim() || !stages}>
            {creating ? <><Loader2 className="size-3 animate-spin mr-1.5" /> Creating...</> : <><DollarSign className="size-3.5 mr-1.5" /> Create Deal</>}
          </Button>
        </div>
      </div>
    </div>
  )
}
