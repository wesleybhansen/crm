'use client'

import { useState } from 'react'
import { Mail, Zap, Users } from 'lucide-react'
import CampaignsPage from '../campaigns/page'
import ListsTab from './ListsTab'

// Lazy-load sequences to avoid bundling everything upfront
import dynamic from 'next/dynamic'
const SequencesPage = dynamic(
  () => import('@/modules/sequences/backend/sequences/page'),
  { loading: () => <div className="p-6 text-sm text-muted-foreground">Loading sequences...</div> }
)

type Tab = 'campaigns' | 'sequences' | 'lists'

export default function EmailMarketingPage() {
  const [tab, setTab] = useState<Tab>('campaigns')

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-lg font-semibold">Email Marketing</h1>
        <p className="text-xs text-muted-foreground mt-0.5">Email blasts, automated sequences, and mailing lists</p>
      </div>

      <div className="flex gap-4 mb-6" role="tablist" aria-label="Email marketing sections">
        {([
          { id: 'campaigns' as Tab, label: 'Blasts', icon: Mail },
          { id: 'sequences' as Tab, label: 'Sequences', icon: Zap },
          { id: 'lists' as Tab, label: 'Lists', icon: Users },
        ]).map(t => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 min-h-10 sm:min-h-0 text-sm font-medium pb-1 border-b-2 transition ${
              tab === t.id ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}>
            <t.icon className="size-4" /> {t.label}
          </button>
        ))}
      </div>

      {tab === 'campaigns' && <CampaignsPage embedded />}
      {tab === 'sequences' && <SequencesPage embedded />}
      {tab === 'lists' && <ListsTab />}
    </div>
  )
}
