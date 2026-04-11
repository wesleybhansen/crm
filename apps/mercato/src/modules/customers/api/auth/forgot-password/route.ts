export const metadata = { path: '/auth/forgot-password', POST: { requireAuth: true } }
import { NextRequest, NextResponse } from 'next/server'
import { query, queryOne } from '@/lib/db'
import crypto from 'node:crypto'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { email } = body as { email?: string }

    if (!email) {
      return NextResponse.json({ ok: true }) // Don't reveal validation details
    }

    const normalizedEmail = email.toLowerCase().trim()
    const user = await queryOne('SELECT id FROM users WHERE email = $1', [normalizedEmail])

    if (user) {
      const token = crypto.randomUUID()
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000) // 1 hour

      // Ensure password_resets table columns exist, then insert
      try {
        await query(
          `INSERT INTO password_resets (id, user_id, token, expires_at, created_at)
           VALUES ($1, $2, $3, $4, now())`,
          [crypto.randomUUID(), user.id, token, expiresAt]
        )
      } catch {
        // If password_resets table doesn't work, fall back to user columns
        try {
          await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token TEXT', [])
          await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ', [])
          await query(
            'UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3',
            [token, expiresAt, user.id]
          )
        } catch (alterErr) {
          console.error('[auth/forgot-password] Could not store reset token:', alterErr)
        }
      }

      console.log('[auth] Password reset requested for', normalizedEmail, 'token:', token)
    }

    // Always return ok — don't reveal whether email exists
    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    console.error('[auth/forgot-password] Error:', err)
    // Still return ok to avoid revealing information
    return NextResponse.json({ ok: true })
  }
}
