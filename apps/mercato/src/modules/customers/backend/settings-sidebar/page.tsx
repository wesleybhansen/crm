'use client'

import { useCallback, useEffect, useState } from 'react'
import { apiCall, apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Spinner } from '@open-mercato/ui/primitives/spinner'

type SidebarPrefs = { hidden: string[] }

/**
 * Customize what appears in the sidebar. Stores a per-user list of hrefs
 * to hide in the `crm_hidden_sidebar` cookie — applies in both simple and
 * advanced mode (SPEC-063 Phase 3). Items stay accessible via direct URL;
 * only the nav entry is removed. Clearing the list restores defaults.
 */
export default function SidebarSettingsPage() {
  const [hidden, setHidden] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [newPath, setNewPath] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const res = await apiCall<SidebarPrefs>('/api/preferences/sidebar', undefined, { fallback: { hidden: [] } })
    setHidden(res?.result?.hidden ?? [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  async function save(next: string[]) {
    setSaving(true)
    setMessage(null)
    try {
      await apiCallOrThrow('/api/preferences/sidebar', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden: next }),
      })
      setHidden(next)
      setMessage('Saved. Reload the page to see the change in the sidebar.')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = newPath.trim()
    if (!trimmed) return
    const normalized = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
    if (hidden.includes(normalized)) { setMessage('Already hidden.'); return }
    save([...hidden, normalized])
    setNewPath('')
  }

  function handleUnhide(path: string) {
    save(hidden.filter((p) => p !== path))
  }

  function handleReset() {
    if (!confirm('Restore sidebar to defaults? Any items you hid will come back.')) return
    save([])
  }

  if (loading) return <div className="p-6"><Spinner className="h-4 w-4" /></div>

  return (
    <div className="mx-auto max-w-3xl px-6 py-6 space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Customize sidebar</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Hide sidebar items you don't use. Items stay accessible via direct URL — only the nav entry is removed. Works in both simple and advanced mode.
        </p>
      </header>

      {message && (
        <div className="rounded-lg border bg-accent/5 px-3 py-2 text-xs text-muted-foreground">{message}</div>
      )}

      <section className="rounded-xl border bg-card p-5">
        <h2 className="mb-3 text-sm font-semibold">Hide a sidebar item</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Enter the URL path of the item you want to hide. Example: <code className="rounded bg-muted px-1">/backend/affiliates</code>. You can find the path by hovering over the sidebar link.
        </p>
        <form onSubmit={handleAdd} className="flex gap-2">
          <Input
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            placeholder="/backend/..."
            className="h-9 text-sm"
          />
          <Button type="submit" size="sm" disabled={saving || !newPath.trim()}>Hide</Button>
        </form>
      </section>

      <section className="rounded-xl border bg-card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Currently hidden ({hidden.length})</h2>
          {hidden.length > 0 && (
            <Button type="button" size="sm" variant="outline" onClick={handleReset}>Reset to defaults</Button>
          )}
        </div>
        {hidden.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing hidden. Your sidebar is showing everything you're allowed to see.</p>
        ) : (
          <ul className="space-y-1.5">
            {hidden.map((path) => (
              <li key={path} className="flex items-center justify-between rounded-md border px-3 py-2 text-xs">
                <code className="font-mono">{path}</code>
                <Button type="button" size="sm" variant="outline" onClick={() => handleUnhide(path)}>Unhide</Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
