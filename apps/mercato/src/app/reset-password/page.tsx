'use client'

import { Suspense, useState, FormEvent } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import '../auth-shell.css'
import { AuthField, AuthParticles, ArrowLeftIcon, ArrowRightIcon } from '../auth-shared'

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPasswordForm />
    </Suspense>
  )
}

function ResetPasswordForm() {
  const searchParams = useSearchParams()
  const token = searchParams.get('token') || ''

  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')

    if (!token) {
      setError('Invalid or missing reset token')
      return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    setLoading(true)

    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      })
      const data = await res.json()
      if (data.ok) {
        setSuccess(true)
      } else {
        setError(data.error || 'Failed to reset password')
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
        <Link href="/login" className="auth-back">
          <ArrowLeftIcon />
          Back to login
        </Link>
      </div>

      <main className="auth-main">
        <div className="auth-card">
          <div className="auth-card-mark" />

          {success ? (
            <div className="auth-swap" key="done">
              <div className="auth-success-check">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h1>Password updated.</h1>
              <p className="auth-sub">You can now sign in with your new password.</p>
              <Link href="/login" className="auth-submit" style={{ textDecoration: 'none' }}>
                <span className="auth-submit-label">Continue to login</span>
                <ArrowRightIcon />
              </Link>
            </div>
          ) : (
            <div className="auth-swap" key="form">
              <h1>Set a new password.</h1>
              <p className="auth-sub">Choose something you&apos;ll remember.</p>

              <form className="auth-form" onSubmit={handleSubmit} noValidate>
                {error && <div className="auth-error" role="alert">{error}</div>}

                <AuthField id="password" label="New password (8+ characters)" type="password" value={password} onChange={setPassword} required minLength={8} autoComplete="new-password" />
                <AuthField id="confirmPassword" label="Confirm password" type="password" value={confirmPassword} onChange={setConfirmPassword} required minLength={8} autoComplete="new-password" />

                <button type="submit" className={`auth-submit ${loading ? 'is-loading' : ''}`} disabled={loading}>
                  <span className="auth-spinner" />
                  <span className="auth-submit-label">Update password</span>
                  <ArrowRightIcon />
                </button>
              </form>

              <div className="auth-footer-line">
                Remember it now? <Link href="/login">Back to login →</Link>
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
