// ORM-SKIP: complex multi-table JOINs — raw SQL more maintainable
export const metadata = { path: '/team', GET: { requireAuth: true }, POST: { requireAuth: true } }
import { sendPlatformNotification } from '@/modules/email/lib/platform-sender'
import { NextResponse } from 'next/server'
import { query, queryOne } from '@/lib/db'
import { getTeamAuth, isTeamManager } from './auth'
import { decryptRowFields } from '@open-mercato/shared/lib/encryption/decryptRows'
import { computeEmailHash } from '@open-mercato/core/modules/auth/lib/emailHash'
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
    // users.email is encrypted at rest per workspace. This raw read bypasses the
    // ORM decryption, so without this the Team list showed the ciphertext.
    await decryptRowFields(null, 'auth:user', members, ['email'], auth.tenantId, auth.orgId)

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
      // users.email is ciphertext at rest, so match on the lookup hash as well.
      `SELECT id FROM users WHERE (email = $1 OR email_hash = $3) AND organization_id = $2 AND deleted_at IS NULL`,
      [normalizedEmail, auth.orgId, computeEmailHash(normalizedEmail)]
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
        <h2 style="font-size:20px;margin:0 0 12px">You've been invited to join a team on Noli CRM</h2>
        <p style="color:#555;font-size:15px;line-height:1.6;margin:0 0 24px">Click the button below to set up your account and join the team.</p>
        <a href="${inviteUrl}" style="display:inline-block;background:#0000CC;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">Accept Invite</a>
        <p style="color:#888;font-size:13px;margin-top:24px">This invite expires in 7 days. If the button doesn't work, copy this link:<br/><a href="${inviteUrl}" style="color:#0000CC">${inviteUrl}</a></p>
      </div>`
    const inviteSubject = "You've been invited to join a team on Noli CRM"

    try {
      // A team invite is Noli inviting someone to Noli, so it comes from the platform sender. It used to
      // go out from the inviter's personal Gmail or Outlook first.
      const sent = await sendPlatformNotification({ to: normalizedEmail, subject: inviteSubject, htmlBody: inviteHtml })
      if (sent.ok) emailSent = true
      else console.error('[team.invite] platform send failed:', sent.error)

      // 4. No email method available
      if (!emailSent) {
        emailWarning = 'Invite created, but the invite email could not be sent. Copy the invite link and share it directly.'
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
