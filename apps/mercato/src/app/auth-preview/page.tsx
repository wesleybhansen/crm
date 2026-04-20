'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import '../auth-shell.css'
import './preview.css'

type PreviewState = 'default' | 'error' | 'loading' | 'orgPicker' | 'success'

const TOOLBAR: { id: PreviewState; label: string }[] = [
  { id: 'default', label: 'Default' },
  { id: 'error', label: 'Error' },
  { id: 'loading', label: 'Loading' },
  { id: 'orgPicker', label: 'Org picker' },
  { id: 'success', label: 'Success' },
]

export default function AuthPreviewPage() {
  const [state, setState] = useState<PreviewState>('default')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [emailFocused, setEmailFocused] = useState(false)
  const [passwordFocused, setPasswordFocused] = useState(false)

  const particles = useMemo(() => {
    return Array.from({ length: 18 }).map((_, i) => ({
      left: Math.random() * 100,
      delay: Math.random() * 12,
      duration: 14 + Math.random() * 12,
      drift: Math.random() * 80 - 40,
      size: Math.random() * 2 + 1,
      id: i,
    }))
  }, [])

  useEffect(() => {
    if (state === 'loading') {
      const t = setTimeout(() => setState('default'), 1800)
      return () => clearTimeout(t)
    }
  }, [state])

  return (
    <div className="auth-page">
      <div className="auth-atmosphere" />
      <div className="auth-grid-fade" />

      <div className="preview-particles" aria-hidden>
        {particles.map((p) => (
          <span
            key={p.id}
            style={{
              left: `${p.left}%`,
              animationDelay: `${p.delay}s`,
              animationDuration: `${p.duration}s`,
              width: `${p.size}px`,
              height: `${p.size}px`,
              ['--drift' as string]: `${p.drift}px`,
            }}
          />
        ))}
      </div>

      <div className="preview-toolbar" role="toolbar" aria-label="Preview state">
        {TOOLBAR.map((t) => (
          <button
            key={t.id}
            type="button"
            className={state === t.id ? 'active' : ''}
            onClick={() => setState(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="auth-topbar">
        <Link href="/" className="auth-logo">
          <div className="auth-logo-mark" />
          Launch OS
        </Link>
        <Link href="/login" className="auth-back">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M19 12H5M11 18l-6-6 6-6" />
          </svg>
          Real login
        </Link>
      </div>

      <main className="auth-main">
        <div className="auth-card preview-auth preview-card-idle">
          <div className="auth-card-mark" />

          {state === 'orgPicker' ? (
            <div className="preview-swap" key="picker">
              <h1>Choose a workspace.</h1>
              <p className="auth-sub">Your email is associated with multiple workspaces.</p>
              <div className="auth-form" style={{ gap: 10 }}>
                {['The Launch Pad', 'Acme Realty', 'Side Project Co'].map((name) => (
                  <button key={name} type="button" className="preview-org-pick">
                    {name}
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                  </button>
                ))}
              </div>
              <div className="auth-footer-line">
                <a href="#" onClick={(e) => { e.preventDefault(); setState('default') }}>← Back to login</a>
              </div>
            </div>
          ) : state === 'success' ? (
            <div className="preview-success" key="success">
              <div className="preview-check">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h1>Check your inbox.</h1>
              <p className="auth-sub">
                If an account exists for <strong style={{ color: '#fff' }}>{email || 'you@yourbusiness.com'}</strong>,
                {' '}we&apos;ve sent a reset link. It expires in 60 minutes.
              </p>
              <button type="button" className="preview-submit" onClick={() => setState('default')}>
                <span className="preview-submit-label">Back to login</span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </button>
            </div>
          ) : (
            <div className="preview-swap" key="login">
              <h1>Welcome back, rockstar.</h1>
              <p className="auth-sub">Sign in to your Launch OS workspace.</p>

              <button type="button" className="preview-google">
                <svg viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09 0-.73.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                </svg>
                Continue with Google
              </button>

              <div className="preview-divider">or</div>

              <form
                className="auth-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  setState('loading')
                }}
                noValidate
              >
                {state === 'error' && (
                  <div className="preview-error" role="alert">Invalid email or password.</div>
                )}

                <div className={`preview-field ${emailFocused ? 'is-focused' : ''} ${email ? 'has-value' : ''}`}>
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onFocus={() => setEmailFocused(true)}
                    onBlur={() => setEmailFocused(false)}
                    autoComplete="email"
                  />
                  <label htmlFor="email">Email</label>
                </div>

                <div className={`preview-field ${passwordFocused ? 'is-focused' : ''} ${password ? 'has-value' : ''}`}>
                  <input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onFocus={() => setPasswordFocused(true)}
                    onBlur={() => setPasswordFocused(false)}
                    autoComplete="current-password"
                  />
                  <label htmlFor="password">Password</label>
                </div>

                <div className="auth-row">
                  <label className="auth-checkbox-label">
                    <input type="checkbox" /> Remember me
                  </label>
                  <a href="#" onClick={(e) => { e.preventDefault(); setState('success') }} className="auth-link">
                    Forgot password?
                  </a>
                </div>

                <button
                  type="submit"
                  className={`preview-submit ${state === 'loading' ? 'is-loading' : ''}`}
                  disabled={state === 'loading'}
                >
                  <span className="preview-spinner" />
                  <span className="preview-submit-label">Log in to Launch OS</span>
                  {state !== 'loading' && (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                  )}
                </button>
              </form>

              <div className="auth-footer-line">
                Don&apos;t have a workspace yet?{' '}
                <a href="#" onClick={(e) => e.preventDefault()}>Become a founding operator →</a>
              </div>
            </div>
          )}
        </div>
      </main>

      <footer className="auth-bottom">
        <div className="auth-bottom-links">
          <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11 }}>
            Preview of proposed auth polish. Use toolbar above to switch states.
          </span>
        </div>
      </footer>
    </div>
  )
}
