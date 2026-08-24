export const GTM_MAILBOX_INGEST_QUEUE = 'gtm-mailbox-ingest'

type GtmMailboxQueueEnv = {
  GTM_MAILBOX_QUEUE_STRATEGY?: string
  QUEUE_STRATEGY?: string
}

export function resolveGtmMailboxQueueStrategy(
  env: GtmMailboxQueueEnv = process.env as GtmMailboxQueueEnv,
): string {
  return env.GTM_MAILBOX_QUEUE_STRATEGY ?? env.QUEUE_STRATEGY ?? 'local'
}

export type GtmMailboxIngestJob = {
  organizationId: string
  tenantId: string
  mailboxConnectionId: string
  requestedByUserId: string
}
