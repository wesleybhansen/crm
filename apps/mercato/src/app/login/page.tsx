'use client'

import { useState, FormEvent } from 'react'

const styles = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    background: 'linear-gradient(135deg, #ffffff 0%, #f0f0f5 100%)',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    padding: '20px',
    margin: 0,
  } as React.CSSProperties,
  card: {
    width: '100%',
    maxWidth: '400px',
    background: '#fff',
    borderRadius: '12px',
    boxShadow: '0 4px 24px rgba(0, 0, 0, 0.08)',
    padding: '40px 36px',
  } as React.CSSProperties,
  logoWrap: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    marginBottom: '32px',
  } as React.CSSProperties,
  logo: {
    height: '32px',
    marginBottom: '10px',
    display: 'block',
  } as React.CSSProperties,
  brand: {
    fontSize: '22px',
    fontWeight: 700,
    color: '#111',
    margin: 0,
    letterSpacing: '-0.5px',
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  } as React.CSSProperties,
  heading: {
    fontSize: '24px',
    fontWeight: 700,
    color: '#111',
    margin: '0 0 24px',
    textAlign: 'center' as const,
  } as React.CSSProperties,
  label: {
    display: 'block',
    fontSize: '14px',
    fontWeight: 500,
    color: '#333',
    marginBottom: '6px',
  } as React.CSSProperties,
  input: {
    width: '100%',
    padding: '10px 12px',
    fontSize: '14px',
    border: '1px solid #d1d5db',
    borderRadius: '8px',
    outline: 'none',
    transition: 'border-color 0.15s, box-shadow 0.15s',
    boxSizing: 'border-box' as const,
    marginBottom: '16px',
  } as React.CSSProperties,
  inputFocus: {
    borderColor: '#0000CC',
    boxShadow: '0 0 0 3px rgba(0, 0, 204, 0.1)',
  } as React.CSSProperties,
  checkRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginBottom: '20px',
    fontSize: '14px',
    color: '#555',
  } as React.CSSProperties,
  button: {
    width: '100%',
    padding: '12px',
    fontSize: '15px',
    fontWeight: 600,
    color: '#fff',
    background: '#0000CC',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    transition: 'background 0.15s',
  } as React.CSSProperties,
  buttonDisabled: {
    opacity: 0.7,
    cursor: 'not-allowed',
  } as React.CSSProperties,
  error: {
    color: '#dc2626',
    fontSize: '14px',
    textAlign: 'center' as const,
    marginBottom: '16px',
  } as React.CSSProperties,
  link: {
    color: '#0000CC',
    textDecoration: 'none',
    fontWeight: 500,
  } as React.CSSProperties,
  forgotRow: {
    textAlign: 'center' as const,
    marginTop: '16px',
    fontSize: '14px',
  } as React.CSSProperties,
  bottomRow: {
    textAlign: 'center' as const,
    marginTop: '24px',
    fontSize: '14px',
    color: '#666',
  } as React.CSSProperties,
}

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [focusedField, setFocusedField] = useState<string | null>(null)
  const [orgs, setOrgs] = useState<Array<{ tenantId: string; orgId: string; orgName: string }>>([])
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
      .then(r => r.json())
      .then(data => {
        if (data.ok) { window.location.href = data.redirect || '/backend' }
        else { setError(data.error || 'Login failed'); setLoading(false) }
      })
      .catch(() => { setError('Something went wrong'); setLoading(false) })
  }

  function inputStyle(field: string) {
    return focusedField === field
      ? { ...styles.input, ...styles.inputFocus }
      : styles.input
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.logoWrap}>
          <img src="/launchos-logo.png" alt="LaunchOS" style={styles.logo} />
          <p style={styles.brand}>LaunchOS</p>
        </div>
        {showOrgPicker ? (
          <>
            <h1 style={styles.heading}>Choose a workspace</h1>
            <p style={{ fontSize: '14px', color: '#666', textAlign: 'center' as const, marginBottom: '20px' }}>
              Your email is associated with multiple workspaces
            </p>
            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '8px' }}>
              {orgs.map((org) => (
                <button
                  key={org.tenantId}
                  type="button"
                  onClick={() => selectOrg(org.tenantId)}
                  disabled={loading}
                  style={{
                    padding: '14px 16px', border: '1px solid #d1d5db', borderRadius: '8px',
                    background: '#fff', cursor: 'pointer', textAlign: 'left' as const,
                    fontSize: '15px', fontWeight: 600, color: '#111',
                    transition: 'border-color 0.15s, box-shadow 0.15s',
                  }}
                  onMouseOver={(e) => { (e.target as HTMLButtonElement).style.borderColor = '#0000CC'; (e.target as HTMLButtonElement).style.boxShadow = '0 0 0 2px rgba(0,0,204,0.1)' }}
                  onMouseOut={(e) => { (e.target as HTMLButtonElement).style.borderColor = '#d1d5db'; (e.target as HTMLButtonElement).style.boxShadow = 'none' }}
                >
                  {org.orgName}
                </button>
              ))}
            </div>
            <div style={{ ...styles.forgotRow, marginTop: '20px' }}>
              <a href="#" onClick={(e) => { e.preventDefault(); setShowOrgPicker(false); setOrgs([]) }} style={styles.link}>Back to login</a>
            </div>
          </>
        ) : (
          <>
            <h1 style={styles.heading}>Welcome back</h1>

            {error && <p style={styles.error}>{error}</p>}

            <form onSubmit={handleSubmit}>
              <label style={styles.label}>Email</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onFocus={() => setFocusedField('email')}
                onBlur={() => setFocusedField(null)}
                style={inputStyle('email')}
                placeholder="you@example.com"
              />

              <label style={styles.label}>Password</label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onFocus={() => setFocusedField('password')}
                onBlur={() => setFocusedField(null)}
                style={inputStyle('password')}
                placeholder="Enter your password"
              />

              <div style={styles.checkRow}>
                <input
                  type="checkbox"
                  id="remember"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                <label htmlFor="remember">Remember me</label>
              </div>

              <button
                type="submit"
                disabled={loading}
                style={loading ? { ...styles.button, ...styles.buttonDisabled } : styles.button}
              >
                {loading ? 'Signing in...' : 'Sign in'}
              </button>
            </form>

            <div style={styles.forgotRow}>
              <a href="/forgot-password" style={styles.link}>Forgot password?</a>
            </div>

            <div style={styles.bottomRow}>
              Don&apos;t have an account?{' '}
              <a href="/signup" style={styles.link}>Create one</a>
            </div>
          </>
        )}
      </div>
      <div style={{ textAlign: 'center', marginTop: 40, fontSize: 12, color: '#999', lineHeight: 1.8 }}>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 16, marginBottom: 8 }}>
          <a href="/terms" className="footer-link" style={{ color: '#888', textDecoration: 'none', transition: 'color 0.2s' }} onMouseEnter={e => (e.currentTarget.style.color = '#0000CC')} onMouseLeave={e => (e.currentTarget.style.color = '#888')}>Terms and Conditions</a>
          <span style={{ color: '#ccc' }}>·</span>
          <a href="/privacy" className="footer-link" style={{ color: '#888', textDecoration: 'none', transition: 'color 0.2s' }} onMouseEnter={e => (e.currentTarget.style.color = '#0000CC')} onMouseLeave={e => (e.currentTarget.style.color = '#888')}>Privacy Policy</a>
        </div>
        <div style={{ color: '#bbb' }}>© {new Date().getFullYear()} The Launch Pad LLC. All rights reserved.</div>
      </div>
    </div>
  )
}
