import { createModuleEvents } from '@open-mercato/shared/modules/events'

const events = [
  // Existing pre-tier-1 events (lifecycle)
  { id: 'email.message.sent', label: 'Email Sent', entity: 'message', category: 'lifecycle' as const },
  { id: 'email.message.received', label: 'Email Received', entity: 'message', category: 'lifecycle' as const },
  { id: 'email.message.opened', label: 'Email Opened', entity: 'message', category: 'lifecycle' as const },
  { id: 'email.message.clicked', label: 'Email Link Clicked', entity: 'message', category: 'lifecycle' as const },
  { id: 'email.message.bounced', label: 'Email Bounced', entity: 'message', category: 'lifecycle' as const },
  { id: 'email.campaign.sent', label: 'Campaign Sent', entity: 'campaign', category: 'lifecycle' as const },
  { id: 'email.campaign.completed', label: 'Campaign Completed', entity: 'campaign', category: 'lifecycle' as const },

  // Tier 1 events (SPEC-061 mercato rebuild) — CRUD events for the
  // promoted entities. Workflows, automations, and audit logs key off these.

  // Messages — CRUD beyond the existing lifecycle events
  { id: 'email.message.created', label: 'Email Message Created', entity: 'message', category: 'crud' as const },
  { id: 'email.message.updated', label: 'Email Message Updated', entity: 'message', category: 'crud' as const },
  { id: 'email.message.deleted', label: 'Email Message Deleted', entity: 'message', category: 'crud' as const },

  // Campaigns — CRUD beyond the existing lifecycle events
  { id: 'email.campaign.created', label: 'Campaign Created', entity: 'campaign', category: 'crud' as const },
  { id: 'email.campaign.updated', label: 'Campaign Updated', entity: 'campaign', category: 'crud' as const },
  { id: 'email.campaign.deleted', label: 'Campaign Deleted', entity: 'campaign', category: 'crud' as const },

  // Templates
  { id: 'email.template.created', label: 'Email Template Created', entity: 'template', category: 'crud' as const },
  { id: 'email.template.updated', label: 'Email Template Updated', entity: 'template', category: 'crud' as const },
  { id: 'email.template.deleted', label: 'Email Template Deleted', entity: 'template', category: 'crud' as const },

  // Style templates
  { id: 'email.style_template.created', label: 'Style Template Created', entity: 'style_template', category: 'crud' as const },
  { id: 'email.style_template.updated', label: 'Style Template Updated', entity: 'style_template', category: 'crud' as const },
  { id: 'email.style_template.deleted', label: 'Style Template Deleted', entity: 'style_template', category: 'crud' as const },

  // Email connections (Gmail/Outlook/SMTP)
  { id: 'email.connection.created', label: 'Email Connection Created', entity: 'connection', category: 'crud' as const },
  { id: 'email.connection.updated', label: 'Email Connection Updated', entity: 'connection', category: 'crud' as const },
  { id: 'email.connection.deleted', label: 'Email Connection Deleted', entity: 'connection', category: 'crud' as const },

  // ESP connections (Resend/SendGrid/SES/Mailgun)
  { id: 'email.esp_connection.created', label: 'ESP Connection Created', entity: 'esp_connection', category: 'crud' as const },
  { id: 'email.esp_connection.updated', label: 'ESP Connection Updated', entity: 'esp_connection', category: 'crud' as const },
  { id: 'email.esp_connection.deleted', label: 'ESP Connection Deleted', entity: 'esp_connection', category: 'crud' as const },

  // ESP sender addresses
  { id: 'email.sender_address.created', label: 'Sender Address Created', entity: 'sender_address', category: 'crud' as const },
  { id: 'email.sender_address.updated', label: 'Sender Address Updated', entity: 'sender_address', category: 'crud' as const },
  { id: 'email.sender_address.deleted', label: 'Sender Address Deleted', entity: 'sender_address', category: 'crud' as const },

  // Email lists + members
  { id: 'email.list.created', label: 'Email List Created', entity: 'list', category: 'crud' as const },
  { id: 'email.list.updated', label: 'Email List Updated', entity: 'list', category: 'crud' as const },
  { id: 'email.list.deleted', label: 'Email List Deleted', entity: 'list', category: 'crud' as const },
  { id: 'email.list_member.added', label: 'Contact Added to Email List', entity: 'list_member', category: 'crud' as const },
  { id: 'email.list_member.removed', label: 'Contact Removed from Email List', entity: 'list_member', category: 'crud' as const },

  // Email routing config
  { id: 'email.routing.updated', label: 'Email Routing Updated', entity: 'routing', category: 'crud' as const },

  // Preferences
  { id: 'email.preference.opted_in', label: 'Email Preference Opted In', entity: 'preference', category: 'crud' as const },
  { id: 'email.preference.opted_out', label: 'Email Preference Opted Out', entity: 'preference', category: 'crud' as const },
  { id: 'email.preference_category.created', label: 'Preference Category Created', entity: 'preference_category', category: 'crud' as const },
  { id: 'email.preference_category.updated', label: 'Preference Category Updated', entity: 'preference_category', category: 'crud' as const },
  { id: 'email.preference_category.deleted', label: 'Preference Category Deleted', entity: 'preference_category', category: 'crud' as const },

  // Inbox intelligence
  { id: 'email.intelligence.enabled', label: 'Inbox Intelligence Enabled', entity: 'intelligence', category: 'lifecycle' as const },
  { id: 'email.intelligence.disabled', label: 'Inbox Intelligence Disabled', entity: 'intelligence', category: 'lifecycle' as const },
  { id: 'email.intelligence.synced', label: 'Inbox Intelligence Synced', entity: 'intelligence', category: 'lifecycle' as const },

  // Unsubscribes (already exists but adding lifecycle event for clarity)
  { id: 'email.unsubscribed', label: 'Contact Unsubscribed', entity: 'unsubscribe', category: 'lifecycle' as const },
] as const

export const eventsConfig = createModuleEvents({ moduleId: 'email', events })
export default eventsConfig
