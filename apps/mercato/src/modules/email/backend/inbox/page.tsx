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
    // Deterministic full-height surface (same pattern as the assistant/chat pages:
    // h-[calc(100dvh-Xpx)] + overflow-hidden). The inbox owns its own internal
    // scroll so there's no dead space below the list/reader. dvh keeps the mobile
    // toolbar accounted for.
    <div className="flex flex-col h-[calc(100dvh-64px)] min-h-0 overflow-hidden">
      <Tabs value={tab} onValueChange={(v) => setTab(v as 'conversations' | 'settings')} className="flex flex-col flex-1 min-h-0">
        <div className="px-4 pt-2 border-b shrink-0">
          <TabsList>
            <TabsTrigger value="conversations">Conversations</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="conversations" className="flex-1 min-h-0">
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
