'use client'

import { Suspense, useState, FormEvent } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import '../auth-shell.css'

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

      <div className="auth-topbar">
        <Link href="/" className="auth-logo">
          <div className="auth-logo-mark" />
          Launch OS
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
              <h1>Password updated.</h1>
              <p className="auth-sub">You can now sign in with your new password.</p>
              <Link href="/login" className="auth-submit" style={{ textDecoration: 'none' }}>
                Continue to login
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </Link>
            </>
          ) : (
            <>
              <h1>Set a new password.</h1>
              <p className="auth-sub">Choose something you&apos;ll remember.</p>

              <form className="auth-form" onSubmit={handleSubmit} noValidate>
                {error && <div className="auth-error" role="alert">{error}</div>}

                <div className="auth-field">
                  <label htmlFor="password">New password</label>
                  <input
                    id="password"
                    type="password"
                    required
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="At least 8 characters"
                    autoComplete="new-password"
                  />
                </div>

                <div className="auth-field">
                  <label htmlFor="confirmPassword">Confirm password</label>
                  <input
                    id="confirmPassword"
                    type="password"
                    required
                    minLength={8}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Re-enter password"
                    autoComplete="new-password"
                  />
                </div>

                <button type="submit" className="auth-submit" disabled={loading}>
                  {loading ? 'Updating…' : 'Update password'}
                  {!loading && (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                  )}
                </button>
              </form>

              <div className="auth-footer-line">
                Remember it now? <Link href="/login">Back to login →</Link>
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
