'use client'

import { useState, useEffect } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Settings, Monitor, Smartphone, Key, User, Moon, Sun, Check } from 'lucide-react'

export default function SimpleSettingsPage() {
  const [mode, setMode] = useState('simple')
  const [theme, setTheme] = useState('light')
  const [saved, setSaved] = useState(false)
  const [aiUsage, setAiUsage] = useState<{ callsUsed: number; callsCap: number; hasUserKey: boolean } | null>(null)
  const [byokKey, setByokKey] = useState('')
  const [savingKey, setSavingKey] = useState(false)

  useEffect(() => {
    // Read current mode from cookie
    const cookies = document.cookie.split(';').map(c => c.trim())
    const modeCookie = cookies.find(c => c.startsWith('crm_interface_mode='))
    if (modeCookie) setMode(modeCookie.split('=')[1])
    // Read theme
    setTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light')
    // Load AI usage
    fetch('/api/ai/usage', { credentials: 'include' })
      .then(r => r.json()).then(d => { if (d.ok) setAiUsage(d.data) }).catch(() => {})
  }, [])

  async function changeMode(newMode: string) {
    setMode(newMode)
    await fetch('/api/preferences/interface-mode', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ mode: newMode }),
    })
    setSaved(true)
    setTimeout(() => { setSaved(false); window.location.reload() }, 1000)
  }

  function toggleTheme() {
    const newTheme = theme === 'dark' ? 'light' : 'dark'
    setTheme(newTheme)
    if (newTheme === 'dark') {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
    localStorage.setItem('om-theme', newTheme)
  }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h1 className="text-lg font-semibold mb-6">Settings</h1>

      {saved && (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 dark:bg-emerald-900/20 dark:border-emerald-800 px-4 py-2 text-sm text-emerald-700 dark:text-emerald-400 flex items-center gap-2">
          <Check className="size-4" /> Settings saved. Reloading...
        </div>
      )}

      {/* Appearance */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Monitor className="size-4 text-muted-foreground" /> Appearance
        </h2>
        <div className="rounded-lg border divide-y">
          <div className="flex items-center justify-between px-4 py-3">
            <div>
              <p className="text-sm font-medium">Theme</p>
              <p className="text-xs text-muted-foreground">Switch between light and dark mode</p>
            </div>
            <button type="button" onClick={toggleTheme}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium hover:bg-muted/50 transition">
              {theme === 'dark' ? <Moon className="size-3.5" /> : <Sun className="size-3.5" />}
              {theme === 'dark' ? 'Dark' : 'Light'}
            </button>
          </div>
          <div className="flex items-center justify-between px-4 py-3">
            <div>
              <p className="text-sm font-medium">Interface Mode</p>
              <p className="text-xs text-muted-foreground">Simple mode shows essential features only. Advanced shows everything.</p>
            </div>
            <div className="flex gap-1.5">
              <button type="button" onClick={() => changeMode('simple')}
                className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition ${
                  mode === 'simple' ? 'border-accent bg-accent/5 text-accent' : 'hover:bg-muted/50 text-muted-foreground'
                }`}>Simple</button>
              <button type="button" onClick={() => changeMode('advanced')}
                className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition ${
                  mode === 'advanced' ? 'border-accent bg-accent/5 text-accent' : 'hover:bg-muted/50 text-muted-foreground'
                }`}>Advanced</button>
            </div>
          </div>
        </div>
      </section>

      {/* Account */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <User className="size-4 text-muted-foreground" /> Account
        </h2>
        <div className="rounded-lg border divide-y">
          <div className="flex items-center justify-between px-4 py-3">
            <div>
              <p className="text-sm font-medium">Profile</p>
              <p className="text-xs text-muted-foreground">Update your name, email, and password</p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => window.location.href = '/backend/profile'}>
              Edit Profile
            </Button>
          </div>
        </div>
      </section>

      {/* Calendar */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Settings className="size-4 text-muted-foreground" /> Calendar
        </h2>
        <div className="rounded-lg border divide-y">
          <div className="flex items-center justify-between px-4 py-3">
            <div>
              <p className="text-sm font-medium">Google Calendar</p>
              <p className="text-xs text-muted-foreground">Sync bookings with your Google Calendar</p>
              {new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '').get('google_connected') === 'true' && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-1 flex items-center gap-1"><Check className="size-3" /> Connected!</p>
              )}
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => window.location.href = '/api/google/auth'}>
              Connect Google Calendar
            </Button>
          </div>
        </div>
      </section>

      {/* API Keys */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Key className="size-4 text-muted-foreground" /> Integrations
        </h2>
        <div className="rounded-lg border divide-y">
          <div className="flex items-center justify-between px-4 py-3">
            <div>
              <p className="text-sm font-medium">API Keys</p>
              <p className="text-xs text-muted-foreground">Connect external tools like LaunchBot or Blog-Ops</p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => window.location.href = '/backend/api-keys'}>
              Manage Keys
            </Button>
          </div>
          <div className="px-4 py-3">
            <div className="flex items-center justify-between mb-2">
              <div>
                <p className="text-sm font-medium">AI Provider Key (BYOK)</p>
                <p className="text-xs text-muted-foreground">Add your own API key for unlimited AI features</p>
              </div>
            </div>
            <div className="flex gap-2">
              <Input value={byokKey} onChange={e => setByokKey(e.target.value)}
                type="password" placeholder={aiUsage?.hasUserKey ? '••••••••••••••••' : 'Paste your Gemini or OpenAI API key'}
                className="h-8 text-sm flex-1" />
              <Button type="button" variant="outline" size="sm"
                onClick={async () => {
                  setSavingKey(true)
                  await fetch('/api/ai/usage', {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
                    body: JSON.stringify({ userKey: byokKey }),
                  })
                  setByokKey('')
                  setSavingKey(false)
                  fetch('/api/ai/usage', { credentials: 'include' })
                    .then(r => r.json()).then(d => { if (d.ok) setAiUsage(d.data) })
                }}
                disabled={savingKey || !byokKey.trim()}>
                {savingKey ? 'Saving...' : 'Save'}
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* AI Usage */}
      {aiUsage && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <Monitor className="size-4 text-muted-foreground" /> AI Usage
          </h2>
          <div className="rounded-lg border p-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-medium">This month</p>
              <p className="text-sm tabular-nums">
                <span className="font-semibold">{aiUsage.callsUsed}</span>
                <span className="text-muted-foreground"> / {aiUsage.callsCap} calls</span>
              </p>
            </div>
            <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
              <div className="h-full rounded-full bg-accent transition-all"
                style={{ width: `${Math.min(100, (aiUsage.callsUsed / aiUsage.callsCap) * 100)}%` }} />
            </div>
            {aiUsage.callsUsed >= aiUsage.callsCap && !aiUsage.hasUserKey && (
              <p className="text-xs text-amber-600 dark:text-amber-400 mt-2">
                Limit reached. Add your own API key above to continue using AI features.
              </p>
            )}
            {aiUsage.hasUserKey && (
              <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-2 flex items-center gap-1">
                <Check className="size-3" /> Your own API key is active. Unlimited AI usage.
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
