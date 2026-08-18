import { LockMode } from '@mikro-orm/core'
import { GtmMailboxPolicy } from '../../data/entities'
import type { GtmCtx, SendWindow } from '../campaign/build'
import type { ExecutionEm, FrozenSendSettings } from './schedule'

export const MAILBOX_CAPACITY_POLICY_VERSION = 'mailbox-capacity-v1'

export class GtmMailboxPolicyError extends Error {
  constructor(
    public code: 'mailbox_policy_conflict' | 'mailbox_policy_missing',
    message: string,
  ) {
    super(message)
    this.name = 'GtmMailboxPolicyError'
  }
}

export type MailboxPolicySettings = Pick<FrozenSendSettings, 'daily_cap' | 'send_window'>

export function mailboxPolicyMatchesSettings(
  policy: GtmMailboxPolicy,
  settings: MailboxPolicySettings,
): boolean {
  return policy.policyVersion === MAILBOX_CAPACITY_POLICY_VERSION
    && policy.dailyCap === settings.daily_cap
    && policy.sendWindowStartHour === settings.send_window.start_hour
    && policy.sendWindowEndHour === settings.send_window.end_hour
    && policy.timezone === settings.send_window.timezone
}

export function settingsFromMailboxPolicy(policy: GtmMailboxPolicy): MailboxPolicySettings {
  const send_window: SendWindow = {
    start_hour: policy.sendWindowStartHour,
    end_hour: policy.sendWindowEndHour,
    timezone: policy.timezone,
  }
  return { daily_cap: policy.dailyCap, send_window }
}

export async function bindCanonicalMailboxPolicy(
  em: ExecutionEm,
  ctx: Pick<GtmCtx, 'organizationId' | 'tenantId'>,
  input: {
    mailboxConnectionId: string
    campaignVersionId: string
    settings: MailboxPolicySettings
  },
): Promise<GtmMailboxPolicy> {
  const existing = await em.findOne(
    GtmMailboxPolicy,
    {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      mailboxConnectionId: input.mailboxConnectionId,
      deletedAt: null,
    },
    { lockMode: LockMode.PESSIMISTIC_WRITE },
  )
  if (existing) {
    if (!mailboxPolicyMatchesSettings(existing, input.settings)) {
      throw new GtmMailboxPolicyError(
        'mailbox_policy_conflict',
        'The approved campaign capacity settings conflict with this mailbox policy',
      )
    }
    return existing
  }
  const policy = em.create(GtmMailboxPolicy, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    mailboxConnectionId: input.mailboxConnectionId,
    policyVersion: MAILBOX_CAPACITY_POLICY_VERSION,
    dailyCap: input.settings.daily_cap,
    sendWindowStartHour: input.settings.send_window.start_hour,
    sendWindowEndHour: input.settings.send_window.end_hour,
    timezone: input.settings.send_window.timezone,
    boundByCampaignVersionId: input.campaignVersionId,
    fence: 0,
  })
  em.persist(policy)
  await em.flush()
  return policy
}
