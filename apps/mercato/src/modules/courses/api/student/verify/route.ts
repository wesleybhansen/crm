export const metadata = { GET: { requireAuth: false } }

import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import crypto from 'crypto'

export async function GET(req: Request) {
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const url = new URL(req.url)
    const token = url.searchParams.get('token')

    if (!token) {
      return new NextResponse('Invalid link', { status: 400, headers: { 'Content-Type': 'text/html' } })
    }

    // Look up token — tokens are reusable and don't expire
    const magicToken = await knex('course_magic_tokens')
      .where('token', token)
      .first()

    if (!magicToken) {
      const email = ''
      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Link Expired</title>
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
.sub{color:#94a3b8;font-size:13px;margin-top:16px}</style></head>
<body><div class="card">
<div class="icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></div>
<h1>Invalid link</h1>
<p>This access link is no longer valid. Enter your email below to get a new one instantly.</p>
<div id="form">
<input type="email" id="email" placeholder="your@email.com" value="${email}">
<button onclick="resend()" id="btn">Send New Link</button>
</div>
<div id="sent" style="display:none" class="sent">New link sent! Check your email.</div>
<p class="sub">Your new link will be sent instantly</p>
</div>
<script>
async function resend(){var e=document.getElementById('email').value.trim();if(!e)return;var b=document.getElementById('btn');b.disabled=true;b.textContent='Sending...';try{await fetch('/api/courses/student/magic-link',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e})});document.getElementById('form').style.display='none';document.getElementById('sent').style.display='block'}catch{b.disabled=false;b.textContent='Send New Link'}}
document.getElementById('email').addEventListener('keydown',function(e){if(e.key==='Enter')resend()});
</script></body></html>`
      return new NextResponse(html, { status: 400, headers: { 'Content-Type': 'text/html' } })
    }

    // Update last used timestamp (tokens are reusable)
    await knex('course_magic_tokens').where('id', magicToken.id).update({ used_at: new Date() })

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
    const redirectUrl = enrollment ? `${origin}/course/${enrollment.slug}/learn` : `${origin}/course/dashboard`

    const response = NextResponse.redirect(redirectUrl)
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
