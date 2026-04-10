'use client'

import { useState, useEffect, useRef } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Loader2, Users, DollarSign, Flame, Plus, ExternalLink, X, Mail, Phone, Briefcase, Calendar, FileText, ArrowRight, GripVertical, Info } from 'lucide-react'
import { CreateDealModal } from '@/components/CreateDealModal'

type PipelineMode = 'deals' | 'journey'

type DealCard = {
  id: string
  title: string
  value_amount: number | null
  pipeline_stage: string
  status: string
  contact_name: string | null
  updated_at: string
}

type JourneyContact = {
  id: string
  displayName: string
  primaryEmail: string | null
  engagementScore: number
  createdAt: string
}

type JourneyStage = {
  name: string
  count: number
  contacts: JourneyContact[]
}

type DealStage = {
  name: string
  count: number
  totalValue: number
  deals: DealCard[]
}

type ContactDetail = {
  id: string
  displayName: string
  primaryEmail: string | null
  primaryPhone: string | null
  lifecycleStage: string | null
  source: string | null
  createdAt: string
  jobTitle: string | null
  notes: Array<{ id: string; content: string; created_at: string }>
  engagementScore: number | null
}

export default function PipelinePage() {
  const [mode, setMode] = useState<PipelineMode | null>(null)
  const [loading, setLoading] = useState(true)
  const [journeyStages, setJourneyStages] = useState<JourneyStage[]>([])
  const [dealStages, setDealStages] = useState<DealStage[]>([])
  const [dragging, setDragging] = useState<{ id: string; stage: string } | null>(null)
  const [dragOverStage, setDragOverStage] = useState<string | null>(null)
  const [movingId, setMovingId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [selectedContact, setSelectedContact] = useState<ContactDetail | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [savingTag, setSavingTag] = useState(false)
  const [showDragHint, setShowDragHint] = useState(true)
  const [showCreateDeal, setShowCreateDeal] = useState(false)

  useEffect(() => {
    loadPipelineMode()
  }, [])

  async function loadPipelineMode() {
    setLoading(true)
    try {
      const res = await fetch('/api/customers/business-profile', { credentials: 'include' })
      const data = await res.json()
      const pipelineMode = data.data?.pipeline_mode || 'deals'
      setMode(pipelineMode)

      if (pipelineMode === 'journey') {
        await loadJourneyPipeline()
      } else {
        await loadDealsPipeline(data.data)
      }
    } catch {
      setMode('deals')
      await loadDealsPipeline(null)
    }
    setLoading(false)
  }

  async function loadJourneyPipeline() {
    try {
      const res = await fetch('/api/pipeline/journey', { credentials: 'include' })
      const data = await res.json()
      if (data.ok) {
        setJourneyStages(data.data.stages)
      }
    } catch {}
  }

  async function loadDealsPipeline(profile: any) {
    try {
      let stageNames: string[] = ['Lead', 'Qualified', 'Proposal', 'Negotiation', 'Closed Won']
      if (profile?.pipeline_stages) {
        const parsed = typeof profile.pipeline_stages === 'string'
          ? JSON.parse(profile.pipeline_stages)
          : profile.pipeline_stages
        if (Array.isArray(parsed) && parsed.length >= 2) {
          stageNames = parsed.map((s: any) => typeof s === 'string' ? s : s.name).filter(Boolean)
        }
      }

      const res = await fetch('/api/integrations_api/ext/deals?status=open&pageSize=100', { credentials: 'include' })
      const data = await res.json()
      const deals: DealCard[] = data.ok ? (data.data || []) : []

      const stages = stageNames.map(name => {
        const stageDeals = deals.filter((d: DealCard) =>
          (d.pipeline_stage || '').toLowerCase() === name.toLowerCase()
        )
        return {
          name,
          count: stageDeals.length,
          totalValue: stageDeals.reduce((sum: number, d: DealCard) => sum + (d.value_amount || 0), 0),
          deals: stageDeals,
        }
      })

      setDealStages(stages)
    } catch {}
  }

  async function loadContactDetail(contactId: string) {
    setLoadingDetail(true)
    try {
      const res = await fetch(`/api/pipeline/contact-detail?id=${contactId}`, { credentials: 'include' })
      const data = await res.json()
      if (data.ok) {
        setSelectedContact(data.data)
      }
    } catch {}
    setLoadingDetail(false)
  }

  function openContactDetail(contact: JourneyContact) {
    setSelectedContact({
      id: contact.id,
      displayName: contact.displayName,
      primaryEmail: contact.primaryEmail,
      primaryPhone: null,
      lifecycleStage: null,
      source: null,
      createdAt: contact.createdAt,
      jobTitle: null,
      notes: [],
      engagementScore: contact.engagementScore,
    })
    loadContactDetail(contact.id)
  }

  const ENGAGEMENT_TAGS = [
    { label: 'Hot', score: 85, color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
    { label: 'Warm', score: 55, color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' },
    { label: 'Cool', score: 25, color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
    { label: 'New', score: 0, color: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400' },
  ]

  async function setEngagementTag(contactId: string, score: number) {
    setSavingTag(true)
    try {
      await fetch('/api/customers/engagement', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ contactId, score }),
      })
      // Update the contact in the journey stages
      setJourneyStages(prev => prev.map(stage => ({
        ...stage,
        contacts: stage.contacts.map(c =>
          c.id === contactId ? { ...c, engagementScore: score } : c
        ),
      })))
      // Update detail panel if open
      if (selectedContact?.id === contactId) {
        setSelectedContact(prev => prev ? { ...prev, engagementScore: score } : prev)
      }
    } catch {}
    setSavingTag(false)
  }

  async function moveJourneyContact(contactId: string, newStage: string) {
    setMovingId(contactId)
    try {
      const res = await fetch('/api/pipeline/journey', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ contactId, stage: newStage }),
      })
      const data = await res.json()
      if (data.ok) {
        await loadJourneyPipeline()
      }
    } catch {}
    setMovingId(null)
  }

  function handleDragStart(id: string, stage: string) {
    setDragging({ id, stage })
  }

  function handleDragOver(e: React.DragEvent, stageName: string) {
    e.preventDefault()
    setDragOverStage(stageName)
  }

  function handleDragLeave() {
    setDragOverStage(null)
  }

  async function handleDrop(e: React.DragEvent, targetStage: string) {
    e.preventDefault()
    setDragOverStage(null)
    if (!dragging || dragging.stage === targetStage) {
      setDragging(null)
      return
    }

    if (mode === 'journey') {
      await moveJourneyContact(dragging.id, targetStage)
    }
    setDragging(null)
  }

  function getScoreBadge(score: number) {
    if (score >= 70) return { label: 'Hot', color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' }
    if (score >= 40) return { label: 'Warm', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' }
    if (score >= 10) return { label: 'Cool', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' }
    return { label: 'New', color: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400' }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-120px)]">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="h-[calc(100vh-52px)] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
        <div>
          <h1 className="text-lg font-semibold">
            {mode === 'journey' ? 'Customer Journey' : 'Sales Pipeline'}
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {mode === 'journey'
              ? 'Track contacts through their lifecycle stages'
              : 'Track deals through your sales process'}
          </p>
          {mode === 'journey' && showDragHint && (
            <div className="flex items-center gap-2 mt-2 bg-accent/10 text-accent dark:bg-accent/20 dark:text-accent px-3 py-1.5 rounded-md text-xs font-medium w-fit">
              <GripVertical className="size-4" />
              <span>Drag and drop cards between stages to move contacts through your pipeline</span>
              <button type="button" onClick={() => setShowDragHint(false)} className="ml-1 hover:opacity-60 transition">
                <X className="size-3.5" />
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm"
            onClick={() => mode === 'journey' ? window.location.href = '/backend/customers/people/create' : setShowCreateDeal(true)}>
            <Plus className="size-3.5 mr-1.5" />
            {mode === 'journey' ? 'Add Contact' : 'Create Deal'}
          </Button>
        </div>
      </div>

      {/* Kanban Board */}
      <div className="flex-1 flex overflow-hidden">
        <div ref={scrollRef} className={`flex-1 overflow-x-auto overflow-y-hidden transition-all ${selectedContact ? 'mr-0' : ''}`}>
          <div className="flex gap-4 p-6 h-full min-w-max">
            {mode === 'journey' ? (
              journeyStages.map(stage => (
                <div
                  key={stage.name}
                  className={`flex flex-col w-72 shrink-0 rounded-lg border bg-card transition-colors ${
                    dragOverStage === stage.name ? 'selected-card' : ''
                  }`}
                  onDragOver={e => handleDragOver(e, stage.name)}
                  onDragLeave={handleDragLeave}
                  onDrop={e => handleDrop(e, stage.name)}
                >
                  <div className="flex items-center justify-between px-3 py-2.5 border-b">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold">{stage.name}</h3>
                      <span className="text-[10px] font-medium bg-muted px-1.5 py-0.5 rounded-full tabular-nums">
                        {stage.count}
                      </span>
                    </div>
                  </div>

                  <div className="flex-1 overflow-y-auto p-2 space-y-2">
                    {stage.contacts.map(contact => {
                      const badge = getScoreBadge(contact.engagementScore)
                      const isSelected = selectedContact?.id === contact.id
                      return (
                        <div
                          key={contact.id}
                          draggable
                          onDragStart={() => handleDragStart(contact.id, stage.name)}
                          onClick={() => openContactDetail(contact)}
                          className={`rounded-lg border bg-background p-3 cursor-pointer active:cursor-grabbing hover:border-accent/40 transition group ${
                            movingId === contact.id ? 'opacity-50' : ''
                          } ${dragging?.id === contact.id ? 'opacity-40 border' : ''} ${
                            isSelected ? 'border-accent ring-1 ring-accent/30' : ''
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-medium truncate">{contact.displayName}</p>
                              {contact.primaryEmail && (
                                <p className="text-[11px] text-muted-foreground truncate mt-0.5">{contact.primaryEmail}</p>
                              )}
                            </div>
                            <div className="relative group/tag shrink-0">
                              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded cursor-pointer hover:ring-1 hover:ring-accent/40 ${badge.color}`}>
                                {badge.label}
                              </span>
                              <div className="absolute right-0 top-full mt-1 bg-background border rounded-md shadow-lg py-1 z-20 hidden group-hover/tag:block min-w-[80px]">
                                {ENGAGEMENT_TAGS.map(tag => (
                                  <button
                                    key={tag.label}
                                    type="button"
                                    className={`w-full text-left px-2.5 py-1 text-[10px] font-medium hover:bg-muted transition flex items-center gap-1.5 ${
                                      badge.label === tag.label ? 'bg-muted/60' : ''
                                    }`}
                                    onClick={(e) => { e.stopPropagation(); setEngagementTag(contact.id, tag.score) }}
                                    disabled={savingTag}
                                  >
                                    <span className={`inline-block w-2 h-2 rounded-full ${tag.color.split(' ')[0]}`} />
                                    {tag.label}
                                  </button>
                                ))}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center justify-between mt-2 pt-2 border-t">
                            <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                              <Flame className="size-3" />
                              <span>{contact.engagementScore} pts</span>
                            </div>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); window.location.href = '/backend/contacts' }}
                              className="text-[10px] text-accent hover:text-accent/80 font-medium flex items-center gap-1 transition"
                              title="View full profile"
                            >
                              View Profile <ExternalLink className="size-2.5" />
                            </button>
                          </div>
                        </div>
                      )
                    })}
                    {stage.contacts.length === 0 && (
                      <div className="flex flex-col items-center justify-center py-8 text-center">
                        <Users className="size-5 text-muted-foreground/30 mb-2" />
                        <p className="text-xs text-muted-foreground/60">No contacts</p>
                      </div>
                    )}
                  </div>
                </div>
              ))
            ) : (
              dealStages.map(stage => (
                <div key={stage.name} className="flex flex-col w-72 shrink-0 rounded-lg border bg-card">
                  <div className="flex items-center justify-between px-3 py-2.5 border-b">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold">{stage.name}</h3>
                      <span className="text-[10px] font-medium bg-muted px-1.5 py-0.5 rounded-full tabular-nums">
                        {stage.count}
                      </span>
                    </div>
                    {stage.totalValue > 0 && (
                      <span className="text-[10px] text-muted-foreground font-medium tabular-nums">
                        ${stage.totalValue.toLocaleString()}
                      </span>
                    )}
                  </div>

                  <div className="flex-1 overflow-y-auto p-2 space-y-2">
                    {stage.deals.map(deal => (
                      <div key={deal.id} className="rounded-lg border bg-background p-3 hover:border-accent/40 transition cursor-pointer"
                        onClick={() => window.location.href = `/backend/customers/deals/${deal.id}`}
                      >
                        <p className="text-sm font-medium truncate">{deal.title}</p>
                        {deal.contact_name && (
                          <p className="text-[11px] text-muted-foreground truncate mt-0.5">{deal.contact_name}</p>
                        )}
                        <div className="flex items-center justify-between mt-2 pt-2 border-t">
                          {deal.value_amount ? (
                            <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                              <DollarSign className="size-3" />
                              <span>{deal.value_amount.toLocaleString()}</span>
                            </div>
                          ) : (
                            <span />
                          )}
                          <span className="text-[10px] text-muted-foreground">
                            {new Date(deal.updated_at).toLocaleDateString()}
                          </span>
                        </div>
                      </div>
                    ))}
                    {stage.deals.length === 0 && (
                      <div className="flex flex-col items-center justify-center py-8 text-center">
                        <DollarSign className="size-5 text-muted-foreground/30 mb-2" />
                        <p className="text-xs text-muted-foreground/60">No deals</p>
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Contact Detail Panel */}
        {selectedContact && (
          <div className="w-80 shrink-0 border-l bg-card overflow-y-auto animate-slide-in">
            <div className="flex items-center justify-between px-4 py-3 border-b sticky top-0 bg-card z-10">
              <h3 className="text-sm font-semibold truncate">{selectedContact.displayName}</h3>
              <div className="flex items-center gap-1 shrink-0">
                <button type="button" onClick={() => window.location.href = '/backend/contacts'}
                  className="p-1.5 rounded hover:bg-muted transition" title="View full profile">
                  <ExternalLink className="size-3.5 text-muted-foreground" />
                </button>
                <button type="button" onClick={() => setSelectedContact(null)}
                  className="p-1.5 rounded hover:bg-muted transition" title="Close">
                  <X className="size-3.5 text-muted-foreground" />
                </button>
              </div>
            </div>

            {loadingDetail ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="p-4 space-y-4">
                {/* Contact Info */}
                <div className="space-y-2.5">
                  {selectedContact.primaryEmail && (
                    <div className="flex items-center gap-2 text-sm">
                      <Mail className="size-3.5 text-muted-foreground shrink-0" />
                      <a href={`mailto:${selectedContact.primaryEmail}`} className="text-accent hover:underline truncate">
                        {selectedContact.primaryEmail}
                      </a>
                    </div>
                  )}
                  {selectedContact.primaryPhone && (
                    <div className="flex items-center gap-2 text-sm">
                      <Phone className="size-3.5 text-muted-foreground shrink-0" />
                      <a href={`tel:${selectedContact.primaryPhone}`} className="hover:underline">
                        {selectedContact.primaryPhone}
                      </a>
                    </div>
                  )}
                  {selectedContact.jobTitle && (
                    <div className="flex items-center gap-2 text-sm">
                      <Briefcase className="size-3.5 text-muted-foreground shrink-0" />
                      <span className="text-foreground/80">{selectedContact.jobTitle}</span>
                    </div>
                  )}
                  {selectedContact.createdAt && (
                    <div className="flex items-center gap-2 text-sm">
                      <Calendar className="size-3.5 text-muted-foreground shrink-0" />
                      <span className="text-foreground/80">Added {new Date(selectedContact.createdAt).toLocaleDateString()}</span>
                    </div>
                  )}
                </div>

                {/* Stage & Score */}
                <div className="grid grid-cols-2 gap-2">
                  {selectedContact.lifecycleStage && (
                    <div className="rounded-lg border px-3 py-2">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">Stage</p>
                      <p className="text-sm font-medium">{selectedContact.lifecycleStage}</p>
                    </div>
                  )}
                  {selectedContact.engagementScore !== null && (() => {
                    const currentBadge = getScoreBadge(selectedContact.engagementScore ?? 0)
                    return (
                      <div className="rounded-lg border px-3 py-2 relative">
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Temperature</p>
                        <div className="relative group/temp">
                          <button type="button" className={`text-xs font-medium px-2 py-1 rounded flex items-center gap-1.5 hover:ring-1 hover:ring-accent/40 transition ${currentBadge.color}`}>
                            <Flame className="size-3" />
                            {currentBadge.label}
                            <svg className="size-3 opacity-50" viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 6l3.5 4 3.5-4z"/></svg>
                          </button>
                          <div className="absolute left-0 top-full mt-1 bg-background border rounded-md shadow-lg py-1 z-20 hidden group-hover/temp:block min-w-[100px]">
                            {ENGAGEMENT_TAGS.map(tag => (
                              <button
                                key={tag.label}
                                type="button"
                                className={`w-full text-left px-3 py-1.5 text-xs font-medium hover:bg-muted transition flex items-center gap-2 ${
                                  currentBadge.label === tag.label ? 'bg-muted/60' : ''
                                }`}
                                onClick={() => setEngagementTag(selectedContact.id, tag.score)}
                                disabled={savingTag}
                              >
                                <span className={`inline-block w-2 h-2 rounded-full ${tag.color.split(' ')[0]}`} />
                                {tag.label}
                                {currentBadge.label === tag.label && <span className="ml-auto text-accent">&#10003;</span>}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    )
                  })()}
                  {selectedContact.source && (
                    <div className="rounded-lg border px-3 py-2">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">Source</p>
                      <p className="text-sm font-medium">{selectedContact.source}</p>
                    </div>
                  )}
                </div>

                {/* Notes */}
                {selectedContact.notes.length > 0 && (
                  <div>
                    <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
                      <FileText className="size-3" /> Notes
                    </h4>
                    <div className="space-y-2">
                      {selectedContact.notes.map(note => (
                        <div key={note.id} className="rounded-lg border px-3 py-2">
                          <p className="text-xs text-foreground/80 leading-relaxed">{note.content}</p>
                          <p className="text-[10px] text-muted-foreground mt-1">
                            {new Date(note.created_at).toLocaleDateString()}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

              </div>
            )}
          </div>
        )}
      </div>

      {showCreateDeal && (
        <CreateDealModal
          onClose={() => setShowCreateDeal(false)}
          onCreated={() => { setShowCreateDeal(false); loadPipelineMode() }}
        />
      )}
    </div>
  )
}
