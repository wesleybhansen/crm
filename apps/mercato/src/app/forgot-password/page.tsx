'use client'

import { useState, FormEvent } from 'react'
import Link from 'next/link'
import '../auth-shell.css'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setLoading(true)

    try {
      await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
    } catch {
      // Ignore errors — always show success to avoid revealing account existence
    }

    setSuccess(true)
    setLoading(false)
  }

  return (
    <div className="auth-page">
      <div className="auth-atmosphere" />
      <div className="auth-grid-fade" />

      <div className="auth-topbar">
        <Link href="/" className="auth-logo">
          <div className="auth-logo-mark" />
          LaunchOS
        </Link>
        <Link href="/login" className="auth-back">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M19 12H5M11 18l-6-6 6-6" />
          </svg>
          Back to login
        </Link>
      </div>

      <main className="auth-main">
        <div className="auth-card">
          <div className="auth-card-mark" />

          {success ? (
            <>
              <h1>Check your inbox.</h1>
              <p className="auth-sub">
                If an account exists for <strong style={{ color: 'var(--ink)' }}>{email}</strong>, we&apos;ve sent
                a password reset link. The link expires in 60 minutes.
              </p>
              <Link href="/login" className="auth-submit" style={{ textDecoration: 'none' }}>
                Back to login
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </Link>
            </>
          ) : (
            <>
              <h1>Reset your password.</h1>
              <p className="auth-sub">Enter your email and we&apos;ll send you a reset link.</p>

              <form className="auth-form" onSubmit={handleSubmit} noValidate>
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

                <button type="submit" className="auth-submit" disabled={loading}>
                  {loading ? 'Sending…' : 'Send reset link'}
                  {!loading && (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                  )}
                </button>
              </form>

              <div className="auth-footer-line">
                Remember your password? <Link href="/login">Sign in →</Link>
              </div>
            </>
          )}
        </div>
      </main>

      <footer className="auth-bottom">
        © {new Date().getFullYear()} The Launch Pad LLC
      </footer>
    </div>
  )
}
