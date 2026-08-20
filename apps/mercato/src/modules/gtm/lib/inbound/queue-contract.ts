export const GTM_MAILBOX_INGEST_QUEUE = 'gtm-mailbox-ingest'

export type GtmMailboxIngestJob = {
  organizationId: string
  tenantId: string
  mailboxConnectionId: string
  requestedByUserId: string
}
