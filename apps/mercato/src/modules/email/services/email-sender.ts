import { signEmailToken } from '@/lib/email-token'

import { createHmac } from 'crypto'

/** The click redirect follows only URLs this service signed, so the tracking
 *  route cannot be used as an open redirector on the CRM's domain. */
export function trackingSecret(): string {
  return process.env.EMAIL_TRACK_SECRET || process.env.AUTH_SECRET || process.env.NOLI_INTERNAL_SERVICE_SECRET || ''
}
export function signTrackedUrl(url: string): string {
  return createHmac('sha256', trackingSecret()).update(url).digest('hex').slice(0, 32)
}

/**
 * Tracking helpers for outbound customer mail (open pixel, signed click
 * redirects, signed unsubscribe footer).
 *
 * This class used to carry send()/sendBulk() that mailed through Noli's own
 * RESEND_API_KEY and EMAIL_FROM. Nothing called them, and customer email must
 * only ever go out through the customer's own mailbox or ESP (email-router),
 * so they were removed (2026-09-24).
 */
export class EmailSenderService {
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
        return `href="${trackUrl}?url=${encodeURIComponent(url)}&sig=${signTrackedUrl(url)}"`
      }
    )
  }

  injectUnsubscribeLink(html: string, contactId: string, baseUrl: string, orgId: string): string {
    // Signed: a bare contact UUID must not be enough to open the preference center.
    const unsubUrl = `${baseUrl}/api/email/unsubscribe/${contactId}?t=${encodeURIComponent(signEmailToken(contactId, orgId))}`
    const link = `<div style="text-align:center;padding:20px;font-size:12px;color:#999;">
      <a href="${unsubUrl}" style="color:#999;text-decoration:underline;">Unsubscribe</a>
    </div>`
    return html.replace('</body>', `${link}\n</body>`)
  }
}
