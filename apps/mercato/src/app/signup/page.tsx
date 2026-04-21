'use client'

import { useState, FormEvent } from 'react'
import Link from 'next/link'
import '../auth-shell.css'
import { AuthField, AuthParticles, ArrowLeftIcon, ArrowRightIcon, GoogleIcon } from '../auth-shared'

export default function SignupPage() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')

    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }

    setLoading(true)

    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      })
      const data = await res.json()
      if (data.ok) {
        window.location.href = data.redirect || '/backend'
      } else {
        setError(data.error || 'Failed to create account')
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
          <h1>Become a founding member.</h1>
          <p className="auth-sub">Create your Launch OS workspace in 30 seconds.</p>

          <a href="/api/auth/google/start" className="auth-google">
            <GoogleIcon />
            Sign up with Google
          </a>

          <div className="auth-divider">or</div>

          <form className="auth-form" onSubmit={handleSubmit} noValidate>
            {error && <div className="auth-error" role="alert">{error}</div>}

            <AuthField id="name" label="Full name" value={name} onChange={setName} required autoComplete="name" />
            <AuthField id="email" label="Email" type="email" value={email} onChange={setEmail} required autoComplete="email" />
            <AuthField id="password" label="Password (8+ characters)" type="password" value={password} onChange={setPassword} required minLength={8} autoComplete="new-password" />

            <button type="submit" className={`auth-submit ${loading ? 'is-loading' : ''}`} disabled={loading}>
              <span className="auth-spinner" />
              <span className="auth-submit-label">Create workspace</span>
              <ArrowRightIcon />
            </button>
          </form>

          <div className="auth-footer-line">
            Already have a workspace? <Link href="/login">Sign in →</Link>
          </div>
        </div>
      </main>

      <footer className="auth-bottom">
        © 2026 The Launch Pad LLC · Beta access by invitation
      </footer>
    </div>
  )
}
