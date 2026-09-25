/* The "email isn't connected" banner and router errors used to send people to
 * CRM Settings, which has no mailbox form. They now point at the Noli
 * dashboard's Inbox > Connections tab, where mailboxes are actually connected. */
import { EMAIL_CONNECT_LINK_TEXT, EMAIL_CONNECT_URL, EMAIL_NOT_CONNECTED_BANNER, EMAIL_NOT_SENT_NOT_CONNECTED } from '../sending-readiness'

describe('email connect link', () => {
  it('points at the dashboard Connections tab, not CRM settings', () => {
    expect(EMAIL_CONNECT_URL).toBe('https://app.noliai.com/dashboard/inbox?tab=connections')
    expect(EMAIL_CONNECT_URL).not.toMatch(/settings-simple/)
  })

  it('ends the banner with the link text so the layout can split it into a link', () => {
    expect(EMAIL_NOT_CONNECTED_BANNER.endsWith(` ${EMAIL_CONNECT_LINK_TEXT}`)).toBe(true)
    expect(EMAIL_NOT_CONNECTED_BANNER).not.toMatch(/in Settings/)
    expect(EMAIL_NOT_SENT_NOT_CONNECTED).not.toMatch(/in Settings/)
  })
})
