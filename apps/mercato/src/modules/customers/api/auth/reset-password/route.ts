import { NextRequest, NextResponse } from 'next/server'
import { query, queryOne } from '@/app/api/funnels/db'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { token, password } = body as { token?: string; password?: string }

    if (!token || !password) {
      return NextResponse.json({ ok: false, error: 'Token and password are required' }, { status: 400 })
    }

    if (password.length < 8) {
      return NextResponse.json({ ok: false, error: 'Password must be at least 8 characters' }, { status: 400 })
    }

    // Try password_resets table first
    let userId: string | null = null

    const resetRow = await queryOne(
      `SELECT pr.id as reset_id, pr.user_id
       FROM password_resets pr
       WHERE pr.token = $1 AND pr.expires_at > now() AND pr.used_at IS NULL`,
      [token]
    )

    if (resetRow) {
      userId = resetRow.user_id
      // Mark token as used
      await query('UPDATE password_resets SET used_at = now() WHERE id = $1', [resetRow.reset_id])
    } else {
      // Fall back to user columns
      const userRow = await queryOne(
        'SELECT id FROM users WHERE reset_token = $1 AND reset_token_expires > now()',
        [token]
      )
      if (userRow) {
        userId = userRow.id
      }
    }

    if (!userId) {
      return NextResponse.json({ ok: false, error: 'Invalid or expired reset link' }, { status: 400 })
    }

    const bcrypt = require('bcryptjs')
    const passwordHash = await bcrypt.hash(password, 10)

    await query(
      'UPDATE users SET password_hash = $1 WHERE id = $2',
      [passwordHash, userId]
    )

    // Clear user-column tokens if they exist
    try {
      await query(
        'UPDATE users SET reset_token = NULL, reset_token_expires = NULL WHERE id = $1',
        [userId]
      )
    } catch {
      // Columns may not exist — that's fine
    }

    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    console.error('[auth/reset-password] Error:', err)
    return NextResponse.json({ ok: false, error: 'Internal server error' }, { status: 500 })
  }
}
