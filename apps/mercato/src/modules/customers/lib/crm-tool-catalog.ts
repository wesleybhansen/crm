/* The CRM tool catalog — the single source of truth for what the AI can do.
 * Extracted from the voice realtime session route (T2b) so every AI surface
 * (voice today; text Scout and the MCP layer as they migrate) draws from ONE
 * capability list instead of three divergent ones.
 * Shape = OpenAI Realtime function-tool definitions. */

// CRM tool definitions for function calling
export const CRM_TOOLS = [
  {
    type: 'function' as const,
    name: 'find_entity',
    description: 'Resolve an item by its name to an ID. Use BEFORE editing, deleting, or managing any item the user references by name ("delete the Acme deal", "update Maria\'s phone number"). Returns candidate matches with their IDs. If exactly one match: use its id in your next tool call. If zero: tell the user. If multiple: ask the user which one. Do NOT guess IDs from context — always verify via this tool before a destructive or edit action.',
    parameters: { type: 'object', properties: { entityType: { type: 'string', enum: ['contact', 'deal', 'task', 'event', 'product', 'landing_page', 'booking_page', 'sequence', 'form', 'survey', 'course', 'invoice'], description: 'Kind of item to look up' }, query: { type: 'string', description: 'Name, title, or email to search for' } }, required: ['entityType', 'query'] },
  },
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
    name: 'add_commitment',
    description: 'Record a commitment (a promise made in either direction): "I told them I would send the proposal by Friday" or "they said they would review it next week". Commitments surface in meeting prep so promises never get dropped.',
    parameters: { type: 'object', properties: { contactId: { type: 'string', description: 'Contact ID' }, description: { type: 'string', description: 'One sentence: who promised what' }, direction: { type: 'string', enum: ['ours', 'theirs'], description: 'ours = we promised, theirs = they promised' }, dueDate: { type: 'string', description: 'YYYY-MM-DD (optional)' } }, required: ['contactId', 'description', 'direction'] },
  },
  {
    type: 'function' as const,
    name: 'list_commitments',
    description: 'List open commitments (promises) for a contact, both what we owe them and what they owe us.',
    parameters: { type: 'object', properties: { contactId: { type: 'string', description: 'Contact ID' } }, required: ['contactId'] },
  },
  {
    type: 'function' as const,
    name: 'resolve_commitment',
    description: 'Mark a commitment as kept/resolved (or dismissed if no longer relevant).',
    parameters: { type: 'object', properties: { commitmentId: { type: 'string', description: 'Commitment ID' }, action: { type: 'string', enum: ['resolve', 'dismiss'], description: 'resolve = promise kept; dismiss = no longer relevant' } }, required: ['commitmentId', 'action'] },
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

// Read-only tools: non-mutating lookups whose whole value is the returned data.
// The text Scout UI auto-executes these WITHOUT a confirm prompt and feeds the
// result back to the model so it can answer from real data (voice already gets
// this via function_call_output). Everything not listed here mutates data and
// keeps the Confirm/Cancel gate.
export const READ_ONLY_TOOLS = new Set([
  'find_entity',
  'search_contacts',
  'list_commitments',
  'get_engagement_score',
  'get_pipeline_summary',
  'get_contact_details',
  'get_today_tasks',
  'get_upcoming_events',
  'get_inbox_summary',
  'get_revenue_summary',
  'generate_report',
  'list_sequences',
  'list_landing_pages',
  'list_email_lists',
  'list_products',
  'list_recent_activity',
])

/**
 * Render the catalog as a compact text block for the TEXT Scout system prompt,
 * so the crm-action surface is generated from this single source of truth
 * instead of a hand-maintained list that drifts (the old hand list documented
 * ~30 of these tools; the UI executor supports all of them).
 */
export function renderToolCatalogForPrompt(): string {
  const lines: string[] = []
  for (const tool of CRM_TOOLS) {
    const props = (tool.parameters?.properties ?? {}) as Record<string, any>
    const required = new Set<string>((tool.parameters as any)?.required ?? [])
    const params = Object.entries(props).map(([key, spec]) => {
      const enumHint = Array.isArray(spec?.enum) ? `=${spec.enum.join('|')}` : ''
      return `${key}${required.has(key) ? '' : '?'}${enumHint}`
    }).join(', ')
    // First sentence of the description keeps the block compact; the model
    // gets the full behavioral rules from the surrounding prompt sections.
    const desc = String(tool.description || '').split(/(?<=\.)\s/)[0].slice(0, 220)
    lines.push(`- ${tool.name}: { ${params} } — ${desc}`)
  }
  return lines.join('\n')
}
