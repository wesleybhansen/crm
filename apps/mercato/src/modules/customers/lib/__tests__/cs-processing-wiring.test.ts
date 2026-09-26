/**
 * Guards the wiring of the Customer Service fixes into the paths the crons
 * actually run. The rules themselves are unit-tested next to their helpers
 * (cs-send-decision, cs-mailboxes, commitments-extract); this checks that the
 * engines use them and that the old inline rules do not come back.
 */
import fs from 'node:fs'
import path from 'node:path'

const MODULE_ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(MODULE_ROOT, rel), 'utf8')

const CS_PROCESS = 'api/customer-service/process/route.ts'
const INBOX_PROCESS = 'api/inbox/process/route.ts'
const SCHEDULED_SEND = 'api/customer-service/scheduled-send/route.ts'
const CS_CHAT = 'lib/cs-chat.ts'

describe('Customer Service processing wiring', () => {
  it('no engine lets a flag scenario force a send on its own (draft mode must hold)', () => {
    for (const file of [CS_PROCESS, INBOX_PROCESS]) {
      const src = read(file)
      expect(src).not.toMatch(/shouldPause \? false : true/)
      expect(src).toContain('decideStandardAutoSend(')
    }
  })

  it('the held-reply job re-checks the reply mode before sending', () => {
    const src = read(SCHEDULED_SEND)
    expect(src).toContain('scheduledSendStillAllowed(')
    // The check sits before the atomic claim that leads to the send.
    expect(src.indexOf('scheduledSendStillAllowed(')).toBeLessThan(src.indexOf("update({ status: 'sending'"))
  })

  it('the Customer Service cron extracts commitments from the mail it processes', () => {
    const src = read(CS_PROCESS)
    expect(src).toContain('extractCommitmentsForContact(')
    expect(src).toContain("feature: 'commitments-extract'")
  })

  it('the Customer Service cron drafts only ticked mailboxes', () => {
    const src = read(CS_PROCESS)
    expect(src).toContain('parseWatchedConnectionIds(settings.watched_connection_ids)')
    expect(src).toContain('matchWatchedMailbox(inbound, watched)')
    expect(src).not.toMatch(/toAddr\.includes\(/)
  })

  it('every flag alert picks its recipient through the monitored-mailbox guard', () => {
    for (const file of [CS_PROCESS, INBOX_PROCESS, CS_CHAT]) {
      const src = read(file)
      expect(src).toContain('resolveFlagAlertRecipient(')
      expect(src).not.toMatch(/to: recipient\.email_address/)
    }
  })

  it('Noli notifications are never processed as tickets', () => {
    const src = read(CS_PROCESS)
    expect(src).toContain('ownEmails.add(platformFromEmail)')
    expect(src).toContain('isPlatformNotificationSender(inbound.from_address')
    expect(read(INBOX_PROCESS)).toContain('isPlatformNotificationSender(inbound.from_address')
  })
})
