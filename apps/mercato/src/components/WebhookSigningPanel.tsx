'use client'

import { useEffect, useState } from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Check, Copy, KeyRound, Loader2 } from 'lucide-react'

/**
 * The signing secret for automation "Webhook" steps, and how a receiver checks
 * a request. The secret is one per business, stored sealed, and shown once:
 * right after it is created or replaced, or (when a webhook already made one
 * before this panel was opened) on a single "Show secret" click.
 * Server: /api/sequences/automation-rules/webhook-secret.
 */

type Status = { exists: boolean; createdAt: string | null; revealed: boolean }

const ENDPOINT = '/api/sequences/automation-rules/webhook-secret'

const VERIFY_SNIPPET = `const crypto = require('crypto')
// rawBody: the request body exactly as received, before JSON parsing
const ts = req.headers['x-noli-timestamp']
const got = Buffer.from(req.headers['x-noli-signature'] || '')
const want = Buffer.from('sha256=' + crypto
  .createHmac('sha256', process.env.NOLI_WEBHOOK_SECRET)
  .update(ts + '.' + rawBody)
  .digest('hex'))
const fresh = Math.abs(Date.now() / 1000 - Number(ts)) < 300
const valid = fresh && got.length === want.length && crypto.timingSafeEqual(got, want)`

function formatDate(value: string | null): string {
  if (!value) return ''
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString()
}

export function WebhookSigningPanel() {
  const [status, setStatus] = useState<Status | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [confirmReplace, setConfirmReplace] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch(ENDPOINT, { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        if (d?.ok) setStatus(d.data as Status)
        else setLoadError(d?.error || 'Could not load the signing secret')
      })
      .catch(() => { if (!cancelled) setLoadError('Could not load the signing secret') })
    return () => { cancelled = true }
  }, [])

  async function act(action: 'rotate' | 'reveal') {
    setBusy(true)
    setError(null)
    setCopied(false)
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action }),
      })
      const d = await res.json().catch(() => ({}))
      if (d?.ok && d.data?.secret) {
        setSecret(String(d.data.secret))
        if (d.data.status) setStatus(d.data.status as Status)
        setConfirmReplace(false)
      } else {
        setError(d?.error || 'That did not work. Try again.')
        if (res.status === 409) setStatus((s) => (s ? { ...s, revealed: true } : s))
      }
    } catch {
      setError('That did not work. Try again.')
    }
    setBusy(false)
  }

  async function copy() {
    if (!secret) return
    try {
      await navigator.clipboard.writeText(secret)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="rounded-md border bg-muted/30 p-3 space-y-2.5">
      <div className="flex items-center gap-1.5">
        <KeyRound className="size-3.5 text-muted-foreground" aria-hidden />
        <p className="text-[11px] font-medium text-muted-foreground">Signing secret</p>
      </div>

      {!status && !loadError && (
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <Loader2 className="size-3 animate-spin" aria-hidden /> Loading...
        </p>
      )}
      {loadError && <p className="text-xs text-destructive">{loadError}</p>}

      {status && !secret && (
        <p className="text-xs text-foreground/80 leading-relaxed">
          {!status.exists
            ? 'Noli signs every webhook request with a secret only you and your receiver know. Create it here; it is shown once.'
            : status.revealed
              ? `Your signing secret was created ${formatDate(status.createdAt)} and has already been shown. If you no longer have it, replace it and update your receiver.`
              : 'Your webhooks are already signed with a secret that has not been shown yet. Show it once, then save it in your receiver.'}
        </p>
      )}

      {secret && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-foreground">Copy it now. It will not be shown again.</p>
          <div className="flex items-stretch gap-2">
            <code className="flex-1 min-w-0 break-all rounded-md border bg-background px-2.5 py-2 text-xs">{secret}</code>
            <Button type="button" variant="outline" size="sm" onClick={copy} className="shrink-0 h-auto">
              {copied ? <><Check className="size-3.5 mr-1" /> Copied</> : <><Copy className="size-3.5 mr-1" /> Copy</>}
            </Button>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}

      {status && (
        <div className="flex flex-wrap items-center gap-2">
          {!status.exists && (
            <Button type="button" size="sm" onClick={() => act('rotate')} disabled={busy}>
              {busy ? <Loader2 className="size-3 animate-spin mr-1.5" /> : null} Create signing secret
            </Button>
          )}
          {status.exists && !status.revealed && !secret && (
            <Button type="button" size="sm" onClick={() => act('reveal')} disabled={busy}>
              {busy ? <Loader2 className="size-3 animate-spin mr-1.5" /> : null} Show secret once
            </Button>
          )}
          {status.exists && !confirmReplace && (
            <Button type="button" variant="outline" size="sm" onClick={() => setConfirmReplace(true)} disabled={busy}>
              Replace secret
            </Button>
          )}
          {status.exists && confirmReplace && (
            <>
              <span className="text-xs text-foreground/80">The old secret stops working right away.</span>
              <Button type="button" size="sm" onClick={() => act('rotate')} disabled={busy}>
                {busy ? <Loader2 className="size-3 animate-spin mr-1.5" /> : null} Replace
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmReplace(false)} disabled={busy}>
                Cancel
              </Button>
            </>
          )}
        </div>
      )}

      <details className="group">
        <summary className="cursor-pointer text-xs font-medium text-foreground/80 hover:text-foreground">
          How your receiver checks a request
        </summary>
        <div className="mt-2 space-y-2 text-xs text-muted-foreground leading-relaxed">
          <p>
            Noli sends a POST with a JSON body and two headers: <code className="text-foreground">X-Noli-Timestamp</code> (Unix
            seconds) and <code className="text-foreground">X-Noli-Signature</code> (<code className="text-foreground">sha256=</code> followed
            by a hex code).
          </p>
          <p>
            To check it, compute an HMAC-SHA256 of the timestamp, a period, and the raw request body, with your signing secret as
            the key. Compare <code className="text-foreground">sha256=</code> plus that hex code to the header with a constant-time
            comparison, and reject the request if they differ or the timestamp is more than 5 minutes old.
          </p>
          <pre className="overflow-x-auto rounded-md border bg-background p-2.5 text-[11px] leading-snug text-foreground"><code>{VERIFY_SNIPPET}</code></pre>
        </div>
      </details>
    </div>
  )
}
