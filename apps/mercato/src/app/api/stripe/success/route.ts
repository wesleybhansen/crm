import { NextResponse } from 'next/server'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const sessionId = url.searchParams.get('session_id')
  const baseUrl = process.env.APP_URL || 'http://localhost:3000'

  // Simple success page — redirect to payments with success message
  const html = `<!DOCTYPE html>
<html><head><title>Payment Successful</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fafafa}
.card{text-align:center;padding:48px;background:#fff;border-radius:16px;box-shadow:0 2px 8px rgba(0,0,0,0.08);max-width:400px}
h1{font-size:24px;margin:0 0 8px}p{color:#666;font-size:14px;margin:0 0 24px}
a{display:inline-block;padding:10px 24px;background:#3B82F6;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:500}
.check{width:56px;height:56px;background:#D1FAE5;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:28px}</style>
</head><body>
<div class="card">
<div class="check">✓</div>
<h1>Payment Successful!</h1>
<p>Thank you for your payment. You'll receive a confirmation email shortly.</p>
<a href="${baseUrl}">Continue</a>
</div>
</body></html>`

  return new NextResponse(html, { status: 200, headers: { 'Content-Type': 'text/html' } })
}
