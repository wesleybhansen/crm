-- ==============================================================================
-- CRM Custom Tables Setup
-- Run this after initializing Open Mercato: psql -U crm -d crm < setup-tables.sql
-- ==============================================================================

-- Landing Pages
CREATE TABLE IF NOT EXISTS landing_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  title TEXT NOT NULL, slug TEXT NOT NULL, template_id TEXT, template_category TEXT,
  status TEXT NOT NULL DEFAULT 'draft', config JSONB, custom_domain TEXT, published_html TEXT,
  owner_user_id UUID, view_count INTEGER NOT NULL DEFAULT 0, submission_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS landing_pages_org_slug_idx ON landing_pages(organization_id, slug);

CREATE TABLE IF NOT EXISTS landing_page_forms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  landing_page_id UUID NOT NULL REFERENCES landing_pages(id), name TEXT NOT NULL DEFAULT 'default',
  fields JSONB NOT NULL DEFAULT '[]', redirect_url TEXT, notification_email TEXT, success_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS form_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  form_id UUID NOT NULL, landing_page_id UUID NOT NULL, data JSONB NOT NULL,
  contact_id UUID, source_ip TEXT, user_agent TEXT, referrer TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS form_submissions_org_page_idx ON form_submissions(organization_id, landing_page_id);

-- Email
CREATE TABLE IF NOT EXISTS email_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  email_address TEXT NOT NULL, display_name TEXT, provider TEXT NOT NULL DEFAULT 'resend',
  config JSONB, is_default BOOLEAN NOT NULL DEFAULT true, sending_domain TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS email_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  account_id UUID, direction TEXT NOT NULL, from_address TEXT NOT NULL, to_address TEXT NOT NULL,
  cc TEXT, bcc TEXT, subject TEXT NOT NULL, body_html TEXT NOT NULL, body_text TEXT,
  thread_id TEXT, contact_id UUID, deal_id UUID, campaign_id UUID,
  status TEXT NOT NULL DEFAULT 'draft', tracking_id UUID NOT NULL DEFAULT gen_random_uuid(),
  opened_at TIMESTAMPTZ, clicked_at TIMESTAMPTZ, bounced_at TIMESTAMPTZ, metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), sent_at TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS email_messages_org_contact_idx ON email_messages(organization_id, contact_id);
CREATE INDEX IF NOT EXISTS email_messages_tracking_idx ON email_messages(tracking_id);

CREATE TABLE IF NOT EXISTS email_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  name TEXT NOT NULL, subject TEXT NOT NULL, body_html TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'transactional',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), deleted_at TIMESTAMPTZ);

CREATE TABLE IF NOT EXISTS email_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  name TEXT NOT NULL, template_id UUID, subject TEXT, body_html TEXT,
  status TEXT NOT NULL DEFAULT 'draft', segment_filter JSONB, category TEXT, scheduled_at TIMESTAMPTZ,
  stats JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ, sent_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ);

CREATE TABLE IF NOT EXISTS email_campaign_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id UUID NOT NULL, contact_id UUID NOT NULL,
  email TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  sent_at TIMESTAMPTZ, opened_at TIMESTAMPTZ, clicked_at TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS email_campaign_recipients_idx ON email_campaign_recipients(campaign_id, contact_id);

CREATE TABLE IF NOT EXISTS email_unsubscribes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  email TEXT NOT NULL, contact_id UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS email_unsubscribes_org_email_idx ON email_unsubscribes(organization_id, email);

-- Billing / Credits
CREATE TABLE IF NOT EXISTS credit_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
  organization_id UUID NOT NULL UNIQUE, balance NUMERIC(10,4) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS credit_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  amount NUMERIC(10,4) NOT NULL, type TEXT NOT NULL, description TEXT NOT NULL,
  service TEXT, reference_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS credit_transactions_org_date_idx ON credit_transactions(organization_id, created_at);

CREATE TABLE IF NOT EXISTS credit_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL,
  credit_amount NUMERIC(10,4) NOT NULL, price NUMERIC(10,2) NOT NULL,
  stripe_price_id TEXT, is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
INSERT INTO credit_packages (name, credit_amount, price, sort_order) VALUES
  ('Starter', 10, 10, 1), ('Growth', 25, 25, 2), ('Pro', 50, 50, 3) ON CONFLICT DO NOTHING;

-- Payments
CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  name TEXT NOT NULL, description TEXT, price NUMERIC(10,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD', billing_type TEXT NOT NULL DEFAULT 'one_time',
  recurring_interval TEXT, stripe_price_id TEXT, stripe_product_id TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), deleted_at TIMESTAMPTZ);

CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  invoice_number TEXT NOT NULL, contact_id UUID, deal_id UUID,
  status TEXT NOT NULL DEFAULT 'draft', line_items JSONB NOT NULL DEFAULT '[]',
  subtotal NUMERIC(10,2) NOT NULL DEFAULT 0, tax NUMERIC(10,2) NOT NULL DEFAULT 0,
  total NUMERIC(10,2) NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD',
  due_date TIMESTAMPTZ, notes TEXT, stripe_payment_link TEXT, stripe_invoice_id TEXT,
  sent_at TIMESTAMPTZ, paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), deleted_at TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS invoices_org_status_idx ON invoices(organization_id, status);

CREATE TABLE IF NOT EXISTS payment_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  product_id UUID REFERENCES products(id), name TEXT NOT NULL, url_slug TEXT NOT NULL,
  stripe_payment_link_id TEXT, stripe_url TEXT, is_active BOOLEAN NOT NULL DEFAULT true,
  view_count INTEGER NOT NULL DEFAULT 0, payment_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS payment_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  invoice_id UUID, contact_id UUID, amount NUMERIC(10,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD', status TEXT NOT NULL DEFAULT 'pending',
  stripe_payment_intent_id TEXT, stripe_checkout_session_id TEXT, metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS payment_records_org_idx ON payment_records(organization_id, created_at);

-- Notes & Tasks
CREATE TABLE IF NOT EXISTS contact_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  contact_id UUID NOT NULL, content TEXT NOT NULL, author_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS contact_notes_contact_idx ON contact_notes(contact_id, created_at);

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  title TEXT NOT NULL, description TEXT, contact_id UUID, deal_id UUID,
  due_date TIMESTAMPTZ, is_done BOOLEAN NOT NULL DEFAULT false, completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS tasks_org_done_idx ON tasks(organization_id, is_done, due_date);

-- AI Usage
CREATE TABLE IF NOT EXISTS ai_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  month TEXT NOT NULL, call_count INTEGER NOT NULL DEFAULT 0, token_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS ai_usage_org_month_idx ON ai_usage(organization_id, month);

CREATE TABLE IF NOT EXISTS ai_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
  organization_id UUID, user_id UUID, setting_key TEXT NOT NULL, setting_value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());

-- Business Profiles
CREATE TABLE IF NOT EXISTS business_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL,
  organization_id UUID NOT NULL UNIQUE, business_name TEXT, business_type TEXT,
  business_description TEXT, main_offer TEXT, ideal_clients TEXT, team_size TEXT,
  client_sources JSONB DEFAULT '[]', pipeline_stages JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());

-- Stage Automations
CREATE TABLE IF NOT EXISTS stage_automations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  trigger_stage TEXT NOT NULL, action_type TEXT NOT NULL, action_config JSONB NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now());

-- Calendar & Booking
CREATE TABLE IF NOT EXISTS booking_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  title TEXT NOT NULL, slug TEXT NOT NULL, description TEXT,
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  availability JSONB NOT NULL DEFAULT '{"monday":{"start":"09:00","end":"17:00"},"tuesday":{"start":"09:00","end":"17:00"},"wednesday":{"start":"09:00","end":"17:00"},"thursday":{"start":"09:00","end":"17:00"},"friday":{"start":"09:00","end":"17:00"}}',
  buffer_minutes INTEGER NOT NULL DEFAULT 15, is_active BOOLEAN NOT NULL DEFAULT true,
  owner_user_id UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  booking_page_id UUID REFERENCES booking_pages(id), contact_id UUID,
  guest_name TEXT NOT NULL, guest_email TEXT NOT NULL, guest_phone TEXT,
  start_time TIMESTAMPTZ NOT NULL, end_time TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed', notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS bookings_org_time_idx ON bookings(organization_id, start_time);

-- Google Calendar
CREATE TABLE IF NOT EXISTS google_calendar_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  user_id UUID NOT NULL, google_email TEXT NOT NULL,
  access_token TEXT NOT NULL, refresh_token TEXT NOT NULL, token_expiry TIMESTAMPTZ NOT NULL,
  calendar_id TEXT NOT NULL DEFAULT 'primary', is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS google_cal_user_idx ON google_calendar_connections(user_id);

-- SMS
CREATE TABLE IF NOT EXISTS sms_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  contact_id UUID, direction TEXT NOT NULL, from_number TEXT NOT NULL, to_number TEXT NOT NULL,
  body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', twilio_sid TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS sms_messages_contact_idx ON sms_messages(contact_id, created_at);

-- Courses
CREATE TABLE IF NOT EXISTS courses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  title TEXT NOT NULL, description TEXT, slug TEXT NOT NULL,
  price NUMERIC(10,2), currency TEXT NOT NULL DEFAULT 'USD',
  is_free BOOLEAN NOT NULL DEFAULT false, is_published BOOLEAN NOT NULL DEFAULT false, image_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), deleted_at TIMESTAMPTZ);

CREATE TABLE IF NOT EXISTS course_modules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), course_id UUID NOT NULL REFERENCES courses(id),
  title TEXT NOT NULL, description TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS course_lessons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), module_id UUID NOT NULL REFERENCES course_modules(id),
  title TEXT NOT NULL, content_type TEXT NOT NULL DEFAULT 'text', content TEXT, video_url TEXT,
  duration_minutes INTEGER, sort_order INTEGER NOT NULL DEFAULT 0,
  is_free_preview BOOLEAN NOT NULL DEFAULT false, drip_days INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS course_enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  course_id UUID NOT NULL REFERENCES courses(id), contact_id UUID,
  student_name TEXT NOT NULL, student_email TEXT NOT NULL,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ,
  payment_id UUID, status TEXT NOT NULL DEFAULT 'active');
CREATE INDEX IF NOT EXISTS enrollments_course_idx ON course_enrollments(course_id, status);

CREATE TABLE IF NOT EXISTS lesson_progress (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id UUID NOT NULL REFERENCES course_enrollments(id),
  lesson_id UUID NOT NULL REFERENCES course_lessons(id),
  completed_at TIMESTAMPTZ, UNIQUE(enrollment_id, lesson_id));

-- Sequences (Drip / Follow-up)
CREATE TABLE IF NOT EXISTS sequences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  name TEXT NOT NULL, description TEXT, trigger_type TEXT NOT NULL DEFAULT 'manual',
  trigger_config JSONB, status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), deleted_at TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS sequences_org_status_idx ON sequences(organization_id, status);

CREATE TABLE IF NOT EXISTS sequence_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), sequence_id UUID NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL, step_type TEXT NOT NULL, config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS sequence_steps_seq_idx ON sequence_steps(sequence_id, step_order);

CREATE TABLE IF NOT EXISTS sequence_enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), sequence_id UUID NOT NULL REFERENCES sequences(id),
  contact_id UUID NOT NULL, organization_id UUID NOT NULL, tenant_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', current_step_order INTEGER NOT NULL DEFAULT 1,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ, paused_at TIMESTAMPTZ);
CREATE UNIQUE INDEX IF NOT EXISTS enrollments_seq_contact_idx ON sequence_enrollments(sequence_id, contact_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS enrollments_org_status_idx ON sequence_enrollments(organization_id, status);

CREATE TABLE IF NOT EXISTS sequence_step_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), enrollment_id UUID NOT NULL REFERENCES sequence_enrollments(id),
  step_id UUID NOT NULL REFERENCES sequence_steps(id), status TEXT NOT NULL DEFAULT 'scheduled',
  scheduled_for TIMESTAMPTZ NOT NULL, executed_at TIMESTAMPTZ, result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS step_exec_scheduled_idx ON sequence_step_executions(status, scheduled_for) WHERE status = 'scheduled';

-- Email status on contacts (for bounce/complaint tracking)
ALTER TABLE customer_entities ADD COLUMN IF NOT EXISTS email_status TEXT NOT NULL DEFAULT 'active';

-- Response Templates
CREATE TABLE IF NOT EXISTS response_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  name TEXT NOT NULL, subject TEXT, body_text TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'general',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS response_templates_org_idx ON response_templates(organization_id, category);

-- Contact Engagement Scoring
CREATE TABLE IF NOT EXISTS contact_engagement_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  contact_id UUID NOT NULL, score INTEGER NOT NULL DEFAULT 0, last_activity_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS engagement_scores_contact_idx ON contact_engagement_scores(contact_id);
CREATE INDEX IF NOT EXISTS engagement_scores_org_score_idx ON contact_engagement_scores(organization_id, score DESC);

CREATE TABLE IF NOT EXISTS engagement_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), contact_id UUID NOT NULL, organization_id UUID NOT NULL,
  event_type TEXT NOT NULL, points INTEGER NOT NULL, metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS engagement_events_contact_idx ON engagement_events(contact_id, created_at DESC);

ALTER TABLE customer_entities ADD COLUMN IF NOT EXISTS source_details JSONB;

-- Reminders
CREATE TABLE IF NOT EXISTS reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  user_id UUID NOT NULL, entity_type TEXT NOT NULL, entity_id UUID NOT NULL,
  message TEXT NOT NULL, remind_at TIMESTAMPTZ NOT NULL, sent BOOLEAN NOT NULL DEFAULT false,
  sent_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders(remind_at, sent) WHERE sent = false;
CREATE INDEX IF NOT EXISTS reminders_org_idx ON reminders(organization_id, user_id);

-- Outbound Webhooks
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  event TEXT NOT NULL, target_url TEXT NOT NULL, secret TEXT, is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS webhook_subs_org_idx ON webhook_subscriptions(organization_id, event);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), subscription_id UUID NOT NULL REFERENCES webhook_subscriptions(id),
  event TEXT NOT NULL, payload JSONB NOT NULL, status_code INTEGER, response_body TEXT,
  attempt INTEGER NOT NULL DEFAULT 1, delivered_at TIMESTAMPTZ, failed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS webhook_deliveries_sub_idx ON webhook_deliveries(subscription_id, created_at DESC);

-- Contact Attachments
CREATE TABLE IF NOT EXISTS contact_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  contact_id UUID NOT NULL, filename TEXT NOT NULL, file_url TEXT NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0, mime_type TEXT, uploaded_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS attachments_contact_idx ON contact_attachments(contact_id, created_at DESC);

-- Automation Rules
CREATE TABLE IF NOT EXISTS automation_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  name TEXT NOT NULL, trigger_type TEXT NOT NULL, trigger_config JSONB NOT NULL DEFAULT '{}',
  action_type TEXT NOT NULL, action_config JSONB NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS automation_rules_org_idx ON automation_rules(organization_id, trigger_type, is_active);

CREATE TABLE IF NOT EXISTS automation_rule_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), rule_id UUID NOT NULL REFERENCES automation_rules(id),
  contact_id UUID, trigger_data JSONB, action_result JSONB, status TEXT NOT NULL DEFAULT 'executed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS automation_logs_rule_idx ON automation_rule_logs(rule_id, created_at DESC);

-- Email Preferences
CREATE TABLE IF NOT EXISTS email_preference_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  name TEXT NOT NULL, slug TEXT NOT NULL, description TEXT, is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS pref_cat_org_slug_idx ON email_preference_categories(organization_id, slug);

CREATE TABLE IF NOT EXISTS email_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), contact_id UUID NOT NULL, organization_id UUID NOT NULL,
  category_slug TEXT NOT NULL, opted_in BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS email_pref_contact_cat_idx ON email_preferences(contact_id, organization_id, category_slug);

-- Send Time Optimization
CREATE TABLE IF NOT EXISTS contact_open_times (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), contact_id UUID NOT NULL, organization_id UUID NOT NULL,
  hour_of_day INTEGER NOT NULL, day_of_week INTEGER NOT NULL, opened_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS open_times_contact_idx ON contact_open_times(contact_id);

-- Email Style Templates
CREATE TABLE IF NOT EXISTS email_style_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'general', html_template TEXT NOT NULL,
  thumbnail_url TEXT, is_default BOOLEAN NOT NULL DEFAULT false, created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS email_templates_org_idx ON email_style_templates(organization_id, category);

ALTER TABLE email_campaigns ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ;

-- Surveys & Forms
CREATE TABLE IF NOT EXISTS surveys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  title TEXT NOT NULL, description TEXT, slug TEXT NOT NULL, fields JSONB NOT NULL DEFAULT '[]',
  thank_you_message TEXT DEFAULT 'Thank you for your response!', is_active BOOLEAN NOT NULL DEFAULT true,
  response_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS surveys_org_slug_idx ON surveys(organization_id, slug);

CREATE TABLE IF NOT EXISTS survey_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id UUID NOT NULL,
  survey_id UUID NOT NULL REFERENCES surveys(id), contact_id UUID,
  respondent_email TEXT, respondent_name TEXT, responses JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS survey_responses_survey_idx ON survey_responses(survey_id, created_at DESC);

-- Funnels
CREATE TABLE IF NOT EXISTS funnels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  name TEXT NOT NULL, slug TEXT NOT NULL, is_published BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS funnels_org_slug_idx ON funnels(organization_id, slug);

CREATE TABLE IF NOT EXISTS funnel_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), funnel_id UUID NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL, step_type TEXT NOT NULL DEFAULT 'page',
  page_id UUID, config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS funnel_steps_funnel_idx ON funnel_steps(funnel_id, step_order);

CREATE TABLE IF NOT EXISTS funnel_visits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), funnel_id UUID NOT NULL, step_id UUID NOT NULL,
  contact_id UUID, visitor_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS funnel_visits_funnel_idx ON funnel_visits(funnel_id, created_at DESC);

-- Live Chat
CREATE TABLE IF NOT EXISTS chat_widgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  name TEXT NOT NULL, greeting_message TEXT DEFAULT 'Hi there! How can we help you today?',
  config JSONB NOT NULL DEFAULT '{"position":"bottom-right","primaryColor":"#3B82F6","autoReply":false}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS chat_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  widget_id UUID NOT NULL REFERENCES chat_widgets(id), contact_id UUID,
  visitor_name TEXT, visitor_email TEXT, status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS chat_conv_org_idx ON chat_conversations(organization_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id UUID NOT NULL REFERENCES chat_conversations(id),
  sender_type TEXT NOT NULL DEFAULT 'visitor', message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS chat_msg_conv_idx ON chat_messages(conversation_id, created_at);

-- Affiliates
CREATE TABLE IF NOT EXISTS affiliates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  contact_id UUID, name TEXT NOT NULL, email TEXT NOT NULL, affiliate_code TEXT NOT NULL,
  commission_rate NUMERIC(5,2) NOT NULL DEFAULT 10.00, commission_type TEXT NOT NULL DEFAULT 'percentage',
  status TEXT NOT NULL DEFAULT 'active', total_referrals INTEGER NOT NULL DEFAULT 0,
  total_conversions INTEGER NOT NULL DEFAULT 0, total_earned NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS affiliates_org_code_idx ON affiliates(organization_id, affiliate_code);
CREATE INDEX IF NOT EXISTS affiliates_org_idx ON affiliates(organization_id, status);

CREATE TABLE IF NOT EXISTS affiliate_referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), affiliate_id UUID NOT NULL REFERENCES affiliates(id),
  referred_contact_id UUID, referred_email TEXT, referral_source TEXT,
  converted BOOLEAN NOT NULL DEFAULT false, conversion_value NUMERIC(10,2),
  commission_amount NUMERIC(10,2), referred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  converted_at TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS referrals_affiliate_idx ON affiliate_referrals(affiliate_id, referred_at DESC);

CREATE TABLE IF NOT EXISTS affiliate_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), affiliate_id UUID NOT NULL REFERENCES affiliates(id),
  amount NUMERIC(10,2) NOT NULL, period_start TIMESTAMPTZ NOT NULL, period_end TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS payouts_affiliate_idx ON affiliate_payouts(affiliate_id, created_at DESC);

-- Sequence branching support
ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS branch_config JSONB;
ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS is_goal BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS goal_config JSONB;

-- Email Connections (Gmail, Outlook, SMTP)
CREATE TABLE IF NOT EXISTS email_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  user_id UUID NOT NULL, provider TEXT NOT NULL, email_address TEXT NOT NULL,
  access_token TEXT, refresh_token TEXT, token_expiry TIMESTAMPTZ,
  smtp_host TEXT, smtp_port INTEGER, smtp_user TEXT, smtp_pass TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT false, is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS email_conn_org_user_provider_idx ON email_connections(organization_id, user_id, provider);

-- ESP Connections (Resend, SendGrid, SES, Mailgun) for bulk campaigns
CREATE TABLE IF NOT EXISTS esp_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  provider TEXT NOT NULL, api_key TEXT NOT NULL, sending_domain TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS esp_conn_org_provider_idx ON esp_connections(organization_id, provider);

-- Stripe Connect
CREATE TABLE IF NOT EXISTS stripe_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  stripe_account_id TEXT NOT NULL, access_token TEXT, refresh_token TEXT,
  business_name TEXT, is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS stripe_conn_org_idx ON stripe_connections(organization_id);

-- Twilio Connections
CREATE TABLE IF NOT EXISTS twilio_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  account_sid TEXT NOT NULL, auth_token TEXT NOT NULL, phone_number TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS twilio_conn_org_idx ON twilio_connections(organization_id);

-- AI Persona columns on business_profiles
ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS ai_persona_name TEXT DEFAULT 'Scout';
ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS ai_persona_style TEXT DEFAULT 'professional';
ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS ai_custom_instructions TEXT;

-- Website scan fields
ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS website_url TEXT;
ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS brand_colors JSONB;
ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS social_links JSONB;
ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS detected_services JSONB;

-- Pipeline mode (deals vs journey)
ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS pipeline_mode TEXT DEFAULT 'deals';

-- Email sentiment tracking
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS sentiment TEXT;

-- AI Digest settings
ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS digest_frequency TEXT DEFAULT 'weekly';
ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS digest_day INTEGER DEFAULT 1;

-- Meeting Prep Briefs
CREATE TABLE IF NOT EXISTS meeting_prep_briefs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  user_id UUID NOT NULL, contact_id UUID NOT NULL, event_summary TEXT,
  event_start TIMESTAMPTZ NOT NULL, brief_html TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS meeting_prep_idx ON meeting_prep_briefs(organization_id, event_start DESC);

-- Task Templates
CREATE TABLE IF NOT EXISTS task_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, organization_id UUID NOT NULL,
  name TEXT NOT NULL, description TEXT, trigger_type TEXT NOT NULL DEFAULT 'manual',
  trigger_config JSONB DEFAULT '{}',
  tasks JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS task_templates_org_idx ON task_templates(organization_id);

-- Email intake mode
ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS email_intake_mode TEXT DEFAULT 'suggest';

-- Interface mode (simple vs advanced) and onboarding status
ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS interface_mode TEXT DEFAULT 'simple';
ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS onboarding_complete BOOLEAN DEFAULT false;

-- Done
SELECT 'All custom tables created successfully' AS status;
