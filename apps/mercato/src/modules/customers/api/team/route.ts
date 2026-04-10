export const metadata = { GET: { requireAuth: true }, POST: { requireAuth: true } }
import { NextResponse } from 'next/server'
import { query, queryOne } from '@/app/api/funnels/db'
import { getTeamAuth, isTeamManager } from './auth'
import crypto from 'node:crypto'

export async function GET() {
  const auth = await getTeamAuth()
  if (!auth) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const members = await query(
      `SELECT u.id, u.name, u.email, u.created_at, u.last_login_at, r.name as role_name,
              (o.owner_user_id = u.id) as is_owner
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.deleted_at IS NULL
       LEFT JOIN roles r ON r.id = ur.role_id AND r.tenant_id = $1
       LEFT JOIN organizations o ON o.id = $2
       WHERE u.organization_id = $2 AND u.tenant_id = $1 AND u.deleted_at IS NULL
       ORDER BY u.created_at ASC`,
      [auth.tenantId, auth.orgId]
    )

    const invites = await query(
      `SELECT ti.id, ti.email, ti.role, ti.created_at, ti.expires_at, u.name as invited_by_name
       FROM team_invites ti
       LEFT JOIN users u ON u.id = ti.invited_by
       WHERE ti.organization_id = $1 AND ti.status = 'pending' AND ti.expires_at > now()
       ORDER BY ti.created_at DESC`,
      [auth.orgId]
    )

    const seatRow = await queryOne(
      `SELECT
        (SELECT COUNT(*)::int FROM users WHERE organization_id = $1 AND deleted_at IS NULL) as active_users,
        (SELECT COUNT(*)::int FROM team_invites WHERE organization_id = $1 AND status = 'pending' AND expires_at > now()) as pending_invites`,
      [auth.orgId]
    )

    const activeUsers = seatRow?.active_users || 0
    const pendingInvites = seatRow?.pending_invites || 0

    return NextResponse.json({
      ok: true,
      data: {
        members,
        invites,
        seats: { used: activeUsers + pendingInvites, max: auth.maxSeats },
        currentUserRole: auth.roleName,
      },
    })
  } catch (error) {
    console.error('[team.list]', error)
    return NextResponse.json({ ok: false, error: 'Failed to load team' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const auth = await getTeamAuth()
  if (!auth) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  if (!isTeamManager(auth.roleName, auth.isOwner)) {
    return NextResponse.json({ ok: false, error: 'Only admins can invite team members' }, { status: 403 })
  }

  try {
    const body = await req.json()
    const { email, role } = body as { email?: string; role?: string }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!email || !emailRegex.test(email)) {
      return NextResponse.json({ ok: false, error: 'Please enter a valid email address' }, { status: 400 })
    }
    if (!role || !['admin', 'member'].includes(role)) {
      return NextResponse.json({ ok: false, error: 'Role must be "admin" or "member"' }, { status: 400 })
    }

    const normalizedEmail = email.toLowerCase().trim()

    const seatRow = await queryOne(
      `SELECT
        (SELECT COUNT(*)::int FROM users WHERE organization_id = $1 AND deleted_at IS NULL) as active_users,
        (SELECT COUNT(*)::int FROM team_invites WHERE organization_id = $1 AND status = 'pending' AND expires_at > now()) as pending_invites`,
      [auth.orgId]
    )
    const used = (seatRow?.active_users || 0) + (seatRow?.pending_invites || 0)
    if (used >= auth.maxSeats) {
      return NextResponse.json(
        { ok: false, error: `Upgrade your plan to add more team members (${used} of ${auth.maxSeats} seats used)` },
        { status: 400 }
      )
    }

    const existingInvite = await queryOne(
      `SELECT id FROM team_invites WHERE organization_id = $1 AND email = $2 AND status = 'pending' AND expires_at > now()`,
      [auth.orgId, normalizedEmail]
    )
    if (existingInvite) {
      return NextResponse.json({ ok: false, error: 'An invite is already pending for this email' }, { status: 409 })
    }

    const existingUser = await queryOne(
      `SELECT id FROM users WHERE email = $1 AND organization_id = $2 AND deleted_at IS NULL`,
      [normalizedEmail, auth.orgId]
    )
    if (existingUser) {
      return NextResponse.json({ ok: false, error: 'This person is already a team member' }, { status: 409 })
    }

    const token = crypto.randomBytes(32).toString('hex')
    const inviteId = crypto.randomUUID()
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

    await query(
      `INSERT INTO team_invites (id, organization_id, tenant_id, email, role, token, status, invited_by, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, now())`,
      [inviteId, auth.orgId, auth.tenantId, normalizedEmail, role, token, auth.userId, expiresAt]
    )

    const inviteUrl = `${process.env.APP_URL || 'http://localhost:3000'}/invite?token=${token}`

    // Try to send invite email via connected email, ESP, or warn user
    let emailSent = false
    let emailWarning = ''

    const inviteHtml = `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:32px 24px">
        <h2 style="font-size:20px;margin:0 0 12px">You've been invited to join a team on Launch OS</h2>
        <p style="color:#555;font-size:15px;line-height:1.6;margin:0 0 24px">Click the button below to set up your account and join the team.</p>
        <a href="${inviteUrl}" style="display:inline-block;background:#0000CC;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">Accept Invite</a>
        <p style="color:#888;font-size:13px;margin-top:24px">This invite expires in 7 days. If the button doesn't work, copy this link:<br/><a href="${inviteUrl}" style="color:#0000CC">${inviteUrl}</a></p>
      </div>`
    const inviteSubject = "You've been invited to join a team on Launch OS"

    try {
      // 1. Try user's connected Gmail
      const gmailConn = await queryOne(
        `SELECT id, access_token, refresh_token, token_expiry, email_address FROM email_connections
         WHERE organization_id = $1 AND user_id = $2 AND provider = 'gmail' AND is_active = true LIMIT 1`,
        [auth.orgId, auth.userId]
      )
      if (gmailConn?.access_token) {
        const { sendViaGmail, refreshGmailToken } = await import('@/modules/email/lib/gmail-service')
        let accessToken = gmailConn.access_token
        // Refresh if expired
        if (gmailConn.token_expiry && new Date(gmailConn.token_expiry) < new Date(Date.now() + 5 * 60 * 1000) && gmailConn.refresh_token) {
          const refreshed = await refreshGmailToken(gmailConn.refresh_token)
          accessToken = refreshed.accessToken
          await query('UPDATE email_connections SET access_token = $1, token_expiry = $2 WHERE id = $3',
            [accessToken, new Date(Date.now() + refreshed.expiresIn * 1000).toISOString(), gmailConn.id])
        }
        await sendViaGmail(accessToken, gmailConn.email_address, normalizedEmail, inviteSubject, inviteHtml)
        emailSent = true
      }

      // 2. Try user's connected Outlook
      if (!emailSent) {
        const outlookConn = await queryOne(
          `SELECT id, access_token, refresh_token, token_expiry, email_address FROM email_connections
           WHERE organization_id = $1 AND user_id = $2 AND provider = 'microsoft' AND is_active = true LIMIT 1`,
          [auth.orgId, auth.userId]
        )
        if (outlookConn?.access_token) {
          const { sendViaOutlook, refreshOutlookToken } = await import('@/modules/email/lib/outlook-service')
          let accessToken = outlookConn.access_token
          if (outlookConn.token_expiry && new Date(outlookConn.token_expiry) < new Date(Date.now() + 5 * 60 * 1000) && outlookConn.refresh_token) {
            const refreshed = await refreshOutlookToken(outlookConn.refresh_token)
            accessToken = refreshed.accessToken
            await query('UPDATE email_connections SET access_token = $1, token_expiry = $2 WHERE id = $3',
              [accessToken, new Date(Date.now() + refreshed.expiresIn * 1000).toISOString(), outlookConn.id])
          }
          await sendViaOutlook(accessToken, outlookConn.email_address, normalizedEmail, inviteSubject, inviteHtml)
          emailSent = true
        }
      }

      // 3. Try ESP (Resend/SendGrid)
      if (!emailSent) {
        const espConn = await queryOne(
          `SELECT provider, api_key, default_sender_email, default_sender_name FROM esp_connections WHERE organization_id = $1 AND is_active = true LIMIT 1`,
          [auth.orgId]
        )
        if (espConn?.provider === 'resend' && espConn.api_key) {
          const fromEmail = espConn.default_sender_email || 'noreply@resend.dev'
          const fromName = espConn.default_sender_name || 'Launch OS'
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${espConn.api_key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: `${fromName} <${fromEmail}>`, to: [normalizedEmail], subject: inviteSubject, html: inviteHtml }),
          })
          emailSent = true
        }
      }

      // 4. No email method available
      if (!emailSent) {
        emailWarning = 'Invite created, but no email could be sent. Connect your Gmail or Outlook in Settings to send invites automatically.'
        console.log(`[team.invite] No email provider. Invite URL for ${normalizedEmail}: ${inviteUrl}`)
      }
    } catch (emailError) {
      console.error('[team.invite] Failed to send email:', emailError)
      emailWarning = 'Invite created, but the email failed to send. You can copy the invite link and share it manually.'
      console.log(`[team.invite] Invite URL for ${normalizedEmail}: ${inviteUrl}`)
    }

    return NextResponse.json({
      ok: true,
      data: { id: inviteId, email: normalizedEmail, role, expires_at: expiresAt, inviteUrl: emailSent ? undefined : inviteUrl },
      warning: emailWarning || undefined,
    })
  } catch (error) {
    console.error('[team.invite]', error)
    return NextResponse.json({ ok: false, error: 'Failed to create invite' }, { status: 500 })
  }
}
