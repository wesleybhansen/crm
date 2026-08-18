import { GtmMailboxPolicy } from '../../data/entities'
import {
  bindCanonicalMailboxPolicy,
  mailboxPolicyMatchesSettings,
  settingsFromMailboxPolicy,
} from '../execute/mailbox-policy'
import { FakeEm } from './support/fake-em'

const ORG = '00000000-0000-4000-8000-000000000001'
const TENANT = '00000000-0000-4000-8000-000000000002'
const MAILBOX = '00000000-0000-4000-8000-000000000003'
const VERSION = '00000000-0000-4000-8000-000000000004'
const settings = {
  daily_cap: 25,
  send_window: { start_hour: 9, end_hour: 17, timezone: 'America/New_York' },
}

describe('canonical GTM mailbox capacity policy', () => {
  it('binds the first approved envelope and reuses an exact match', async () => {
    const em = new FakeEm()
    const first = await bindCanonicalMailboxPolicy(
      em,
      { organizationId: ORG, tenantId: TENANT },
      { mailboxConnectionId: MAILBOX, campaignVersionId: VERSION, settings },
    )
    const replay = await bindCanonicalMailboxPolicy(
      em,
      { organizationId: ORG, tenantId: TENANT },
      {
        mailboxConnectionId: MAILBOX,
        campaignVersionId: '00000000-0000-4000-8000-000000000099',
        settings,
      },
    )
    expect(replay).toBe(first)
    expect(em.table(GtmMailboxPolicy)).toHaveLength(1)
    expect(first.boundByCampaignVersionId).toBe(VERSION)
    expect(settingsFromMailboxPolicy(first)).toEqual(settings)
    expect(mailboxPolicyMatchesSettings(first, settings)).toBe(true)
  })

  it('rejects a different cap, window, timezone, tenant, or mailbox namespace', async () => {
    const em = new FakeEm()
    await bindCanonicalMailboxPolicy(
      em,
      { organizationId: ORG, tenantId: TENANT },
      { mailboxConnectionId: MAILBOX, campaignVersionId: VERSION, settings },
    )
    await expect(bindCanonicalMailboxPolicy(
      em,
      { organizationId: ORG, tenantId: TENANT },
      {
        mailboxConnectionId: MAILBOX,
        campaignVersionId: VERSION,
        settings: {
          daily_cap: 50,
          send_window: { ...settings.send_window, timezone: 'America/Los_Angeles' },
        },
      },
    )).rejects.toMatchObject({ code: 'mailbox_policy_conflict' })

    await expect(bindCanonicalMailboxPolicy(
      em,
      { organizationId: ORG, tenantId: '00000000-0000-4000-8000-000000000099' },
      { mailboxConnectionId: MAILBOX, campaignVersionId: VERSION, settings },
    )).resolves.not.toBeNull()
    expect(em.table(GtmMailboxPolicy)).toHaveLength(2)
  })
})
