import { Resend } from 'resend'

export interface SendEmailOptions {
  to: string | string[]
  from?: string
  subject: string
  html: string
  text?: string
  replyTo?: string
  headers?: Record<string, string>
  tags?: Array<{ name: string; value: string }>
}

export interface SendEmailResult {
  id: string
  provider: string
}

export class EmailSenderService {
  private resend: Resend | null = null
  private fromAddress: string

  constructor() {
    const apiKey = process.env.RESEND_API_KEY
    if (apiKey) {
      this.resend = new Resend(apiKey)
    }
    this.fromAddress = process.env.EMAIL_FROM || 'noreply@localhost'
  }

  async send(options: SendEmailOptions): Promise<SendEmailResult> {
    if (!this.resend) {
      // Dev mode: log to console
      console.log(`[email-sender] DEV MODE — would send email:`)
      console.log(`  To: ${Array.isArray(options.to) ? options.to.join(', ') : options.to}`)
      console.log(`  Subject: ${options.subject}`)
      console.log(`  From: ${options.from || this.fromAddress}`)
      return { id: `dev-${Date.now()}`, provider: 'console' }
    }

    const result = await this.resend.emails.send({
      from: options.from || this.fromAddress,
      to: Array.isArray(options.to) ? options.to : [options.to],
      subject: options.subject,
      html: options.html,
      text: options.text,
      replyTo: options.replyTo,
      headers: options.headers,
      tags: options.tags,
    })

    if (result.error) {
      throw new Error(`Resend error: ${result.error.message}`)
    }

    return { id: result.data?.id || '', provider: 'resend' }
  }

  async sendBulk(emails: SendEmailOptions[]): Promise<SendEmailResult[]> {
    const results: SendEmailResult[] = []
    // Send in batches of 10 to respect rate limits
    const batchSize = 10
    for (let i = 0; i < emails.length; i += batchSize) {
      const batch = emails.slice(i, i + batchSize)
      const batchResults = await Promise.allSettled(
        batch.map((email) => this.send(email))
      )
      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          results.push(result.value)
        } else {
          results.push({ id: '', provider: 'error' })
          console.error('[email-sender] batch send failed:', result.reason)
        }
      }
    }
    return results
  }

  injectTrackingPixel(html: string, trackingId: string, baseUrl: string): string {
    const pixelUrl = `${baseUrl}/api/email/track/open/${trackingId}`
    const pixel = `<img src="${pixelUrl}" width="1" height="1" style="display:none" alt="" />`
    return html.replace('</body>', `${pixel}\n</body>`)
  }

  wrapLinksForTracking(html: string, trackingId: string, baseUrl: string): string {
    const trackUrl = `${baseUrl}/api/email/track/click/${trackingId}`
    return html.replace(
      /href="(https?:\/\/[^"]+)"/g,
      (match, url) => {
        // Don't track unsubscribe links
        if (url.includes('unsubscribe')) return match
        return `href="${trackUrl}?url=${encodeURIComponent(url)}"`
      }
    )
  }

  injectUnsubscribeLink(html: string, contactId: string, baseUrl: string): string {
    const unsubUrl = `${baseUrl}/api/email/unsubscribe/${contactId}`
    const link = `<div style="text-align:center;padding:20px;font-size:12px;color:#999;">
      <a href="${unsubUrl}" style="color:#999;text-decoration:underline;">Unsubscribe</a>
    </div>`
    return html.replace('</body>', `${link}\n</body>`)
  }
}
