export const metadata = { path: '/ai/realtime/session', POST: { requireAuth: true } }
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { query, queryOne } from '@/app/api/funnels/db'

// CRM tool definitions for function calling
const CRM_TOOLS = [
  {
    type: 'function' as const,
    name: 'create_contact',
    description: 'Create a new contact in the CRM. Use when the user asks to add a new person.',
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'Full name' }, email: { type: 'string', description: 'Email address' }, phone: { type: 'string', description: 'Phone number (optional)' } }, required: ['name', 'email'] },
  },
  {
    type: 'function' as const,
    name: 'create_task',
    description: 'Create a new task. Use when the user asks to add a to-do or follow-up.',
    parameters: { type: 'object', properties: { title: { type: 'string', description: 'Task title' }, contactId: { type: 'string', description: 'Contact ID to link (optional)' }, dueDate: { type: 'string', description: 'Due date ISO string (optional)' } }, required: ['title'] },
  },
  {
    type: 'function' as const,
    name: 'add_note',
    description: 'Add a note to a contact. Use when the user wants to record information about someone.',
    parameters: { type: 'object', properties: { contactId: { type: 'string', description: 'Contact ID' }, content: { type: 'string', description: 'Note content' } }, required: ['contactId', 'content'] },
  },
  {
    type: 'function' as const,
    name: 'add_tag',
    description: 'Add a tag to a contact for categorization.',
    parameters: { type: 'object', properties: { contactId: { type: 'string', description: 'Contact ID' }, tagName: { type: 'string', description: 'Tag name' } }, required: ['contactId', 'tagName'] },
  },
  {
    type: 'function' as const,
    name: 'create_deal',
    description: 'Create a new deal in the pipeline.',
    parameters: { type: 'object', properties: { title: { type: 'string', description: 'Deal title' }, contactId: { type: 'string', description: 'Contact ID (optional)' }, value: { type: 'number', description: 'Deal value in dollars (optional)' } }, required: ['title'] },
  },
  {
    type: 'function' as const,
    name: 'send_email',
    description: 'Send an email. IMPORTANT: When including links (booking pages, landing pages, etc.), use the REAL URLs from the CRM data context — never use placeholder URLs. Check BOOKING PAGES and LANDING PAGES sections for actual links.',
    parameters: { type: 'object', properties: { to: { type: 'string', description: 'Recipient email' }, subject: { type: 'string', description: 'Email subject' }, body: { type: 'string', description: 'Email body text. Use real URLs from CRM data, never placeholders.' } }, required: ['to', 'subject', 'body'] },
  },
  {
    type: 'function' as const,
    name: 'move_deal_stage',
    description: 'Move a deal to a different pipeline stage.',
    parameters: { type: 'object', properties: { dealId: { type: 'string', description: 'Deal ID' }, stage: { type: 'string', description: 'Target stage name' } }, required: ['dealId', 'stage'] },
  },
  {
    type: 'function' as const,
    name: 'create_invoice',
    description: 'Create an invoice for a contact. Pass the contact name and it will be auto-linked.',
    parameters: { type: 'object', properties: { contactName: { type: 'string', description: 'Client name (will be looked up in contacts)' }, items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, price: { type: 'number' }, quantity: { type: 'number' } } }, description: 'Line items' }, dueDate: { type: 'string', description: 'Due date (optional)' } }, required: ['contactName', 'items'] },
  },
  {
    type: 'function' as const,
    name: 'create_product',
    description: 'Create a new product or service.',
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'Product name' }, price: { type: 'number', description: 'Price' }, description: { type: 'string', description: 'Description (optional)' }, billingType: { type: 'string', enum: ['one_time', 'recurring'], description: 'Billing type' } }, required: ['name', 'price'] },
  },
  // Tier 1 Direct Actions (tools 10-25)
  {
    type: 'function' as const,
    name: 'update_contact',
    description: 'Update an existing contact. Use when the user wants to change contact info like name, email, phone, or lifecycle stage.',
    parameters: { type: 'object', properties: { contactId: { type: 'string', description: 'Contact ID' }, name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' }, lifecycleStage: { type: 'string', enum: ['prospect', 'lead', 'customer', 'inactive'] } }, required: ['contactId'] },
  },
  {
    type: 'function' as const,
    name: 'delete_contact',
    description: 'Delete a contact. Always confirm with the user before deleting.',
    parameters: { type: 'object', properties: { contactId: { type: 'string', description: 'Contact ID' } }, required: ['contactId'] },
  },
  {
    type: 'function' as const,
    name: 'search_contacts',
    description: 'Search for contacts by name, email, or tag. Returns matching contacts with their details.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search term (name, email, or tag)' } }, required: ['query'] },
  },
  {
    type: 'function' as const,
    name: 'create_reminder',
    description: 'Set a reminder or schedule a follow-up. Use this when the user says "remind me", "set a reminder", "follow up in", etc.',
    parameters: { type: 'object', properties: { message: { type: 'string', description: 'Reminder message' }, entityType: { type: 'string', enum: ['contact', 'deal', 'task'] }, entityId: { type: 'string' }, remindAt: { type: 'string', description: 'Date/time ISO string' } }, required: ['message', 'remindAt'] },
  },
  {
    type: 'function' as const,
    name: 'enroll_in_sequence',
    description: 'Enroll a contact in an email sequence for automated follow-up.',
    parameters: { type: 'object', properties: { contactId: { type: 'string', description: 'Contact ID to enroll' }, sequenceId: { type: 'string', description: 'Sequence ID' } }, required: ['contactId', 'sequenceId'] },
  },
  {
    type: 'function' as const,
    name: 'send_sms',
    description: 'Send an SMS text message to a phone number.',
    parameters: { type: 'object', properties: { to: { type: 'string', description: 'Phone number' }, message: { type: 'string', description: 'SMS message text' } }, required: ['to', 'message'] },
  },
  {
    type: 'function' as const,
    name: 'create_email_campaign',
    description: 'Create a new email campaign to send to a list of contacts.',
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'Campaign name' }, subject: { type: 'string', description: 'Email subject line' }, body: { type: 'string', description: 'Email body content' }, listId: { type: 'string', description: 'Email list ID to send to (optional)' } }, required: ['name', 'subject', 'body'] },
  },
  {
    type: 'function' as const,
    name: 'create_automation_rule',
    description: 'Create an automation rule that triggers actions based on events. Example: when a form is submitted, add a tag.',
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'Rule name' }, triggerType: { type: 'string', enum: ['contact_created', 'contact_updated', 'tag_added', 'tag_removed', 'deal_created', 'deal_won', 'deal_lost', 'stage_change', 'invoice_paid', 'form_submitted', 'booking_created', 'course_enrolled'], description: 'What triggers the rule' }, actionType: { type: 'string', enum: ['send_email', 'send_sms', 'add_tag', 'remove_tag', 'move_to_stage', 'create_task', 'enroll_in_sequence', 'webhook'], description: 'What action to take' }, triggerConfig: { type: 'object', description: 'Trigger configuration (e.g. { formId: "..." })' }, actionConfig: { type: 'object', description: 'Action configuration (e.g. { tagName: "..." })' } }, required: ['name', 'triggerType', 'actionType'] },
  },
  {
    type: 'function' as const,
    name: 'create_booking_page',
    description: 'Create a booking page where clients can schedule appointments.',
    parameters: { type: 'object', properties: { title: { type: 'string', description: 'Booking page title (e.g. "30-Minute Consultation")' }, duration: { type: 'number', description: 'Duration in minutes' }, description: { type: 'string', description: 'Description shown to bookers' } }, required: ['title', 'duration'] },
  },
  {
    type: 'function' as const,
    name: 'create_event',
    description: 'Create a CRM event. Use the user timezone (Pacific Time) when converting spoken times to ISO. "3pm" means 3pm Pacific = 15:00 Pacific. Duration MUST match what the user says (e.g. "45 minute meeting" = duration: 45).',
    parameters: { type: 'object', properties: { title: { type: 'string' }, date: { type: 'string', description: 'Event start date/time as ISO string in the user timezone. "next Wednesday at 3pm" → compute the correct ISO date for 3:00 PM Pacific.' }, duration: { type: 'number', description: 'Duration in minutes. MUST match what user says. 45-minute meeting = 45. 1 hour = 60. 90 minutes = 90.' }, location: { type: 'string' }, capacity: { type: 'number', description: 'Max attendees' }, description: { type: 'string' }, eventType: { type: 'string', enum: ['workshop', 'webinar', 'networking', 'open-house', 'product-launch', 'training', 'meetup'] } }, required: ['title', 'date', 'duration'] },
  },
  {
    type: 'function' as const,
    name: 'create_survey',
    description: 'Create a survey with questions to collect feedback.',
    parameters: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, questions: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, type: { type: 'string', enum: ['text', 'textarea', 'select', 'radio', 'rating', 'nps'] }, options: { type: 'array', items: { type: 'string' } } }, required: ['label', 'type'] } } }, required: ['title', 'questions'] },
  },
  {
    type: 'function' as const,
    name: 'create_form',
    description: 'Create a form to collect information from visitors.',
    parameters: { type: 'object', properties: { title: { type: 'string' }, fields: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, type: { type: 'string', enum: ['text', 'email', 'phone', 'textarea', 'select', 'checkbox'] }, required: { type: 'boolean' } }, required: ['label', 'type'] } } }, required: ['title', 'fields'] },
  },
  {
    type: 'function' as const,
    name: 'create_email_list',
    description: 'Create a new email mailing list.',
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'List name' }, description: { type: 'string' } }, required: ['name'] },
  },
  {
    type: 'function' as const,
    name: 'add_to_email_list',
    description: 'Add a contact to an email list.',
    parameters: { type: 'object', properties: { listId: { type: 'string' }, contactId: { type: 'string' } }, required: ['listId', 'contactId'] },
  },
  {
    type: 'function' as const,
    name: 'get_engagement_score',
    description: 'Get the engagement score and label (hot/warm/cold) for a contact.',
    parameters: { type: 'object', properties: { contactId: { type: 'string' } }, required: ['contactId'] },
  },
  {
    type: 'function' as const,
    name: 'set_reminder',
    description: 'Set a reminder. ALWAYS use this tool when the user says "remind me", "set a reminder", "follow up in", "don\'t let me forget". Do NOT use create_task for reminders.',
    parameters: { type: 'object', properties: { message: { type: 'string', description: 'What to be reminded about' }, remindAt: { type: 'string', description: 'When to remind — ISO date string in Pacific timezone' }, delayMinutes: { type: 'number', description: 'Alternative: minutes from now (e.g. 5, 30, 60, 1440 for tomorrow). Use this if user says "in 5 minutes" or "in an hour".' }, contactId: { type: 'string', description: 'Contact ID or name (optional)' } }, required: ['message'] },
  },
  // Simple edit/delete tools (intuitive names the AI naturally reaches for)
  {
    type: 'function' as const,
    name: 'edit_event',
    description: 'Edit an existing event — change its title, duration, start time, location, or capacity.',
    parameters: { type: 'object', properties: { eventId: { type: 'string', description: 'Event ID from CRM data' }, title: { type: 'string' }, duration: { type: 'number', description: 'New duration in minutes' }, date: { type: 'string', description: 'New start date/time ISO string' }, location: { type: 'string' }, capacity: { type: 'number' } }, required: ['eventId'] },
  },
  {
    type: 'function' as const,
    name: 'delete_event',
    description: 'Delete an event from the calendar.',
    parameters: { type: 'object', properties: { eventId: { type: 'string', description: 'Event ID from CRM data' } }, required: ['eventId'] },
  },
  {
    type: 'function' as const,
    name: 'edit_task',
    description: 'Edit a task — change title, due date, or mark as complete.',
    parameters: { type: 'object', properties: { taskId: { type: 'string', description: 'Task ID from CRM data' }, title: { type: 'string' }, dueDate: { type: 'string' }, markComplete: { type: 'boolean' } }, required: ['taskId'] },
  },
  {
    type: 'function' as const,
    name: 'delete_task',
    description: 'Delete a task.',
    parameters: { type: 'object', properties: { taskId: { type: 'string', description: 'Task ID from CRM data' } }, required: ['taskId'] },
  },
  {
    type: 'function' as const,
    name: 'edit_deal',
    description: 'Edit a deal — change title, value, or stage.',
    parameters: { type: 'object', properties: { dealId: { type: 'string', description: 'Deal ID from CRM data' }, title: { type: 'string' }, value: { type: 'number' }, stage: { type: 'string' } }, required: ['dealId'] },
  },
  {
    type: 'function' as const,
    name: 'delete_deal',
    description: 'Delete a deal from the pipeline.',
    parameters: { type: 'object', properties: { dealId: { type: 'string', description: 'Deal ID from CRM data' } }, required: ['dealId'] },
  },
  {
    type: 'function' as const,
    name: 'delete_landing_page',
    description: 'Delete a landing page.',
    parameters: { type: 'object', properties: { pageId: { type: 'string', description: 'Page ID from CRM data' } }, required: ['pageId'] },
  },
  {
    type: 'function' as const,
    name: 'delete_booking_page',
    description: 'Delete a booking page.',
    parameters: { type: 'object', properties: { pageId: { type: 'string', description: 'Booking page ID from CRM data' } }, required: ['pageId'] },
  },
  {
    type: 'function' as const,
    name: 'remove_tag',
    description: 'Remove a tag from a contact.',
    parameters: { type: 'object', properties: { contactId: { type: 'string', description: 'Contact ID or name' }, tagName: { type: 'string', description: 'Tag name to remove' } }, required: ['contactId', 'tagName'] },
  },
  {
    type: 'function' as const,
    name: 'complete_task',
    description: 'Mark a task as complete/done.',
    parameters: { type: 'object', properties: { taskId: { type: 'string', description: 'Task ID or title from CRM data' } }, required: ['taskId'] },
  },
  {
    type: 'function' as const,
    name: 'close_deal',
    description: 'Close a deal as won or lost.',
    parameters: { type: 'object', properties: { dealId: { type: 'string', description: 'Deal ID or title from CRM data' }, result: { type: 'string', enum: ['won', 'lost'], description: 'Whether the deal was won or lost' } }, required: ['dealId', 'result'] },
  },
  {
    type: 'function' as const,
    name: 'edit_contact',
    description: 'Edit a contact — change name, email, phone, or lifecycle stage. Same as update_contact but with a more intuitive name.',
    parameters: { type: 'object', properties: { contactId: { type: 'string', description: 'Contact ID or name' }, name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' }, lifecycleStage: { type: 'string', enum: ['prospect', 'lead', 'customer', 'inactive'] } }, required: ['contactId'] },
  },
  {
    type: 'function' as const,
    name: 'edit_product',
    description: 'Edit a product — change name, price, or description.',
    parameters: { type: 'object', properties: { productId: { type: 'string', description: 'Product ID from CRM data' }, name: { type: 'string' }, price: { type: 'number' }, description: { type: 'string' } }, required: ['productId'] },
  },
  {
    type: 'function' as const,
    name: 'delete_product',
    description: 'Delete a product.',
    parameters: { type: 'object', properties: { productId: { type: 'string', description: 'Product ID from CRM data' } }, required: ['productId'] },
  },
  {
    type: 'function' as const,
    name: 'send_invoice',
    description: 'Send an existing invoice to a client via email.',
    parameters: { type: 'object', properties: { invoiceId: { type: 'string', description: 'Invoice ID' } }, required: ['invoiceId'] },
  },
  {
    type: 'function' as const,
    name: 'delete_invoice',
    description: 'Delete an invoice.',
    parameters: { type: 'object', properties: { invoiceId: { type: 'string', description: 'Invoice ID' } }, required: ['invoiceId'] },
  },
  {
    type: 'function' as const,
    name: 'publish_landing_page',
    description: 'Publish a landing page to make it live.',
    parameters: { type: 'object', properties: { pageId: { type: 'string', description: 'Page ID from CRM data' } }, required: ['pageId'] },
  },
  {
    type: 'function' as const,
    name: 'unpublish_landing_page',
    description: 'Unpublish a landing page (take it offline).',
    parameters: { type: 'object', properties: { pageId: { type: 'string', description: 'Page ID from CRM data' } }, required: ['pageId'] },
  },
  {
    type: 'function' as const,
    name: 'cancel_event',
    description: 'Cancel an event.',
    parameters: { type: 'object', properties: { eventId: { type: 'string', description: 'Event ID from CRM data' } }, required: ['eventId'] },
  },
  {
    type: 'function' as const,
    name: 'pause_sequence',
    description: 'Pause an email sequence.',
    parameters: { type: 'object', properties: { sequenceId: { type: 'string', description: 'Sequence ID from CRM data' } }, required: ['sequenceId'] },
  },
  {
    type: 'function' as const,
    name: 'activate_sequence',
    description: 'Activate/resume a paused email sequence.',
    parameters: { type: 'object', properties: { sequenceId: { type: 'string', description: 'Sequence ID from CRM data' } }, required: ['sequenceId'] },
  },
  {
    type: 'function' as const,
    name: 'mark_invoice_paid',
    description: 'Mark an invoice as paid.',
    parameters: { type: 'object', properties: { invoiceId: { type: 'string', description: 'Invoice ID' } }, required: ['invoiceId'] },
  },
  // Tier 2 Multi-Step Workflows (tools 26-30)
  {
    type: 'function' as const,
    name: 'create_landing_page',
    description: 'Create a new landing page with AI-generated content. Ask the user for: page purpose (lead magnet, sales, booking, event), offer description, target audience, and tone before calling this tool.',
    parameters: { type: 'object', properties: { pageType: { type: 'string', enum: ['capture-leads', 'sell-digital', 'sell-service', 'book-a-call', 'promote-event'], description: 'Type of landing page' }, title: { type: 'string', description: 'Page title' }, offerDescription: { type: 'string', description: 'What the page is offering' }, targetAudience: { type: 'string', description: 'Who this page is for' }, tone: { type: 'string', enum: ['professional', 'casual', 'bold', 'friendly'], description: 'Writing tone' } }, required: ['pageType', 'title', 'offerDescription'] },
  },
  {
    type: 'function' as const,
    name: 'create_funnel',
    description: 'Create a sales funnel. Ask the user what kind of funnel (lead magnet, product launch, consultation, webinar) before calling.',
    parameters: { type: 'object', properties: { templateId: { type: 'string', enum: ['lead-magnet', 'consultation', 'product-launch', 'webinar'], description: 'Funnel template to use' }, name: { type: 'string', description: 'Funnel name' } }, required: ['templateId', 'name'] },
  },
  {
    type: 'function' as const,
    name: 'create_course',
    description: 'Create an online course with AI-generated content. Ask the user for: topic, target audience, and number of modules.',
    parameters: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, targetAudience: { type: 'string' }, moduleCount: { type: 'number', description: 'Number of modules (default 5)' }, price: { type: 'number', description: 'Price (0 for free)' } }, required: ['title'] },
  },
  {
    type: 'function' as const,
    name: 'create_email_sequence',
    description: 'Create an automated email sequence. Ask the user for: trigger (form submission, tag added, etc.), number of emails, and goal.',
    parameters: { type: 'object', properties: { name: { type: 'string' }, triggerType: { type: 'string', enum: ['form_submitted', 'tag_added', 'manual', 'deal_stage_changed'], description: 'What starts the sequence' }, emailCount: { type: 'number', description: 'Number of emails in sequence' }, goal: { type: 'string', description: 'What the sequence should achieve' }, recipeId: { type: 'string', description: 'Use a pre-built recipe (optional)' } }, required: ['name'] },
  },
  {
    type: 'function' as const,
    name: 'generate_report',
    description: 'Generate a business report. Ask the user what they want to see: pipeline, revenue, contacts, engagement, or landing page performance.',
    parameters: { type: 'object', properties: { reportType: { type: 'string', enum: ['pipeline', 'revenue', 'contacts', 'engagement', 'landing_pages', 'full_overview'], description: 'Type of report' } }, required: ['reportType'] },
  },
  // Tier 3 Read/Query Tools (tools 31-40)
  {
    type: 'function' as const,
    name: 'get_pipeline_summary',
    description: 'Get a summary of the sales pipeline: deal count, total value, breakdown by stage.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function' as const,
    name: 'get_contact_details',
    description: 'Get full details about a specific contact including their timeline, deals, tags, and engagement.',
    parameters: { type: 'object', properties: { contactId: { type: 'string', description: 'Contact ID' } }, required: ['contactId'] },
  },
  {
    type: 'function' as const,
    name: 'get_today_tasks',
    description: 'Get tasks due today and any overdue tasks.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function' as const,
    name: 'get_upcoming_events',
    description: 'Get the next upcoming events with attendee counts.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function' as const,
    name: 'get_inbox_summary',
    description: 'Get inbox summary: unread count, recent messages.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function' as const,
    name: 'get_revenue_summary',
    description: 'Get revenue summary: this month total, comparison to last month, top deals.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function' as const,
    name: 'list_sequences',
    description: 'List available email sequences with their status and enrollment counts.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function' as const,
    name: 'list_landing_pages',
    description: 'List published landing pages with view and submission counts.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function' as const,
    name: 'list_email_lists',
    description: 'List email mailing lists with member counts.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function' as const,
    name: 'list_products',
    description: 'List all products and services with their prices and billing type.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function' as const,
    name: 'list_recent_activity',
    description: 'Get recent CRM activity: new contacts, deals, form submissions, payments.',
    parameters: { type: 'object', properties: {} },
  },
  // ===== GROUPED MANAGEMENT TOOLS =====

  // CRM Core
  {
    type: 'function' as const,
    name: 'manage_deal',
    description: 'Manage deals in the pipeline. Edit deal details, close as won/lost, or delete.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['edit', 'close_won', 'close_lost', 'delete'], description: 'What to do with the deal' }, dealId: { type: 'string', description: 'Deal ID' }, title: { type: 'string' }, value: { type: 'number' }, stage: { type: 'string' } }, required: ['action', 'dealId'] },
  },
  {
    type: 'function' as const,
    name: 'manage_company',
    description: 'Manage companies. Create a company, search companies, or link/unlink a contact to a company.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['create', 'search', 'link_contact', 'unlink_contact'] }, name: { type: 'string' }, companyId: { type: 'string' }, contactId: { type: 'string' } }, required: ['action'] },
  },
  {
    type: 'function' as const,
    name: 'manage_contact_advanced',
    description: 'Advanced contact operations: merge duplicates, export contacts to CSV, set lifecycle stage, or view attachments.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['merge', 'export_csv', 'set_lifecycle_stage', 'view_attachments'] }, contactId: { type: 'string' }, targetContactId: { type: 'string', description: 'For merge: the contact to merge into' }, stage: { type: 'string', enum: ['prospect', 'lead', 'customer', 'inactive'] } }, required: ['action'] },
  },
  {
    type: 'function' as const,
    name: 'manage_task_advanced',
    description: 'Advanced task operations: edit, complete, delete, or list overdue tasks.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['edit', 'complete', 'delete', 'list_overdue'] }, taskId: { type: 'string' }, title: { type: 'string' }, dueDate: { type: 'string' } }, required: ['action'] },
  },
  {
    type: 'function' as const,
    name: 'manage_pipeline',
    description: 'Manage pipeline configuration: get current stages, update stages, or switch between deals and journey mode.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['get_stages', 'update_stages', 'switch_mode'] }, stages: { type: 'array', items: { type: 'string' }, description: 'New stage names' }, mode: { type: 'string', enum: ['deals', 'journey'] } }, required: ['action'] },
  },
  {
    type: 'function' as const,
    name: 'ai_draft_email',
    description: 'Generate an AI-drafted email. Provide context about what the email should say and the AI will write it.',
    parameters: { type: 'object', properties: { to: { type: 'string', description: 'Recipient email' }, context: { type: 'string', description: 'What the email should be about' }, tone: { type: 'string', enum: ['professional', 'casual', 'friendly', 'formal'] }, contactId: { type: 'string', description: 'Contact ID for context (optional)' } }, required: ['context'] },
  },

  // Payments
  {
    type: 'function' as const,
    name: 'manage_invoice',
    description: 'Manage invoices: send to client via email, mark as paid, edit, or delete.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['send', 'mark_paid', 'edit', 'delete'] }, invoiceId: { type: 'string' }, contactEmail: { type: 'string' }, status: { type: 'string' } }, required: ['action', 'invoiceId'] },
  },
  {
    type: 'function' as const,
    name: 'manage_product_advanced',
    description: 'Manage products: edit name/price, delete, or list all with full details.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['edit', 'delete', 'list_details'] }, productId: { type: 'string' }, name: { type: 'string' }, price: { type: 'number' }, description: { type: 'string' } }, required: ['action'] },
  },
  {
    type: 'function' as const,
    name: 'process_payment',
    description: 'Process payment operations: issue a refund or cancel a subscription.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['refund', 'cancel_subscription'] }, paymentId: { type: 'string' }, subscriptionId: { type: 'string' }, amount: { type: 'number', description: 'Refund amount (optional, full refund if omitted)' } }, required: ['action'] },
  },

  // Marketing
  {
    type: 'function' as const,
    name: 'manage_campaign',
    description: 'Manage email campaigns: edit content, send to list, send test, delete, or view stats.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['edit', 'send', 'test', 'delete', 'get_stats'] }, campaignId: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, listId: { type: 'string' } }, required: ['action'] },
  },
  {
    type: 'function' as const,
    name: 'manage_sequence_advanced',
    description: 'Manage email sequences: edit, pause, activate, delete, or view enrollments.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['edit', 'pause', 'activate', 'delete', 'list_enrollments'] }, sequenceId: { type: 'string' }, name: { type: 'string' } }, required: ['action', 'sequenceId'] },
  },
  {
    type: 'function' as const,
    name: 'manage_email_list_advanced',
    description: 'Manage email lists: edit name, delete, add multiple contacts, remove a member.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['edit', 'delete', 'add_bulk', 'remove_member'] }, listId: { type: 'string' }, name: { type: 'string' }, contactIds: { type: 'array', items: { type: 'string' } }, contactId: { type: 'string' } }, required: ['action', 'listId'] },
  },
  {
    type: 'function' as const,
    name: 'manage_landing_page',
    description: 'Manage landing pages: edit, publish, unpublish, delete, or view analytics.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['edit', 'publish', 'unpublish', 'delete', 'get_analytics'] }, pageId: { type: 'string' }, title: { type: 'string' } }, required: ['action', 'pageId'] },
  },
  {
    type: 'function' as const,
    name: 'manage_funnel',
    description: 'Manage sales funnels: edit steps, publish, unpublish, delete, duplicate, or view analytics.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['edit', 'publish', 'unpublish', 'delete', 'duplicate', 'get_analytics'] }, funnelId: { type: 'string' }, name: { type: 'string' } }, required: ['action', 'funnelId'] },
  },

  // Events & Calendar
  {
    type: 'function' as const,
    name: 'manage_event_advanced',
    description: 'Manage events: edit (title, date, duration, location, capacity), publish, delete, cancel, email attendees, or get attendee list.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['edit', 'publish', 'delete', 'cancel', 'email_attendees', 'get_attendees'] }, eventId: { type: 'string' }, title: { type: 'string' }, date: { type: 'string', description: 'New start date/time ISO string' }, duration: { type: 'number', description: 'Duration in minutes' }, location: { type: 'string' }, capacity: { type: 'number' }, description: { type: 'string' }, eventType: { type: 'string' }, message: { type: 'string', description: 'Email message to attendees' } }, required: ['action', 'eventId'] },
  },
  {
    type: 'function' as const,
    name: 'manage_booking',
    description: 'Manage bookings and booking pages: confirm, cancel, delete bookings, or edit/delete booking pages.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['confirm', 'cancel', 'delete', 'edit_page', 'delete_page'] }, bookingId: { type: 'string' }, pageId: { type: 'string' }, title: { type: 'string' } }, required: ['action'] },
  },
  {
    type: 'function' as const,
    name: 'manage_calendar',
    description: 'View calendar or block time off. For block_time: provide start time as ISO string and duration in minutes.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['get_today', 'get_week', 'block_time'] }, date: { type: 'string', description: 'Start date/time as ISO string (e.g. "tomorrow at 2pm" → ISO in Pacific time)' }, duration: { type: 'number', description: 'Duration in minutes (e.g. 60 for 1 hour)' }, reason: { type: 'string', description: 'Reason for blocking (e.g. "Focus time", "Lunch")' } }, required: ['action'] },
  },

  // Content & Forms
  {
    type: 'function' as const,
    name: 'manage_survey_advanced',
    description: 'Manage surveys: edit, toggle active/inactive, send via email, delete, or view responses.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['edit', 'toggle_active', 'send', 'delete', 'get_responses'] }, surveyId: { type: 'string' }, title: { type: 'string' }, contactEmail: { type: 'string', description: 'For send action' } }, required: ['action', 'surveyId'] },
  },
  {
    type: 'function' as const,
    name: 'manage_form_advanced',
    description: 'Manage forms: edit, delete, duplicate, or view submissions.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['edit', 'delete', 'duplicate', 'get_submissions'] }, formId: { type: 'string' }, name: { type: 'string' }, fields: { type: 'array', items: { type: 'object' } } }, required: ['action', 'formId'] },
  },
  {
    type: 'function' as const,
    name: 'manage_course_advanced',
    description: 'Manage courses: edit, publish, delete, generate AI outline, generate landing page copy, add modules or lessons.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['edit', 'publish', 'delete', 'generate_outline', 'generate_landing', 'add_module', 'add_lesson'] }, courseId: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, targetAudience: { type: 'string' }, moduleId: { type: 'string' } }, required: ['action', 'courseId'] },
  },

  // Communication
  {
    type: 'function' as const,
    name: 'manage_chat_widget',
    description: 'Manage chat widgets: create, edit, delete, toggle active, or view conversations.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['create', 'edit', 'delete', 'toggle_active', 'get_conversations'] }, widgetId: { type: 'string' }, name: { type: 'string' }, greeting: { type: 'string' }, personality: { type: 'string' } }, required: ['action'] },
  },
  {
    type: 'function' as const,
    name: 'manage_inbox_conversation',
    description: 'Manage inbox conversations: reply, mark as read, close, reopen, add internal note, or generate AI draft reply.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['reply', 'mark_read', 'close', 'reopen', 'add_note', 'ai_draft'] }, conversationId: { type: 'string' }, message: { type: 'string' }, channel: { type: 'string', enum: ['email', 'sms', 'chat'] } }, required: ['action'] },
  },

  // Business Operations
  {
    type: 'function' as const,
    name: 'manage_affiliate',
    description: 'Manage affiliate program: create campaigns, add affiliates, approve/reject, pause, or manage payouts.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['create_campaign', 'add_affiliate', 'approve', 'reject', 'pause', 'create_payout'] }, affiliateId: { type: 'string' }, campaignId: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' }, commissionRate: { type: 'number' } }, required: ['action'] },
  },
  {
    type: 'function' as const,
    name: 'manage_automation_advanced',
    description: 'Manage automation rules: edit, enable, disable, delete, test, duplicate, or view execution logs.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['edit', 'enable', 'disable', 'delete', 'test', 'duplicate', 'get_logs'] }, ruleId: { type: 'string' }, name: { type: 'string' } }, required: ['action', 'ruleId'] },
  },
  {
    type: 'function' as const,
    name: 'update_settings',
    description: 'Update CRM settings: business profile, pipeline configuration, AI persona, or invite team members.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['update_profile', 'update_pipeline', 'update_persona', 'invite_team'] }, businessName: { type: 'string' }, businessType: { type: 'string' }, pipelineMode: { type: 'string', enum: ['deals', 'journey'] }, pipelineStages: { type: 'array', items: { type: 'string' } }, personaName: { type: 'string' }, personaStyle: { type: 'string', enum: ['professional', 'casual', 'minimal'] }, teamEmail: { type: 'string' }, teamRole: { type: 'string', enum: ['admin', 'member'] } }, required: ['action'] },
  },
]

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  const userId = auth?.sub
  if (!auth?.tenantId || !auth?.orgId || !userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: 'OpenAI API key not configured' }, { status: 500 })
  }

  try {
    const body = await req.json().catch(() => ({}))
    // Realtime API voices: alloy, ash, ballad, coral, echo, sage, shimmer, verse
    const validVoices = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse']
    const voice = validVoices.includes(body.voice) ? body.voice : 'alloy'

    // Load persona
    const profile = await queryOne(
      'SELECT ai_persona_name, ai_persona_style, ai_custom_instructions, business_name, business_type, business_description FROM business_profiles WHERE organization_id = $1',
      [auth.orgId]
    )

    const personaName = profile?.ai_persona_name || 'Scout'
    const personaStyle = profile?.ai_persona_style || 'professional'

    // Build persona prompt
    const stylePrompts: Record<string, string> = {
      professional: `You are ${personaName}, a sharp and efficient business assistant. Be direct, data-driven, and proactive. Use professional language. Get to the point quickly.`,
      casual: `You are ${personaName}, a friendly and encouraging business partner. Be warm, conversational, and supportive. Feel like a helpful friend who's great at business.`,
      minimal: `You are ${personaName}. Be extremely concise. Only speak when valuable. No filler. Just substance.`,
    }

    let instructions = stylePrompts[personaStyle] || stylePrompts.professional
    if (profile?.business_name) instructions += `
Business: ${profile.business_name}`
    if (profile?.business_type) instructions += `
Type: ${profile.business_type}`
    if (profile?.business_description) instructions += `
Description: ${profile.business_description}`
    if (profile?.ai_custom_instructions) instructions += `
CUSTOM INSTRUCTIONS:
${profile.ai_custom_instructions}`

    instructions += `

You have 65 tools to FULLY control the CRM. You can CREATE, EDIT, DELETE, and MANAGE everything. NEVER say "I can't do that" — if the user asks you to edit, delete, or change something, USE THE APPROPRIATE TOOL.

CREATE: create_contact, create_task, add_note, add_tag, create_deal, send_email, move_deal_stage, create_invoice, create_product, create_reminder, enroll_in_sequence, send_sms, create_email_campaign, create_automation_rule, create_booking_page, create_event, create_survey, create_form, create_email_list, add_to_email_list

EDIT/DELETE/MANAGE (use "action" parameter: edit, delete, publish, etc.):
- manage_event_advanced — EDIT event duration/time/title, DELETE events, publish, cancel, email attendees. To change duration: pass action="edit" with eventId and duration (minutes).
- manage_deal — EDIT deal title/value/stage, close as won/lost, DELETE deals
- manage_task_advanced — EDIT tasks, mark complete, DELETE tasks
- manage_landing_page — EDIT page title, publish/unpublish, DELETE pages
- manage_contact_advanced — merge contacts, set lifecycle stage, view attachments
- manage_booking — confirm/cancel/delete bookings, edit/delete booking pages
- manage_calendar — view today/week schedule, block time off
- manage_invoice — send invoice, mark as paid, DELETE
- manage_product_advanced — EDIT product name/price, DELETE
- manage_campaign — EDIT campaign, send, test, DELETE
- manage_sequence_advanced — pause, activate, EDIT, DELETE sequences
- manage_email_list_advanced — EDIT lists, add/remove members, DELETE
- manage_funnel — publish/unpublish, DELETE, view analytics
- manage_survey_advanced — EDIT, toggle active, DELETE, view responses
- manage_form_advanced — EDIT, DELETE, view submissions
- manage_course_advanced — EDIT, publish, DELETE, generate AI outline
- manage_chat_widget — create, EDIT, DELETE, toggle active
- manage_automation_advanced — enable, disable, EDIT, DELETE, test
- update_settings — update business profile, pipeline config, AI persona, invite team
- Also: update_contact, delete_contact, search_contacts, get_engagement_score

QUERY: get_pipeline_summary, get_contact_details, get_today_tasks, get_upcoming_events, get_inbox_summary, get_revenue_summary, list_sequences, list_landing_pages, list_email_lists, list_products, list_recent_activity

COMPLEX (ask follow-up questions first): create_landing_page, create_funnel, create_course, create_email_sequence, generate_report, ai_draft_email

When editing/deleting, use the id= values from the CRM DATA section below. You can also pass item names and they'll be auto-resolved. Always confirm DELETE actions with the user first.`

    // Load user info and email connections
    const orgId = auth.orgId
    const tenantId = auth.tenantId

    const [currentUser, emailConnections, espConnection] = await Promise.all([
      queryOne('SELECT name, email FROM users WHERE id = $1', [userId]).catch(() => null),
      query('SELECT provider, email_address, is_primary FROM email_connections WHERE organization_id = $1 AND user_id = $2 AND is_active = true ORDER BY is_primary DESC', [orgId, userId]).catch(() => []),
      queryOne('SELECT provider, default_sender_name, default_sender_email FROM esp_connections WHERE organization_id = $1 AND is_active = true LIMIT 1', [orgId]).catch(() => null),
    ])

    const userName = currentUser?.name || 'User'
    const userEmail = currentUser?.email || ''

    // Load CRM data context
    const [contactCount, dealCount, taskCount, invoiceCount, sequences, emailLists, landingPages, forms, bookingPages] = await Promise.all([
      queryOne('SELECT count(*)::int as total FROM customer_entities WHERE organization_id = $1 AND deleted_at IS NULL AND kind = $2', [orgId, 'person']),
      queryOne('SELECT count(*)::int as total, count(*) filter (where status IS NULL or status NOT IN ($2,$3))::int as open_count, coalesce(sum(value_amount),0)::numeric as total_value FROM customer_deals WHERE organization_id = $1 AND deleted_at IS NULL', [orgId, 'win', 'lose']),
      queryOne('SELECT count(*) filter (where is_done = false)::int as open, count(*) filter (where is_done = true)::int as done FROM tasks WHERE organization_id = $1', [orgId]),
      queryOne('SELECT count(*)::int as total FROM invoices WHERE organization_id = $1', [orgId]),
      query('SELECT id, name, is_active FROM sequences WHERE organization_id = $1 LIMIT 10', [orgId]).catch(() => []),
      query('SELECT id, name, member_count FROM email_lists WHERE organization_id = $1 LIMIT 10', [orgId]).catch(() => []),
      query('SELECT id, title, status, slug, view_count, submission_count FROM landing_pages WHERE organization_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 10', [orgId]).catch(() => []),
      query('SELECT id, title, submission_count FROM forms WHERE organization_id = $1 LIMIT 10', [orgId]).catch(() => []),
      query('SELECT id, title, slug FROM booking_pages WHERE organization_id = $1 LIMIT 10', [orgId]).catch(() => []),
    ])

    const recentContacts = await query(
      'SELECT id, display_name, primary_email, lifecycle_stage FROM customer_entities WHERE organization_id = $1 AND deleted_at IS NULL AND kind = $2 ORDER BY created_at DESC LIMIT 10',
      [orgId, 'person']
    )

    const recentDeals = await query(
      'SELECT id, title, pipeline_stage, value_amount, status FROM customer_deals WHERE organization_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 10',
      [orgId]
    )

    const recentEvents = await query(
      'SELECT id, title, event_type, status, start_time, end_time FROM events WHERE organization_id = $1 AND deleted_at IS NULL ORDER BY start_time DESC LIMIT 10',
      [orgId]
    ).catch(() => [])

    const recentTasks = await query(
      'SELECT id, title, is_done, due_date FROM tasks WHERE organization_id = $1 AND is_done = false ORDER BY due_date ASC NULLS LAST LIMIT 10',
      [orgId]
    ).catch(() => [])

    let dataContext = `

CURRENT CRM DATA (use these IDs when editing/deleting items):
`
    dataContext += `CONTACTS: ${contactCount?.total || 0} people
`
    if (recentContacts.length > 0) {
      dataContext += `Recent contacts:
${recentContacts.map((c: any) => `  - "${c.display_name}" (${c.primary_email || 'no email'}) [${c.lifecycle_stage || 'prospect'}] id=${c.id}`).join('\n')}
`
    }
    dataContext += `PIPELINE: ${dealCount?.total || 0} deals (${dealCount?.open_count || 0} open), $${Number(dealCount?.total_value || 0).toLocaleString()} total value
`
    if (recentDeals.length > 0) {
      dataContext += `Recent deals:
${recentDeals.map((d: any) => `  - "${d.title}" — ${d.pipeline_stage || 'Unassigned'} ($${Number(d.value_amount || 0).toLocaleString()}) id=${d.id}`).join('\n')}
`
    }
    dataContext += `TASKS: ${taskCount?.open || 0} open, ${taskCount?.done || 0} completed
`
    if ((recentTasks as any[]).length > 0) {
      dataContext += `Open tasks:
${(recentTasks as any[]).map((t: any) => `  - "${t.title}" ${t.due_date ? `due ${new Date(t.due_date).toLocaleDateString()}` : '(no due date)'} id=${t.id}`).join('\n')}
`
    }
    if ((recentEvents as any[]).length > 0) {
      dataContext += `Events:
${(recentEvents as any[]).map((e: any) => `  - "${e.title}" (${e.event_type || 'event'}) ${e.start_time ? new Date(e.start_time).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short' }) : ''} [${e.status}] id=${e.id}`).join('\n')}
`
    }
    dataContext += `INVOICES: ${invoiceCount?.total || 0} total
`
    if ((sequences as any[]).length > 0) {
      dataContext += `SEQUENCES:
${(sequences as any[]).map((s: any) => `  - "${s.name}" (${s.is_active ? 'active' : 'paused'}) id=${s.id}`).join('\n')}
`
    }
    if ((emailLists as any[]).length > 0) {
      dataContext += `EMAIL LISTS:
${(emailLists as any[]).map((l: any) => `  - "${l.name}" (${l.member_count || 0} members) id=${l.id}`).join('\n')}
`
    }
    const baseUrl = process.env.APP_URL || 'http://localhost:3000'
    if ((landingPages as any[]).length > 0) {
      dataContext += `LANDING PAGES:
${(landingPages as any[]).map((p: any) => `  - "${p.title}" [${p.status}] ${p.view_count || 0} views, ${p.submission_count || 0} leads${p.slug ? ` — link: ${baseUrl}/p/${p.slug}` : ''} id=${p.id}`).join('\n')}
`
    }
    if ((forms as any[]).length > 0) {
      dataContext += `FORMS:
${(forms as any[]).map((f: any) => `  - "${f.title}" (${f.submission_count || 0} submissions) id=${f.id}`).join('\n')}
`
    }
    if ((bookingPages as any[]).length > 0) {
      dataContext += `BOOKING PAGES:
${(bookingPages as any[]).map((b: any) => `  - "${b.title}" — link: ${baseUrl}/book/${b.slug} id=${b.id}`).join('\n')}
`
    }

    instructions += dataContext

    // Add user identity context
    const now = new Date()
    instructions += `

USER IDENTITY:
Name: ${userName}
Email: ${userEmail}
Timezone: America/Los_Angeles (Pacific Time)
Current date/time: ${now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'full', timeStyle: 'short' })}
ISO now: ${now.toISOString()}
`

    // Add email provider context
    const connectedProviders = (emailConnections as any[])
    if (connectedProviders.length > 0) {
      instructions += `
EMAIL PROVIDERS CONNECTED:
`
      connectedProviders.forEach((c: any) => {
        instructions += `- ${c.provider.toUpperCase()}: ${c.email_address}${c.is_primary ? ' (primary)' : ''}
`
      })
      instructions += `Emails will be sent from the primary connected provider automatically. You do NOT need to ask which provider to use.
`
    } else {
      instructions += `
NO EMAIL PROVIDER CONNECTED. `
    }
    if (espConnection) {
      instructions += `ESP backup: ${espConnection.provider} (${espConnection.default_sender_email || 'configured'})
`
    }
    if (!connectedProviders.length && !espConnection) {
      instructions += `The user has no email providers connected. Emails will go to console only. Suggest they connect Gmail or Outlook in Settings.
`
    }

    instructions += `

IMPORTANT — USING IDs:
When editing, deleting, or managing existing items, you MUST pass the item's ID (the id= value from the CRM data above). The system can also look up items by name, but using the ID is faster and more reliable. When the user says "delete that event" or "edit the networking event", find the matching item in the CRM data above and use its id= value.

BEHAVIOR GUIDELINES:
- You are a voice assistant. Keep responses concise and conversational — you're speaking out loud, not writing an essay.
- When sending emails, the sender name "${userName}" and email address are set automatically. Do NOT use placeholders.
- NEVER use placeholder URLs like "https://yourwebsite.com/..." or "[link]" in emails. ALWAYS use REAL URLs from the CRM data above. For booking pages, use the exact booking link shown in the BOOKING PAGES section. For landing pages, use the exact link shown in LANDING PAGES. If you don't have a real URL, tell the user you need to create the page first before sending a link.
- When sending an email that includes a booking link, look up the booking page URL from the BOOKING PAGES data above and use it verbatim. Example: if the data says 'link: ${baseUrl}/book/discovery-call-123', put exactly that URL in the email.
- For COMPLEX WORKFLOWS (landing pages, courses, funnels, sequences): ask follow-up questions FIRST to gather all needed information, then call the tool. Don't assume details.
- For SIMPLE ACTIONS (create contact, send email, create task): execute immediately with the info given. Ask only if critical info is missing (e.g., no email address for send_email).
- You CAN create booking pages with real links. Use the create_booking_page tool. After creation, the tool returns the actual booking URL — share it with the user. Existing booking page links are listed in the BOOKING PAGES section above.
- Always confirm before taking DESTRUCTIVE actions (delete, send to many contacts).
- If a tool call fails, report the error honestly. Do NOT retry automatically — tell the user what went wrong.
- When the user asks about Google Meet links: you cannot create Google Meet links directly. Suggest they create the meeting in Google Calendar and share the link.`

    // Create ephemeral client secret with OpenAI GA endpoint
    const sessionRes = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    })

    if (!sessionRes.ok) {
      const err = await sessionRes.text().catch(() => '')
      console.error('[realtime.session] OpenAI error:', sessionRes.status, err)
      return NextResponse.json({ ok: false, error: 'Failed to create realtime session' }, { status: 500 })
    }

    const sessionData = await sessionRes.json()

    // Return the ephemeral key + session config (client will send session.update after connecting)
    return NextResponse.json({
      ok: true,
      data: {
        clientSecret: sessionData.value,
        model: 'gpt-4o-realtime-preview-2024-12-17',
        voice,
        personaName,
        // Session config to be sent via session.update after WebSocket connects
        sessionConfig: {
          type: 'realtime',
          instructions,
          tools: CRM_TOOLS,
          tool_choice: 'auto',
          audio: {
            input: {
              transcription: { model: 'gpt-4o-mini-transcribe' },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 500,
                create_response: true,
                interrupt_response: true,
              },
            },
            output: {
              voice,
            },
          },
        },
      },
    })
  } catch (error) {
    console.error('[realtime.session]', error)
    return NextResponse.json({ ok: false, error: 'Failed to create session' }, { status: 500 })
  }
}
