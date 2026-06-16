'use client'

import { useState, useCallback } from 'react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@open-mercato/ui/primitives/tabs'
import InboxSettings from './InboxSettings'
import ConversationsView from './ConversationsView'

// The unified inbox is a two-tab surface: Conversations (the email-style reading
// experience, in ConversationsView) + Settings (InboxSettings). The Conversations
// tab owns all of its own conversation state + data fetching; this page only
// wires the tab switcher and passes a couple of cross-tab callbacks.
export default function UnifiedInboxPage() {
  const [tab, setTab] = useState<'conversations' | 'settings'>('conversations')

  // The Settings tab manages the AI reply assistant config; let the
  // Conversations tab know when it changes (it does not draft inline, so this is
  // a no-op hook for now, kept for parity with the old wiring).
  const onAiSettingsSaved = useCallback(() => {}, [])

  return (
    // Full-height surface that fills the AppShell content area exactly: height =
    // viewport minus header(~58) + footer(~45) + main padding(48), and a negative
    // top margin trims the gap above the tabs (kept consistent so the bottom still
    // meets the footer — no outer page scroll, no dead space). svh = smallest
    // viewport so the mobile toolbar can't push it past the fold.
    <div className="-mt-3 lg:-mt-5 flex flex-col h-[calc(100svh-115px)] lg:h-[calc(100svh-131px)] min-h-0 overflow-hidden">
      <Tabs value={tab} onValueChange={(v) => setTab(v as 'conversations' | 'settings')} className="flex flex-col flex-1 min-h-0">
        <div className="px-4 pt-2 border-b shrink-0">
          <TabsList>
            <TabsTrigger value="conversations">Conversations</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="conversations" className="flex-1 min-h-0 flex flex-col">
          <ConversationsView
            onAiSettingsSaved={onAiSettingsSaved}
            onGoToSettings={() => setTab('settings')}
          />
        </TabsContent>

        <TabsContent value="settings" className="flex-1 min-h-0 overflow-y-auto">
          <InboxSettings onAiSettingsSaved={onAiSettingsSaved} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
