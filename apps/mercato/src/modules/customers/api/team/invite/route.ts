export const metadata = { path: '/team/invite', POST: { requireAuth: true }, DELETE: { requireAuth: true } }
import { NextResponse } from 'next/server'
import { query, queryOne } from '@/app/api/funnels/db'
import { getTeamAuth, isTeamManager } from '../auth'

export async function POST(req: Request) {
  const auth = await getTeamAuth()
  if (!auth) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  if (!isTeamManager(auth.roleName, auth.isOwner)) {
    return NextResponse.json({ ok: false, error: 'Only admins can manage invites' }, { status: 403 })
  }

  try {
    const body = await req.json()
    const { inviteId } = body as { inviteId?: string }
    if (!inviteId) {
      return NextResponse.json({ ok: false, error: 'inviteId is required' }, { status: 400 })
    }

    const invite = await queryOne(
      `SELECT id, email, token FROM team_invites
       WHERE id = $1 AND organization_id = $2 AND status = 'pending' AND expires_at > now()`,
      [inviteId, auth.orgId]
    )
    if (!invite) {
      return NextResponse.json({ ok: false, error: 'Invite not found or already expired' }, { status: 404 })
    }

    const newExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    await query(
      `UPDATE team_invites SET expires_at = $1 WHERE id = $2`,
      [newExpiry, inviteId]
    )

    const inviteUrl = `${process.env.APP_URL || 'http://localhost:3000'}/invite?token=${invite.token}`

    try {
      const espConn = await queryOne(
        `SELECT provider, api_key FROM esp_connections WHERE organization_id = $1 AND is_active = true LIMIT 1`,
        [auth.orgId]
      )
      if (espConn?.provider === 'resend' && espConn.api_key) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${espConn.api_key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'noreply@updates.launchos.com',
            to: [invite.email],
            subject: 'Reminder: You\'ve been invited to join a team',
            html: `<p>This is a reminder that you've been invited to join the team. Click the link below to accept:</p><p><a href="${inviteUrl}">${inviteUrl}</a></p><p>This invite expires in 7 days.</p>`,
          }),
        })
      } else {
        console.log(`[team.invite.resend] Invite URL for ${invite.email}: ${inviteUrl}`)
      }
    } catch (emailError) {
      console.error('[team.invite.resend] Failed to send email:', emailError)
      console.log(`[team.invite.resend] Invite URL for ${invite.email}: ${inviteUrl}`)
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[team.invite.resend]', error)
    return NextResponse.json({ ok: false, error: 'Failed to resend invite' }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  const auth = await getTeamAuth()
  if (!auth) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  if (!isTeamManager(auth.roleName, auth.isOwner)) {
    return NextResponse.json({ ok: false, error: 'Only admins can manage invites' }, { status: 403 })
  }

  try {
    const url = new URL(req.url)
    let inviteId = url.searchParams.get('inviteId')

    if (!inviteId) {
      try {
        const body = await req.json()
        inviteId = body.inviteId
      } catch {
        // no body
      }
    }

    if (!inviteId) {
      return NextResponse.json({ ok: false, error: 'inviteId is required' }, { status: 400 })
    }

    const invite = await queryOne(
      `SELECT id FROM team_invites WHERE id = $1 AND organization_id = $2 AND status = 'pending'`,
      [inviteId, auth.orgId]
    )
    if (!invite) {
      return NextResponse.json({ ok: false, error: 'Invite not found' }, { status: 404 })
    }

    await query(
      `UPDATE team_invites SET status = 'revoked' WHERE id = $1`,
      [inviteId]
    )

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[team.invite.revoke]', error)
    return NextResponse.json({ ok: false, error: 'Failed to revoke invite' }, { status: 500 })
  }
}
