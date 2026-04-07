'use client'

import { useState, FormEvent } from 'react'
import Link from 'next/link'
import '../auth-shell.css'

type Org = { tenantId: string; orgId: string; orgName: string }

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [orgs, setOrgs] = useState<Org[]>([])
  const [showOrgPicker, setShowOrgPicker] = useState(false)

  async function handleSubmit(e: FormEvent, tenantId?: string) {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const form = new FormData()
      form.append('email', email)
      form.append('password', password)
      if (remember) form.append('remember', 'on')
      if (tenantId) form.append('tenantId', tenantId)

      const res = await fetch('/api/auth/login', { method: 'POST', body: form })
      const data = await res.json()
      if (data.ok) {
        window.location.href = data.redirect || '/backend'
      } else if (data.needsOrgPicker && data.orgs) {
        setOrgs(data.orgs)
        setShowOrgPicker(true)
      } else {
        setError(data.error || 'Invalid email or password')
      }
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  function selectOrg(tenantId: string) {
    setShowOrgPicker(false)
    setLoading(true)
    const form = new FormData()
    form.append('email', email)
    form.append('password', password)
    if (remember) form.append('remember', 'on')
    form.append('tenantId', tenantId)
    fetch('/api/auth/login', { method: 'POST', body: form })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) {
          window.location.href = data.redirect || '/backend'
        } else {
          setError(data.error || 'Login failed')
          setLoading(false)
        }
      })
      .catch(() => {
        setError('Something went wrong')
        setLoading(false)
      })
  }

  return (
    <div className="auth-page">
      <div className="auth-atmosphere" />
      <div className="auth-grid-fade" />

      <div className="auth-topbar">
        <Link href="/" className="auth-logo">
          <div className="auth-logo-mark" />
          Launch OS
        </Link>
        <Link href="/" className="auth-back">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M19 12H5M11 18l-6-6 6-6" />
          </svg>
          Back to home
        </Link>
      </div>

      <main className="auth-main">
        <div className="auth-card">
          <div className="auth-card-mark" />

          {showOrgPicker ? (
            <>
              <h1>Choose a workspace.</h1>
              <p className="auth-sub">Your email is associated with multiple workspaces.</p>
              <div className="auth-form">
                {orgs.map((org) => (
                  <button
                    key={org.tenantId}
                    type="button"
                    onClick={() => selectOrg(org.tenantId)}
                    disabled={loading}
                    className="auth-org-pick"
                  >
                    {org.orgName}
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                  </button>
                ))}
              </div>
              <div className="auth-footer-line">
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault()
                    setShowOrgPicker(false)
                    setOrgs([])
                  }}
                >
                  ← Back to login
                </a>
              </div>
            </>
          ) : (
            <>
              <h1>Welcome back, rockstar.</h1>
              <p className="auth-sub">Sign in to your Launch OS workspace.</p>

              <form className="auth-form" onSubmit={handleSubmit} noValidate>
                {error && <div className="auth-error" role="alert">{error}</div>}

                <div className="auth-field">
                  <label htmlFor="email">Email</label>
                  <input
                    id="email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@yourbusiness.com"
                    autoComplete="email"
                  />
                </div>

                <div className="auth-field">
                  <label htmlFor="password">Password</label>
                  <input
                    id="password"
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••••"
                    autoComplete="current-password"
                  />
                </div>

                <div className="auth-row">
                  <label className="auth-checkbox-label">
                    <input
                      type="checkbox"
                      checked={remember}
                      onChange={(e) => setRemember(e.target.checked)}
                    />
                    Remember me
                  </label>
                  <Link href="/forgot-password" className="auth-link">
                    Forgot password?
                  </Link>
                </div>

                <button type="submit" className="auth-submit" disabled={loading}>
                  {loading ? 'Signing in…' : 'Log in to Launch OS'}
                  {!loading && (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                  )}
                </button>
              </form>

              <div className="auth-footer-line">
                Don&apos;t have a workspace yet? <Link href="/signup">Become a founding operator →</Link>
              </div>
            </>
          )}
        </div>
      </main>

      <footer className="auth-bottom">
        <div className="auth-bottom-links">
          <Link href="/terms">Terms</Link>
          <span>·</span>
          <Link href="/privacy">Privacy</Link>
        </div>
        <div className="auth-bottom-copy">© {new Date().getFullYear()} The Launch Pad LLC</div>
      </footer>
    </div>
  )
}
