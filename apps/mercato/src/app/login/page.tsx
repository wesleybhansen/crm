'use client'

import { Suspense, useEffect, useState, FormEvent } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import '../auth-shell.css'
import { AuthField, AuthParticles, ArrowLeftIcon, ArrowRightIcon, GoogleIcon } from '../auth-shared'

type Org = { tenantId: string; orgId: string; orgName: string }

export default function LoginPage() {
  return (
    <Suspense>
      <LoginInner />
    </Suspense>
  )
}

function LoginInner() {
  const searchParams = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [orgs, setOrgs] = useState<Org[]>([])
  const [showOrgPicker, setShowOrgPicker] = useState(false)

  useEffect(() => {
    const queryError = searchParams.get('error')
    if (queryError) setError(queryError)
  }, [searchParams])

  async function submit(e: FormEvent | null, tenantId?: string) {
    if (e) e.preventDefault()
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
        return
      }
      if (data.needsOrgPicker && data.orgs) {
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

  return (
    <div className="auth-page">
      <div className="auth-atmosphere" />
      <div className="auth-grid-fade" />
      <AuthParticles />

      <div className="auth-topbar">
        <Link href="/" className="auth-logo">
          <div className="auth-logo-mark" />
          Launch OS
        </Link>
        <Link href="/" className="auth-back">
          <ArrowLeftIcon />
          Back to home
        </Link>
      </div>

      <main className="auth-main">
        <div className="auth-card">
          <div className="auth-card-mark" />

          {showOrgPicker ? (
            <div className="auth-swap" key="picker">
              <h1>Choose a workspace.</h1>
              <p className="auth-sub">Your email is associated with multiple workspaces.</p>
              <div className="auth-form" style={{ gap: 10 }}>
                {orgs.map((org) => (
                  <button
                    key={org.tenantId}
                    type="button"
                    onClick={() => submit(null, org.tenantId)}
                    disabled={loading}
                    className="auth-org-pick"
                  >
                    {org.orgName}
                    <ArrowRightIcon />
                  </button>
                ))}
              </div>
              <div className="auth-footer-line">
                <a onClick={() => { setShowOrgPicker(false); setOrgs([]) }}>← Back to login</a>
              </div>
            </div>
          ) : (
            <div className="auth-swap" key="login">
              <h1>Welcome back, rockstar.</h1>
              <p className="auth-sub">Sign in to your Launch OS workspace.</p>

              <a href="/api/auth/google/start" className="auth-google">
                <GoogleIcon />
                Continue with Google
              </a>

              <div className="auth-divider">or</div>

              <form className="auth-form" onSubmit={(e) => submit(e)} noValidate>
                {error && <div className="auth-error" role="alert">{error}</div>}

                <AuthField id="email" label="Email" type="email" value={email} onChange={setEmail} required autoComplete="email" />
                <AuthField id="password" label="Password" type="password" value={password} onChange={setPassword} required autoComplete="current-password" />

                <div className="auth-row">
                  <label className="auth-checkbox-label">
                    <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                    Remember me
                  </label>
                  <Link href="/forgot-password" className="auth-link">
                    Forgot password?
                  </Link>
                </div>

                <button type="submit" className={`auth-submit ${loading ? 'is-loading' : ''}`} disabled={loading}>
                  <span className="auth-spinner" />
                  <span className="auth-submit-label">Log in to Launch OS</span>
                  <ArrowRightIcon />
                </button>
              </form>

              <div className="auth-footer-line">
                Don&apos;t have a workspace yet? <Link href="/signup">Become a founding operator →</Link>
              </div>
            </div>
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
