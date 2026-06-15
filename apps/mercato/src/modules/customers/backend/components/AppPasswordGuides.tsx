'use client'

import { useState } from 'react'
import { Mail, Inbox, AtSign } from 'lucide-react'

/**
 * Shared, self-contained App Password setup guides.
 * Renders four collapsible per-provider dropdowns (Gmail, Outlook, Yahoo/iCloud/other)
 * with step-by-step instructions. Manages its own open/close state, no props required.
 * Used in both Settings (Email section) and the Customer Service tab so the guides stay in sync.
 */
export default function AppPasswordGuides() {
  const [openGuide, setOpenGuide] = useState<'gmail' | 'outlook' | 'other' | null>(null)

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-foreground mb-2">How to get your App Password — select your provider:</p>

      {/* Gmail */}
      <div className="rounded-md border overflow-hidden">
        <button
          type="button"
          className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium hover:bg-muted/50 transition-colors"
          onClick={() => setOpenGuide(g => g === 'gmail' ? null : 'gmail')}
        >
          <span className="flex items-center gap-2">
            <Mail className="size-4 text-muted-foreground shrink-0" /> Gmail
          </span>
          <span className="text-muted-foreground">{openGuide === 'gmail' ? '▲' : '▼'}</span>
        </button>
        {openGuide === 'gmail' && (
          <div className="px-3 pb-3 pt-1 text-xs text-muted-foreground space-y-1.5 bg-muted/20 border-t">
            <p className="font-medium text-foreground">You need 2-Step Verification enabled first:</p>
            <ol className="space-y-1 list-none">
              <li><span className="font-medium text-foreground">1.</span> Go to <span className="font-mono bg-muted px-1 rounded">myaccount.google.com</span></li>
              <li><span className="font-medium text-foreground">2.</span> Click <strong>Security</strong> in the left sidebar</li>
              <li><span className="font-medium text-foreground">3.</span> Under <strong>"How you sign in to Google"</strong>, confirm <strong>2-Step Verification</strong> shows as On. If it's off, click it and follow the steps to turn it on (you'll need your phone).</li>
              <li><span className="font-medium text-foreground">4.</span> Once 2-Step Verification is on, use the <strong>search bar at the top</strong> of myaccount.google.com and search <strong>"App Passwords"</strong> — it won't appear in the menu, search is the easiest way to find it</li>
              <li><span className="font-medium text-foreground">5.</span> You may be asked to re-enter your Google password</li>
              <li><span className="font-medium text-foreground">6.</span> In the <strong>App name</strong> box, type <strong>Noli CRM</strong></li>
              <li><span className="font-medium text-foreground">7.</span> Click <strong>Create</strong></li>
              <li><span className="font-medium text-foreground">8.</span> Google shows a <strong>16-character password</strong> in a yellow box (looks like: <span className="font-mono bg-muted px-1 rounded">xxxx xxxx xxxx xxxx</span>)</li>
              <li><span className="font-medium text-foreground">9.</span> Copy that password — <strong>you only see it once</strong></li>
              <li><span className="font-medium text-foreground">10.</span> Paste it into the App Password field above. Spaces are fine.</li>
            </ol>
            <p className="text-[#b45309] dark:text-[#fbbf24] pt-1">⚠️ If you don't see App Passwords after enabling 2-Step Verification, your Google Workspace admin may have disabled it — contact them or use a personal Gmail account.</p>
          </div>
        )}
      </div>

      {/* Outlook */}
      <div className="rounded-md border overflow-hidden">
        <button
          type="button"
          className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium hover:bg-muted/50 transition-colors"
          onClick={() => setOpenGuide(g => g === 'outlook' ? null : 'outlook')}
        >
          <span className="flex items-center gap-2">
            <Inbox className="size-4 text-muted-foreground shrink-0" /> Outlook / Hotmail / Microsoft 365
          </span>
          <span className="text-muted-foreground">{openGuide === 'outlook' ? '▲' : '▼'}</span>
        </button>
        {openGuide === 'outlook' && (
          <div className="px-3 pb-3 pt-1 text-xs text-muted-foreground space-y-1.5 bg-muted/20 border-t">
            <p className="font-medium text-foreground">You need two-step verification enabled first:</p>
            <ol className="space-y-1 list-none">
              <li><span className="font-medium text-foreground">1.</span> Go to <span className="font-mono bg-muted px-1 rounded">account.microsoft.com</span></li>
              <li><span className="font-medium text-foreground">2.</span> Click <strong>Security</strong> in the top navigation</li>
              <li><span className="font-medium text-foreground">3.</span> Click <strong>Advanced security options</strong></li>
              <li><span className="font-medium text-foreground">4.</span> Under <strong>"Two-step verification"</strong>, make sure it's turned on. If not, click <strong>Turn on</strong> and follow the steps.</li>
              <li><span className="font-medium text-foreground">5.</span> Scroll down to <strong>"App passwords"</strong> and click <strong>Create a new app password</strong></li>
              <li><span className="font-medium text-foreground">6.</span> Microsoft generates a password automatically — copy it</li>
              <li><span className="font-medium text-foreground">7.</span> Paste it into the App Password field above</li>
            </ol>
            <p className="text-[#b45309] dark:text-[#fbbf24] pt-1">⚠️ Microsoft 365 business accounts may have app passwords disabled by your IT admin. If you don't see the option, ask your admin or try a personal Outlook/Hotmail account.</p>
          </div>
        )}
      </div>

      {/* Other */}
      <div className="rounded-md border overflow-hidden">
        <button
          type="button"
          className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium hover:bg-muted/50 transition-colors"
          onClick={() => setOpenGuide(g => g === 'other' ? null : 'other')}
        >
          <span className="flex items-center gap-2">
            <AtSign className="size-4 text-muted-foreground shrink-0" /> Yahoo, iCloud, or other providers
          </span>
          <span className="text-muted-foreground">{openGuide === 'other' ? '▲' : '▼'}</span>
        </button>
        {openGuide === 'other' && (
          <div className="px-3 pb-3 pt-1 text-xs text-muted-foreground space-y-2 bg-muted/20 border-t">
            <div>
              <p className="font-medium text-foreground mb-1">Yahoo Mail:</p>
              <ol className="space-y-1 list-none">
                <li><span className="font-medium text-foreground">1.</span> Go to <span className="font-mono bg-muted px-1 rounded">login.yahoo.com</span> → click your name → <strong>Account Security</strong></li>
                <li><span className="font-medium text-foreground">2.</span> Enable <strong>Two-step verification</strong> if not already on</li>
                <li><span className="font-medium text-foreground">3.</span> Scroll to <strong>"Generate app password"</strong>, select <strong>Other App</strong>, type <strong>Noli CRM</strong>, click <strong>Generate</strong></li>
                <li><span className="font-medium text-foreground">4.</span> Copy the password shown and paste it above</li>
              </ol>
            </div>
            <div>
              <p className="font-medium text-foreground mb-1">iCloud Mail:</p>
              <ol className="space-y-1 list-none">
                <li><span className="font-medium text-foreground">1.</span> Go to <span className="font-mono bg-muted px-1 rounded">appleid.apple.com</span></li>
                <li><span className="font-medium text-foreground">2.</span> Sign in → click <strong>Sign-In and Security</strong></li>
                <li><span className="font-medium text-foreground">3.</span> Click <strong>App-Specific Passwords</strong> → <strong>Generate an app-specific password</strong></li>
                <li><span className="font-medium text-foreground">4.</span> Enter a label like <strong>Noli CRM</strong> → click <strong>Create</strong></li>
                <li><span className="font-medium text-foreground">5.</span> Copy the password and paste it above. Use your full iCloud email (e.g. you@icloud.com).</li>
              </ol>
            </div>
            <div>
              <p className="font-medium text-foreground mb-1">Custom / business email (GoDaddy, Namecheap, Zoho, etc.):</p>
              <p>Use your regular email password — most hosting providers support standard IMAP/SMTP without requiring an App Password. If the connection fails, check that IMAP is enabled in your email provider's settings.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
