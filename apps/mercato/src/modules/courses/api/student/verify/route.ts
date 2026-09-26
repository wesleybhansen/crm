export const metadata = { GET: { requireAuth: false } }

import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import crypto from 'crypto'
import { checkMagicToken, magicLinkTtlLabel, type MagicTokenRow } from '@/modules/courses/lib/magic-tokens'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export async function GET(req: Request) {
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const url = new URL(req.url)
    const token = url.searchParams.get('token')

    if (!token) {
      return new NextResponse('Invalid link', { status: 400, headers: { 'Content-Type': 'text/html' } })
    }

    const magicToken = (await knex('course_magic_tokens')
      .where('token', token)
      .first()) as MagicTokenRow | undefined

    // Expiry (default 7 days) + bounded use, see lib/magic-tokens.ts
    const check = magicToken ? checkMagicToken(magicToken) : null

    if (!magicToken || !check || !check.ok) {
      const reason = check && !check.ok ? check.reason : 'invalid'
      const email = magicToken ? escapeHtml(magicToken.email) : ''
      // The resend names the business through the link it sent (a hex token
      // from our own row), so a business without email gets a plain answer.
      const resendToken = magicToken ? JSON.stringify(String(magicToken.token)).replace(/</g, '\\u003c') : 'null'
      const ttl = magicLinkTtlLabel()
      const copy = reason === 'expired'
        ? { title: 'Link expired', body: `This access link has expired. Links are valid for ${ttl} after they are sent. Enter your email below to get a new one instantly.` }
        : reason === 'used'
          ? { title: 'Link already used', body: 'This access link has already been used and cannot be opened again. Enter your email below to get a new one instantly.' }
          : { title: 'Invalid link', body: 'This access link is no longer valid. Enter your email below to get a new one instantly.' }
      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${copy.title}</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:linear-gradient(160deg,#f8faff,#f1f5f9,#faf5ff);padding:24px}
.card{background:#fff;border-radius:20px;box-shadow:0 1px 2px rgba(0,0,0,.03),0 8px 32px rgba(0,0,0,.06);max-width:420px;width:100%;padding:48px 40px;text-align:center}
.icon{width:56px;height:56px;background:#fef2f2;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 20px}
h1{font-size:22px;font-weight:700;color:#0f172a;margin-bottom:8px}
p{color:#64748b;font-size:15px;line-height:1.6;margin-bottom:24px}
input{width:100%;padding:13px 16px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:15px;margin-bottom:12px;outline:none;font-family:inherit;transition:border-color 200ms}
input:focus{border-color:#6366f1}
button{width:100%;padding:13px;background:#6366f1;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit;transition:background 150ms}
button:hover{background:#4f46e5}
button:disabled{opacity:0.6;cursor:not-allowed}
.sent{color:#22c55e;font-weight:600;font-size:15px;padding:12px 0}
.err{color:#b91c1c;font-size:14px;line-height:1.5;margin:0 0 12px}
.sub{color:#94a3b8;font-size:13px;margin-top:16px}</style></head>
<body><div class="card">
<div class="icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></div>
<h1>${copy.title}</h1>
<p>${copy.body}</p>
<div id="form">
<p id="err" class="err" role="alert" style="display:none"></p>
<input type="email" id="email" placeholder="your@email.com" value="${email}">
<button onclick="resend()" id="btn">Send New Link</button>
</div>
<div id="sent" style="display:none" class="sent">New link sent! Check your email.</div>
<p class="sub">Your new link will be sent instantly</p>
</div>
<script>
var T=${resendToken};
async function resend(){var e=document.getElementById('email').value.trim();if(!e)return;var b=document.getElementById('btn');var er=document.getElementById('err');er.style.display='none';b.disabled=true;b.textContent='Sending...';try{var r=await fetch('/api/courses/student/magic-link',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,token:T})});var d=null;try{d=await r.json()}catch(x){}if(d&&d.code==='email_not_connected'&&d.error){er.textContent=d.error;er.style.display='block';b.disabled=false;b.textContent='Send New Link';return}document.getElementById('form').style.display='none';document.getElementById('sent').style.display='block'}catch(x){b.disabled=false;b.textContent='Send New Link'}}
document.getElementById('email').addEventListener('keydown',function(e){if(e.key==='Enter')resend()});
</script></body></html>`
      return new NextResponse(html, { status: 400, headers: { 'Content-Type': 'text/html' } })
    }

    // Stamp first use; later clicks inside the grace window keep the original stamp so the window cannot be extended.
    if (check.firstUse) {
      await knex('course_magic_tokens').where('id', magicToken.id).whereNull('used_at').update({ used_at: new Date() })
    }

    // Create session
    const sessionToken = crypto.randomBytes(32).toString('hex')
    await knex('course_student_sessions').insert({
      id: crypto.randomUUID(),
      organization_id: magicToken.organization_id,
      email: magicToken.email,
      session_token: sessionToken,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      created_at: new Date(),
    })

    // Find the first enrolled course to redirect to
    const enrollment = await knex('course_enrollments as ce')
      .join('courses as c', 'ce.course_id', 'c.id')
      .where('ce.student_email', magicToken.email)
      .where('ce.organization_id', magicToken.organization_id)
      .where('ce.status', 'active')
      .where('c.is_published', true)
      .whereNull('c.deleted_at')
      .select('c.slug')
      .first()

    const origin = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
    // No active enrollment in a published course: there is no course page to
    // open, so say so plainly instead of redirecting to a page that doesn't exist.
    const response = enrollment
      ? NextResponse.redirect(`${origin}/course/${enrollment.slug}/learn`)
      : new NextResponse(
          `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>No active course</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;background:#f8fafc}
.card{background:#fff;border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,.06);max-width:420px;width:100%;padding:40px 32px;text-align:center}
h1{font-size:20px;color:#0f172a;margin:0 0 8px}p{color:#64748b;font-size:15px;line-height:1.6;margin:0}</style></head>
<body><div class="card"><h1>No active course</h1><p>You're signed in as ${escapeHtml(magicToken.email)}, but there's no active course for this email right now. If you just enrolled, give it a minute and try again, or contact the course owner.</p></div></body></html>`,
          { status: 200, headers: { 'Content-Type': 'text/html' } },
        )
    response.cookies.set('course_session', sessionToken, {
      path: '/',
      maxAge: 7 * 24 * 60 * 60, // 7 days
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
    })

    return response
  } catch (error) {
    console.error('[courses.student.verify]', error)
    return new NextResponse('Something went wrong', { status: 500 })
  }
}
