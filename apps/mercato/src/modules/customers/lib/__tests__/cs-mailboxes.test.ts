import { createFakeDb } from '../../../../lib/__tests__/support/fake-db'
import {
  extractEmailAddresses,
  isPlatformNotificationSender,
  matchWatchedMailbox,
  monitoredMailboxAddresses,
  parseWatchedConnectionIds,
  pickFlagAlertRecipient,
  resolveFlagAlertRecipient,
  type MailboxConnection,
} from '../cs-mailboxes'

const SUPPORT: MailboxConnection = { id: 'conn-support', email_address: 'support@acme.com', purpose: 'customer_service', is_primary: false }
const PERSONAL: MailboxConnection = { id: 'conn-personal', email_address: 'Owner@Gmail.com', purpose: null, is_primary: true }
const SIDE: MailboxConnection = { id: 'conn-side', email_address: 'side@acme.com', purpose: null, is_primary: false }

describe('parseWatchedConnectionIds: nothing ticked means no mailbox', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty list', []],
    ['an empty JSON list', '[]'],
    ['a JSON null', 'null'],
    ['junk', 'not json'],
    ['an object', { a: 1 }],
  ])('%s is an empty selection', (_label, raw) => {
    expect(parseWatchedConnectionIds(raw)).toEqual([])
  })

  it('keeps ticked ids from an array or a JSON string, trimmed and de-duplicated', () => {
    expect(parseWatchedConnectionIds(['a', ' b ', 'a', '', 7])).toEqual(['a', 'b'])
    expect(parseWatchedConnectionIds('["x","y"]')).toEqual(['x', 'y'])
  })
})

describe('matchWatchedMailbox', () => {
  const watched = [{ id: 'conn-support', address: 'support@acme.com' }]

  it('matches nothing when no mailbox is ticked, so personal mail is never drafted', () => {
    expect(matchWatchedMailbox({ account_id: 'conn-personal', to_address: 'owner@gmail.com' }, [])).toBeNull()
    expect(matchWatchedMailbox({ account_id: 'conn-support', to_address: 'support@acme.com' }, [])).toBeNull()
  })

  it('does not match personal mail when only the support inbox is ticked', () => {
    expect(matchWatchedMailbox({ account_id: 'conn-personal', to_address: 'Owner <owner@gmail.com>' }, watched)).toBeNull()
  })

  it('matches by the connection that ingested the message', () => {
    expect(matchWatchedMailbox({ account_id: 'conn-support', to_address: 'undisclosed-recipients:;' }, watched)?.id).toBe('conn-support')
  })

  it('falls back to an exact To address, display names and case included', () => {
    expect(matchWatchedMailbox({ account_id: null, to_address: 'Acme Support <SUPPORT@acme.com>, bob@x.com' }, watched)?.id).toBe('conn-support')
  })

  it('never matches on a substring of another address', () => {
    expect(matchWatchedMailbox({ account_id: null, to_address: 'notsupport@acme.com' }, watched)).toBeNull()
    expect(matchWatchedMailbox({ account_id: null, to_address: 'support@acme.com.evil.io' }, watched)).toBeNull()
  })
})

describe('flag alert recipient guard', () => {
  it('treats every support inbox and every ticked mailbox as monitored', () => {
    expect([...monitoredMailboxAddresses([SUPPORT, PERSONAL, SIDE], ['conn-side'])].sort()).toEqual(['side@acme.com', 'support@acme.com'])
  })

  it('never picks a support inbox, even when it is the only connected mailbox', () => {
    expect(pickFlagAlertRecipient({ connections: [SUPPORT], watchedIds: ['conn-support'], ownerEmail: null })).toBeNull()
    expect(pickFlagAlertRecipient({ connections: [{ ...SUPPORT, is_primary: true }], watchedIds: [], ownerEmail: null })).toBeNull()
  })

  it('reroutes to the owner sign-in email when only a support inbox is connected', () => {
    expect(pickFlagAlertRecipient({ connections: [SUPPORT], watchedIds: ['conn-support'], ownerEmail: 'Boss@Acme.com' })).toBe('boss@acme.com')
  })

  it('prefers the primary personal mailbox', () => {
    expect(pickFlagAlertRecipient({ connections: [SUPPORT, SIDE, PERSONAL], watchedIds: ['conn-support'], ownerEmail: 'boss@acme.com' })).toBe('owner@gmail.com')
  })

  it('skips a personal mailbox that Customer Service watches', () => {
    expect(pickFlagAlertRecipient({ connections: [SUPPORT, PERSONAL, SIDE], watchedIds: ['conn-personal'], ownerEmail: null })).toBe('side@acme.com')
  })

  it('skips the owner email when it is itself a monitored mailbox', () => {
    expect(pickFlagAlertRecipient({ connections: [SUPPORT], watchedIds: [], ownerEmail: 'Acme <support@acme.com>' })).toBeNull()
  })

  it('recognises Noli notification mail by its sender address', () => {
    expect(isPlatformNotificationSender('notifications@noliai.com', 'Noli <Notifications@noliai.com>')).toBe(true)
    expect(isPlatformNotificationSender('Noli <notifications@noliai.com>', 'notifications@noliai.com')).toBe(true)
    expect(isPlatformNotificationSender('customer@example.com', 'Noli <notifications@noliai.com>')).toBe(false)
    expect(isPlatformNotificationSender('notifications@noliai.com', null)).toBe(false)
  })

  it('extracts addresses from header values', () => {
    expect(extractEmailAddresses('"Doe, Jane" <Jane@Example.com>, bob@x.co')).toEqual(['jane@example.com', 'bob@x.co'])
    expect(extractEmailAddresses(null)).toEqual([])
  })
})

describe('resolveFlagAlertRecipient (tenant and organization scoped)', () => {
  const T = 'tenant-1'
  const O = 'org-1'

  it('uses the owner sign-in email when the org only has a support inbox', async () => {
    const knex = createFakeDb({
      email_connections: [{ ...SUPPORT, organization_id: O, tenant_id: T, is_active: true }],
      customer_service_settings: [{ organization_id: O, tenant_id: T, watched_connection_ids: ['conn-support'] }],
      users: [
        { id: 'u-other-tenant', organization_id: O, tenant_id: 'tenant-2', email: 'intruder@else.com', deleted_at: null, created_at: new Date('2020-01-01') },
        { id: 'u-owner', organization_id: O, tenant_id: T, email: 'owner@acme.com', deleted_at: null, created_at: new Date('2024-01-01') },
        { id: 'u-later', organization_id: O, tenant_id: T, email: 'teammate@acme.com', deleted_at: null, created_at: new Date('2025-01-01') },
      ],
    })
    await expect(resolveFlagAlertRecipient(knex as any, { orgId: O, tenantId: T })).resolves.toBe('owner@acme.com')
  })

  it('ignores another organization\'s personal mailbox', async () => {
    const knex = createFakeDb({
      email_connections: [
        { ...SUPPORT, organization_id: O, tenant_id: T, is_active: true },
        { ...PERSONAL, id: 'conn-foreign', organization_id: 'org-2', tenant_id: T, is_active: true },
      ],
      customer_service_settings: [],
      users: [],
    })
    await expect(resolveFlagAlertRecipient(knex as any, { orgId: O, tenantId: T })).resolves.toBeNull()
  })
})
