'use client'

import { useState, useEffect, useRef } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Loader2, Users, DollarSign, GripVertical, Flame, Plus, ExternalLink } from 'lucide-react'

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

export default function PipelinePage() {
  const [mode, setMode] = useState<PipelineMode | null>(null)
  const [loading, setLoading] = useState(true)
  const [journeyStages, setJourneyStages] = useState<JourneyStage[]>([])
  const [dealStages, setDealStages] = useState<DealStage[]>([])
  const [dragging, setDragging] = useState<{ id: string; stage: string } | null>(null)
  const [dragOverStage, setDragOverStage] = useState<string | null>(null)
  const [movingId, setMovingId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    loadPipelineMode()
  }, [])

  async function loadPipelineMode() {
    setLoading(true)
    try {
      const res = await fetch('/api/business-profile', { credentials: 'include' })
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
      // Get pipeline stages from business profile
      let stageNames: string[] = ['Lead', 'Qualified', 'Proposal', 'Negotiation', 'Closed Won']
      if (profile?.pipeline_stages) {
        const parsed = typeof profile.pipeline_stages === 'string'
          ? JSON.parse(profile.pipeline_stages)
          : profile.pipeline_stages
        if (Array.isArray(parsed) && parsed.length >= 2) {
          stageNames = parsed.map((s: any) => typeof s === 'string' ? s : s.name).filter(Boolean)
        }
      }

      // Get all open deals
      const res = await fetch('/api/ext/deals?status=open&pageSize=100', { credentials: 'include' })
      const data = await res.json()
      const deals: DealCard[] = data.ok ? (data.data || []) : []

      // Group by pipeline_stage
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
        </div>
        <div className="flex items-center gap-2">
          {mode === 'journey' ? (
            <Button type="button" variant="outline" size="sm"
              onClick={() => window.location.href = '/backend/contacts'}>
              <Plus className="size-3.5 mr-1.5" /> Add Contact
            </Button>
          ) : (
            <Button type="button" variant="outline" size="sm"
              onClick={() => window.location.href = '/backend/contacts'}>
              <Plus className="size-3.5 mr-1.5" /> Create Deal
            </Button>
          )}
        </div>
      </div>

      {/* Kanban Board */}
      <div ref={scrollRef} className="flex-1 overflow-x-auto overflow-y-hidden">
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
                {/* Stage Header */}
                <div className="flex items-center justify-between px-3 py-2.5 border-b">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold">{stage.name}</h3>
                    <span className="text-[10px] font-medium bg-muted px-1.5 py-0.5 rounded-full tabular-nums">
                      {stage.count}
                    </span>
                  </div>
                </div>

                {/* Cards */}
                <div className="flex-1 overflow-y-auto p-2 space-y-2">
                  {stage.contacts.map(contact => {
                    const badge = getScoreBadge(contact.engagementScore)
                    return (
                      <div
                        key={contact.id}
                        draggable
                        onDragStart={() => handleDragStart(contact.id, stage.name)}
                        className={`rounded-lg border bg-background p-3 cursor-grab active:cursor-grabbing hover:border-accent/40 transition group ${
                          movingId === contact.id ? 'opacity-50' : ''
                        } ${dragging?.id === contact.id ? 'opacity-40 border-dashed' : ''}`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium truncate">{contact.displayName}</p>
                            {contact.primaryEmail && (
                              <p className="text-[11px] text-muted-foreground truncate mt-0.5">{contact.primaryEmail}</p>
                            )}
                          </div>
                          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${badge.color}`}>
                            {badge.label}
                          </span>
                        </div>
                        <div className="flex items-center justify-between mt-2 pt-2 border-t">
                          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                            <Flame className="size-3" />
                            <span>{contact.engagementScore} pts</span>
                          </div>
                          <button
                            type="button"
                            onClick={() => window.location.href = '/backend/contacts'}
                            className="text-[10px] text-muted-foreground hover:text-accent flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition"
                          >
                            View <ExternalLink className="size-2.5" />
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
                {/* Stage Header */}
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

                {/* Deal Cards */}
                <div className="flex-1 overflow-y-auto p-2 space-y-2">
                  {stage.deals.map(deal => (
                    <div key={deal.id} className="rounded-lg border bg-background p-3 hover:border-accent/40 transition">
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
    </div>
  )
}
