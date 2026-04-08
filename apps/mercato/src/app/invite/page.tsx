'use client'

import { useState, useEffect, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'

const styles = {
  page: {
    minHeight: '100vh', display: 'flex' as const, alignItems: 'center' as const, justifyContent: 'center' as const,
    background: 'linear-gradient(135deg, #ffffff 0%, #f0f0f5 100%)',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    padding: '20px',
  },
  card: { width: '100%', maxWidth: '400px', background: '#fff', borderRadius: '12px',
    boxShadow: '0 4px 24px rgba(0, 0, 0, 0.08)', padding: '40px 36px' },
  logoWrap: { display: 'flex' as const, flexDirection: 'column' as const, alignItems: 'center' as const, marginBottom: '32px' },
  logo: { height: '32px', marginBottom: '10px', display: 'block' as const },
  brand: { fontSize: '22px', fontWeight: 700, color: '#111', margin: 0,
    letterSpacing: '-0.5px', fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" },
  heading: { fontSize: '24px', fontWeight: 700, color: '#111', margin: '0 0 8px', textAlign: 'center' as const },
  subtitle: { fontSize: '14px', color: '#666', textAlign: 'center' as const, margin: '0 0 24px' },
  label: { display: 'block', fontSize: '14px', fontWeight: 500, color: '#333', marginBottom: '6px' },
  input: { width: '100%', padding: '10px 12px', fontSize: '14px', border: '1px solid #d1d5db',
    borderRadius: '8px', outline: 'none', boxSizing: 'border-box' as const, marginBottom: '16px' },
  inputReadonly: { width: '100%', padding: '10px 12px', fontSize: '14px', border: '1px solid #e5e7eb',
    borderRadius: '8px', background: '#f9fafb', color: '#666', boxSizing: 'border-box' as const, marginBottom: '16px' },
  btn: { width: '100%', padding: '12px', fontSize: '15px', fontWeight: 600, color: '#fff',
    background: '#0000CC', border: 'none', borderRadius: '8px', cursor: 'pointer' },
  error: { color: '#dc2626', fontSize: '13px', textAlign: 'center' as const, marginBottom: '16px' },
  link: { display: 'block', textAlign: 'center' as const, fontSize: '13px', color: '#666', marginTop: '20px' },
}

function InviteAcceptForm() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const token = searchParams.get('token') || ''

  const [loading, setLoading] = useState(true)
  const [orgName, setOrgName] = useState('')
  const [email, setEmail] = useState('')
  const [invalid, setInvalid] = useState(false)
  const [invalidMessage, setInvalidMessage] = useState('')

  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')

  useEffect(() => {
    if (!token) {
      setInvalid(true)
      setInvalidMessage('No invitation token provided.')
      setLoading(false)
      return
    }
    fetch(`/api/invite/accept?token=${encodeURIComponent(token)}`)
      .then(r => r.json())
      .then(d => {
        if (d.ok && d.data) {
          setOrgName(d.data.orgName || 'the team')
          setEmail(d.data.email || '')
        } else {
          setInvalid(true)
          setInvalidMessage(d.error || 'This invitation is invalid or has expired.')
        }
      })
      .catch(() => {
        setInvalid(true)
        setInvalidMessage('Failed to validate invitation. Please try again.')
      })
      .finally(() => setLoading(false))
  }, [token])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || password.length < 8) return
    setSubmitting(true)
    setSubmitError('')
    try {
      const res = await fetch('/api/invite/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, name: name.trim(), password }),
      })
      const d = await res.json()
      if (d.ok) {
        router.push(d.data?.redirect || '/backend')
      } else {
        setSubmitError(d.error || 'Failed to accept invitation.')
      }
    } catch {
      setSubmitError('Something went wrong. Please try again.')
    }
    setSubmitting(false)
  }

  if (loading) {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <div style={styles.logoWrap}>
            <img src="/launchos-logo.png" alt="Launch OS" style={styles.logo} />
            <p style={styles.brand}>Launch OS</p>
          </div>
          <p style={{ ...styles.subtitle, margin: 0 }}>Validating invitation...</p>
        </div>
      </div>
    )
  }

  if (invalid) {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <div style={styles.logoWrap}>
            <img src="/launchos-logo.png" alt="Launch OS" style={styles.logo} />
            <p style={styles.brand}>Launch OS</p>
          </div>
          <h1 style={styles.heading}>Invalid Invitation</h1>
          <p style={styles.error}>{invalidMessage}</p>
          <a href="/login" style={styles.link}>
            Go to Sign In
          </a>
        </div>
      </div>
    )
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.logoWrap}>
          <img src="/launchos-logo.png" alt="Launch OS" style={styles.logo} />
          <p style={styles.brand}>Launch OS</p>
        </div>
        <h1 style={styles.heading}>Join {orgName}</h1>
        <p style={styles.subtitle}>You&apos;ve been invited to join the team</p>

        {submitError && <p style={styles.error}>{submitError}</p>}

        <form onSubmit={handleSubmit}>
          <label style={styles.label}>Email</label>
          <input type="email" value={email} readOnly style={styles.inputReadonly} />

          <label style={styles.label}>Your Name</label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Enter your full name"
            required
            style={styles.input}
          />

          <label style={styles.label}>Password</label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Minimum 8 characters"
            minLength={8}
            required
            style={styles.input}
          />

          <button
            type="submit"
            disabled={submitting || !name.trim() || password.length < 8}
            style={{
              ...styles.btn,
              opacity: submitting || !name.trim() || password.length < 8 ? 0.6 : 1,
            }}
          >
            {submitting ? 'Joining...' : 'Join Team'}
          </button>
        </form>

        <a href="/login" style={styles.link}>
          Already have an account? <span style={{ color: '#0000CC' }}>Sign in</span>
        </a>
      </div>
    </div>
  )
}

export default function InviteAcceptPage() {
  return (
    <Suspense fallback={
      <div style={styles.page}>
        <div style={styles.card}>
          <div style={styles.logoWrap}>
            <img src="/launchos-logo.png" alt="Launch OS" style={styles.logo} />
            <p style={styles.brand}>Launch OS</p>
          </div>
          <p style={{ ...styles.subtitle, margin: 0 }}>Loading...</p>
        </div>
      </div>
    }>
      <InviteAcceptForm />
    </Suspense>
  )
}
