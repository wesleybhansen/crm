export const features = [
  { id: 'email.view', title: 'View emails', module: 'email' },
  { id: 'email.send', title: 'Send emails', module: 'email' },
  { id: 'email.campaigns.view', title: 'View campaigns', module: 'email' },
  { id: 'email.campaigns.manage', title: 'Manage campaigns', module: 'email' },
  { id: 'email.templates.manage', title: 'Manage email templates', module: 'email' },
  { id: 'email.accounts.manage', title: 'Manage email accounts', module: 'email' },
  // Tier 1 features (SPEC-061 mercato rebuild) — promoted from raw routes
  { id: 'email.connections.view', title: 'View email connections', module: 'email' },
  { id: 'email.connections.manage', title: 'Manage email connections (Gmail/Outlook/SMTP)', module: 'email' },
  { id: 'email.esp.view', title: 'View ESP connections', module: 'email' },
  { id: 'email.esp.manage', title: 'Manage ESP connections (Resend/SendGrid/SES/Mailgun)', module: 'email' },
  { id: 'email.sender_addresses.view', title: 'View ESP sender addresses', module: 'email' },
  { id: 'email.sender_addresses.manage', title: 'Manage ESP sender addresses', module: 'email' },
  { id: 'email.style_templates.view', title: 'View email style templates', module: 'email' },
  { id: 'email.style_templates.manage', title: 'Manage email style templates', module: 'email' },
  { id: 'email.routing.view', title: 'View email routing config', module: 'email' },
  { id: 'email.routing.manage', title: 'Manage email routing config', module: 'email' },
  { id: 'email.lists.view', title: 'View email lists', module: 'email' },
  { id: 'email.lists.manage', title: 'Manage email lists and members', module: 'email' },
  { id: 'email.preferences.view', title: 'View contact email preferences', module: 'email' },
  { id: 'email.preferences.manage', title: 'Manage contact email preferences', module: 'email' },
  { id: 'email.preference_categories.view', title: 'View email preference categories', module: 'email' },
  { id: 'email.preference_categories.manage', title: 'Manage email preference categories', module: 'email' },
  { id: 'email.intelligence.view', title: 'View inbox intelligence settings', module: 'email' },
  { id: 'email.intelligence.manage', title: 'Manage inbox intelligence settings', module: 'email' },
]

export default features
