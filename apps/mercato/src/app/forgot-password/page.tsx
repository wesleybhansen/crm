'use client'

import { useState, FormEvent } from 'react'
import Link from 'next/link'
import '../auth-shell.css'
import { AuthField, AuthParticles, ArrowLeftIcon, ArrowRightIcon } from '../auth-shared'

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
      <AuthParticles />

      <div className="auth-topbar">
        <Link href="/" className="auth-logo">
          <div className="auth-logo-mark" />
          Launch OS
        </Link>
        <Link href="/login" className="auth-back">
          <ArrowLeftIcon />
          Back to login
        </Link>
      </div>

      <main className="auth-main">
        <div className="auth-card">
          <div className="auth-card-mark" />

          {success ? (
            <div className="auth-swap" key="sent">
              <div className="auth-success-check">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h1>Check your inbox.</h1>
              <p className="auth-sub">
                If an account exists for <strong style={{ color: 'var(--ink)' }}>{email}</strong>, we&apos;ve sent
                a password reset link. The link expires in 60 minutes.
              </p>
              <Link href="/login" className="auth-submit" style={{ textDecoration: 'none' }}>
                <span className="auth-submit-label">Back to login</span>
                <ArrowRightIcon />
              </Link>
            </div>
          ) : (
            <div className="auth-swap" key="form">
              <h1>Reset your password.</h1>
              <p className="auth-sub">Enter your email and we&apos;ll send you a reset link.</p>

              <form className="auth-form" onSubmit={handleSubmit} noValidate>
                <AuthField id="email" label="Email" type="email" value={email} onChange={setEmail} required autoComplete="email" />

                <button type="submit" className={`auth-submit ${loading ? 'is-loading' : ''}`} disabled={loading}>
                  <span className="auth-spinner" />
                  <span className="auth-submit-label">Send reset link</span>
                  <ArrowRightIcon />
                </button>
              </form>

              <div className="auth-footer-line">
                Remember your password? <Link href="/login">Sign in →</Link>
              </div>
            </div>
          )}
        </div>
      </main>

      <footer className="auth-bottom">
        © {new Date().getFullYear()} The Launch Pad LLC
      </footer>
    </div>
  )
}
