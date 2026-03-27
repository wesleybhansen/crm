/**
 * ESP Service
 * Send emails via third-party Email Service Providers (Resend, SendGrid, Mailgun, SES).
 */

interface EspSendResult {
  messageId: string
  provider: string
}

/**
 * Send an email via the configured ESP provider.
 */
export async function sendViaESP(
  provider: string,
  apiKey: string,
  from: string,
  to: string,
  subject: string,
  htmlBody: string,
): Promise<EspSendResult> {
  switch (provider) {
    case 'resend':
      return sendViaResend(apiKey, from, to, subject, htmlBody)
    case 'sendgrid':
      return sendViaSendGrid(apiKey, from, to, subject, htmlBody)
    case 'mailgun':
      return sendViaMailgun(apiKey, from, to, subject, htmlBody)
    case 'ses':
      return sendViaSES(apiKey, from, to, subject, htmlBody)
    default:
      throw new Error(`Unsupported ESP provider: ${provider}`)
  }
}

async function sendViaResend(
  apiKey: string,
  from: string,
  to: string,
  subject: string,
  htmlBody: string,
): Promise<EspSendResult> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to: [to], subject, html: htmlBody }),
  })

  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(`Resend send failed (${res.status}): ${data?.message || res.statusText}`)
  }

  const data = await res.json()
  return { messageId: data.id || '', provider: 'resend' }
}

async function sendViaSendGrid(
  apiKey: string,
  from: string,
  to: string,
  subject: string,
  htmlBody: string,
): Promise<EspSendResult> {
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from },
      subject,
      content: [{ type: 'text/html', value: htmlBody }],
    }),
  })

  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    const errors = data?.errors?.map((e: { message: string }) => e.message).join(', ')
    throw new Error(`SendGrid send failed (${res.status}): ${errors || res.statusText}`)
  }

  // SendGrid returns 202 with X-Message-Id header
  const messageId = res.headers.get('X-Message-Id') || `sendgrid_${Date.now()}`
  return { messageId, provider: 'sendgrid' }
}

async function sendViaMailgun(
  apiKey: string,
  from: string,
  to: string,
  subject: string,
  htmlBody: string,
): Promise<EspSendResult> {
  // Extract domain from the 'from' address
  const domainMatch = from.match(/@(.+)$/)
  const domain = domainMatch ? domainMatch[1] : ''
  if (!domain) {
    throw new Error('Could not extract domain from sender address for Mailgun')
  }

  const formData = new URLSearchParams()
  formData.append('from', from)
  formData.append('to', to)
  formData.append('subject', subject)
  formData.append('html', htmlBody)

  const res = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}`,
    },
    body: formData,
  })

  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(`Mailgun send failed (${res.status}): ${data?.message || res.statusText}`)
  }

  const data = await res.json()
  return { messageId: data.id || '', provider: 'mailgun' }
}

async function sendViaSES(
  apiKey: string,
  from: string,
  to: string,
  subject: string,
  htmlBody: string,
): Promise<EspSendResult> {
  // SES uses SMTP credentials in format SMTP_USER:SMTP_PASS:REGION
  const parts = apiKey.split(':')
  if (parts.length < 2) {
    throw new Error('SES credentials should be in format SMTP_USER:SMTP_PASS or SMTP_USER:SMTP_PASS:REGION')
  }

  const smtpUser = parts[0]
  const smtpPass = parts[1]
  const region = parts[2] || 'us-east-1'

  const nodemailer = await import('nodemailer')
  const transporter = nodemailer.createTransport({
    host: `email-smtp.${region}.amazonaws.com`,
    port: 587,
    secure: false,
    auth: { user: smtpUser, pass: smtpPass },
  })

  const info = await transporter.sendMail({
    from,
    to,
    subject,
    html: htmlBody,
    text: htmlBody.replace(/<[^>]+>/g, ''),
  })

  return { messageId: info.messageId || '', provider: 'ses' }
}
