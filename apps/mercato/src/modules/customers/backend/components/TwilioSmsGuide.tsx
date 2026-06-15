'use client'

import { useState } from 'react'
import { MessageSquare } from 'lucide-react'

/**
 * Self-contained "How to set up your Twilio support number" guide.
 * Mirrors AppPasswordGuides: a single collapsible disclosure with a lucide icon
 * header, an ordered step list, and muted helper text. Manages its own open
 * state, no props required. Rendered in the Customer service SMS number section.
 */
export default function TwilioSmsGuide() {
  const [open, setOpen] = useState(false)

  return (
    <div className="space-y-1">
      <div className="rounded-md border overflow-hidden">
        <button
          type="button"
          className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium hover:bg-muted/50 transition-colors"
          onClick={() => setOpen(v => !v)}
        >
          <span className="flex items-center gap-2">
            <MessageSquare className="size-4 text-muted-foreground shrink-0" /> How to set up your Twilio support number
          </span>
          <span className="text-muted-foreground">{open ? '▲' : '▼'}</span>
        </button>
        {open && (
          <div className="px-3 pb-3 pt-1 text-xs text-muted-foreground space-y-1.5 bg-muted/20 border-t">
            <p className="font-medium text-foreground">Follow these steps to point a Twilio number at Noli:</p>
            <ol className="space-y-1.5 list-none">
              <li><span className="font-medium text-foreground">1.</span> Create or log into a Twilio account at <span className="font-mono bg-muted px-1 rounded">twilio.com</span>.</li>
              <li><span className="font-medium text-foreground">2.</span> Buy a phone number for support (<strong>Console</strong> -&gt; <strong>Phone Numbers</strong> -&gt; <strong>Manage</strong> -&gt; <strong>Buy a number</strong>). Use a different number than your inbox number.</li>
              <li><span className="font-medium text-foreground">3.</span> US numbers: register A2P 10DLC (<strong>Console</strong> -&gt; <strong>Messaging</strong> -&gt; <strong>Regulatory Compliance</strong>) so carriers do not block your texts. This is required for US business SMS and can take a few days.</li>
              <li><span className="font-medium text-foreground">4.</span> Connect Twilio to Noli CRM: from the Twilio Console dashboard copy your <strong>Account SID</strong> and <strong>Auth Token</strong> and add them in your CRM Twilio connection. If you already use SMS in the Inbox, you are already connected.</li>
              <li><span className="font-medium text-foreground">5.</span> Point the support number at Noli: <strong>Console</strong> -&gt; <strong>Phone Numbers</strong> -&gt; your support number -&gt; <strong>Messaging</strong> -&gt; <strong>"A message comes in"</strong> -&gt; <strong>Webhook</strong> -&gt; paste <span className="font-mono bg-muted px-1 rounded break-all">https://crm.noliai.com/api/sms/webhook</span> , method <strong>POST</strong> -&gt; <strong>Save</strong>.</li>
              <li><span className="font-medium text-foreground">6.</span> Enter that number in the "Customer service SMS number" field above.</li>
            </ol>
            <p className="text-[#b45309] dark:text-[#fbbf24] pt-1">Use a number that is different from the one your Inbox uses, so support texts and inbox texts stay separate.</p>
          </div>
        )}
      </div>
    </div>
  )
}
