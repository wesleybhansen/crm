--
-- PostgreSQL database dump
--

\restrict 9xC1hC60rOQnfTqiRSbUZBR6V0nf7FRM7rBHpg5AX6Zn2DdVt4bg7mSQeLm4edM

-- Dumped from database version 17.9 (Debian 17.9-1.pgdg13+1)
-- Dumped by pg_dump version 17.9 (Debian 17.9-1.pgdg13+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: access_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.access_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid,
    organization_id uuid,
    actor_user_id uuid,
    resource_kind text NOT NULL,
    resource_id text NOT NULL,
    access_type text NOT NULL,
    fields_json jsonb,
    context_json jsonb,
    created_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: action_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.action_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid,
    organization_id uuid,
    actor_user_id uuid,
    command_id text NOT NULL,
    action_label text,
    resource_kind text,
    resource_id text,
    execution_state text DEFAULT 'done'::text NOT NULL,
    undo_token text,
    command_payload jsonb,
    snapshot_before jsonb,
    snapshot_after jsonb,
    changes_json jsonb,
    context_json jsonb,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone,
    parent_resource_kind text,
    parent_resource_id text
);


--
-- Name: affiliate_campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.affiliate_campaigns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    product_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    commission_rate numeric(10,2) DEFAULT 10.00 NOT NULL,
    commission_type text DEFAULT 'percentage'::text NOT NULL,
    customer_discount numeric(10,2) DEFAULT 0,
    customer_discount_type text DEFAULT 'percentage'::text,
    cookie_duration_days integer DEFAULT 30 NOT NULL,
    auto_approve boolean DEFAULT false NOT NULL,
    stripe_coupon_id text,
    signup_page_enabled boolean DEFAULT true NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    terms_text text,
    tiers jsonb
);


--
-- Name: affiliate_payouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.affiliate_payouts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    affiliate_id uuid NOT NULL,
    amount numeric(10,2) NOT NULL,
    period_start timestamp with time zone NOT NULL,
    period_end timestamp with time zone NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    paid_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: affiliate_referrals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.affiliate_referrals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    affiliate_id uuid NOT NULL,
    referred_contact_id uuid,
    referred_email text,
    referral_source text,
    converted boolean DEFAULT false NOT NULL,
    conversion_value numeric(10,2),
    commission_amount numeric(10,2),
    campaign_id uuid,
    stripe_session_id text,
    stripe_payment_intent_id text,
    referred_at timestamp with time zone DEFAULT now() NOT NULL,
    converted_at timestamp with time zone
);


--
-- Name: affiliates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.affiliates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    contact_id uuid,
    name text NOT NULL,
    email text NOT NULL,
    affiliate_code text NOT NULL,
    commission_rate numeric(10,2) DEFAULT 10.00 NOT NULL,
    commission_type text DEFAULT 'percentage'::text NOT NULL,
    campaign_id uuid,
    stripe_promo_code_id text,
    stripe_promo_code text,
    website text,
    promotion_method text,
    status text DEFAULT 'active'::text NOT NULL,
    approved_at timestamp with time zone,
    total_referrals integer DEFAULT 0 NOT NULL,
    total_conversions integer DEFAULT 0 NOT NULL,
    total_earned numeric(10,2) DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    accepted_terms boolean DEFAULT false,
    accepted_terms_at timestamp with time zone
);


--
-- Name: ai_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid,
    user_id uuid,
    setting_key text NOT NULL,
    setting_value text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ai_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_usage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    month text NOT NULL,
    call_count integer DEFAULT 0 NOT NULL,
    token_count integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    tenant_id uuid,
    organization_id uuid,
    key_hash text NOT NULL,
    key_prefix text NOT NULL,
    roles_json jsonb,
    created_by uuid,
    last_used_at timestamp with time zone,
    expires_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    session_token text,
    session_user_id uuid,
    session_secret_encrypted text,
    rate_limit_tier text,
    scopes jsonb
);


--
-- Name: assistant_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assistant_conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    title text DEFAULT 'New conversation'::text NOT NULL,
    messages jsonb DEFAULT '[]'::jsonb NOT NULL,
    is_archived boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: attachment_partitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attachment_partitions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    title text NOT NULL,
    description text,
    storage_driver text DEFAULT 'local'::text NOT NULL,
    config_json jsonb,
    is_public boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    requires_ocr boolean DEFAULT true NOT NULL,
    ocr_model text
);


--
-- Name: attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_id text NOT NULL,
    record_id text NOT NULL,
    organization_id uuid,
    tenant_id uuid,
    file_name text NOT NULL,
    mime_type text NOT NULL,
    file_size integer NOT NULL,
    url text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    partition_code text NOT NULL,
    storage_driver text DEFAULT 'local'::text NOT NULL,
    storage_path text NOT NULL,
    storage_metadata jsonb,
    content text
);


--
-- Name: automation_rule_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.automation_rule_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rule_id uuid NOT NULL,
    contact_id uuid,
    trigger_data jsonb,
    action_result jsonb,
    status text DEFAULT 'executed'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: automation_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.automation_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    trigger_type text NOT NULL,
    trigger_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    action_type text NOT NULL,
    action_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    description text,
    conditions jsonb,
    steps jsonb,
    status text DEFAULT 'active'::text,
    template_id text
);


--
-- Name: booking_pages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.booking_pages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    title text NOT NULL,
    slug text NOT NULL,
    description text,
    duration_minutes integer DEFAULT 30 NOT NULL,
    availability jsonb DEFAULT '{"friday": {"end": "17:00", "start": "09:00"}, "monday": {"end": "17:00", "start": "09:00"}, "tuesday": {"end": "17:00", "start": "09:00"}, "thursday": {"end": "17:00", "start": "09:00"}, "wednesday": {"end": "17:00", "start": "09:00"}}'::jsonb NOT NULL,
    buffer_minutes integer DEFAULT 15 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    owner_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    auto_confirm boolean DEFAULT true NOT NULL,
    meeting_type text DEFAULT 'in_person'::text,
    meeting_location text,
    zoom_link text,
    reminder_config jsonb DEFAULT '[]'::jsonb
);


--
-- Name: bookings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bookings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    booking_page_id uuid,
    contact_id uuid,
    guest_name text NOT NULL,
    guest_email text NOT NULL,
    guest_phone text,
    start_time timestamp with time zone NOT NULL,
    end_time timestamp with time zone NOT NULL,
    status text DEFAULT 'confirmed'::text NOT NULL,
    notes text,
    recurrence_rule jsonb,
    recurrence_parent_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    confirmation_token text,
    confirmation_token_expires_at timestamp with time zone,
    confirmed_at timestamp with time zone,
    meeting_type text,
    meeting_location text
);


--
-- Name: business_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.business_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    business_name text,
    business_type text,
    business_description text,
    main_offer text,
    ideal_clients text,
    team_size text,
    client_sources jsonb DEFAULT '[]'::jsonb,
    pipeline_stages jsonb DEFAULT '[]'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    ai_persona_name text DEFAULT 'Scout'::text,
    ai_persona_style text DEFAULT 'professional'::text,
    ai_custom_instructions text,
    website_url text,
    brand_colors jsonb,
    social_links jsonb,
    detected_services jsonb,
    pipeline_mode text DEFAULT 'deals'::text,
    digest_frequency text DEFAULT 'weekly'::text,
    digest_day integer DEFAULT 1,
    email_intake_mode text DEFAULT 'suggest'::text,
    interface_mode text DEFAULT 'simple'::text,
    onboarding_complete boolean DEFAULT false,
    brand_voice_profile jsonb,
    brand_voice_updated_at timestamp with time zone,
    brand_voice_source text,
    ams_url text,
    ams_webhook_secret text,
    meeting_prep_enabled boolean DEFAULT true,
    decay_alerts_enabled boolean DEFAULT true,
    pkb_api_keys jsonb,
    review_url text,
    review_platform text
);


--
-- Name: chat_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    widget_id uuid NOT NULL,
    contact_id uuid,
    visitor_name text,
    visitor_email text,
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    visitor_token text,
    visitor_typing boolean DEFAULT false NOT NULL,
    agent_typing boolean DEFAULT false NOT NULL,
    visitor_typing_at timestamp with time zone,
    agent_typing_at timestamp with time zone
);


--
-- Name: chat_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    sender_type text DEFAULT 'visitor'::text NOT NULL,
    message text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: chat_widgets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_widgets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    greeting_message text DEFAULT 'Hi there! How can we help you today?'::text,
    config jsonb DEFAULT '{"position": "bottom-right", "autoReply": false, "primaryColor": "#3B82F6"}'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    slug text,
    description text,
    brand_color text DEFAULT '#3B82F6'::text,
    welcome_message text,
    business_name text,
    public_page_enabled boolean DEFAULT true NOT NULL,
    bot_enabled boolean DEFAULT false NOT NULL,
    bot_knowledge_base text,
    bot_personality text,
    bot_instructions text,
    bot_guardrails text,
    bot_handoff_message text,
    bot_max_responses integer DEFAULT 5
);


--
-- Name: commitments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commitments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid,
    contact_id uuid,
    deal_id uuid,
    direction text DEFAULT 'ours'::text NOT NULL,
    description text NOT NULL,
    due_at timestamp with time zone,
    status text DEFAULT 'open'::text NOT NULL,
    source text DEFAULT 'email'::text NOT NULL,
    source_ref text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone
);


--
-- Name: contact_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    filename text NOT NULL,
    file_url text NOT NULL,
    file_size integer DEFAULT 0 NOT NULL,
    mime_type text,
    uploaded_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: contact_engagement_scores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_engagement_scores (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    score integer DEFAULT 0 NOT NULL,
    last_activity_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: contact_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    content text NOT NULL,
    author_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: contact_open_times; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_open_times (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    contact_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    hour_of_day integer NOT NULL,
    day_of_week integer NOT NULL,
    opened_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid NOT NULL
);


--
-- Name: contact_timeline_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_timeline_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    event_type text NOT NULL,
    title text NOT NULL,
    description text,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: course_enrollments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.course_enrollments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    course_id uuid NOT NULL,
    contact_id uuid,
    student_name text NOT NULL,
    student_email text NOT NULL,
    enrolled_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    payment_id uuid,
    status text DEFAULT 'active'::text NOT NULL,
    accepted_terms boolean DEFAULT false,
    accepted_terms_at timestamp with time zone
);


--
-- Name: course_lessons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.course_lessons (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    module_id uuid NOT NULL,
    title text NOT NULL,
    content_type text DEFAULT 'text'::text NOT NULL,
    content text,
    video_url text,
    duration_minutes integer,
    sort_order integer DEFAULT 0 NOT NULL,
    is_free_preview boolean DEFAULT false NOT NULL,
    drip_days integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    description text,
    file_url text
);


--
-- Name: course_magic_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.course_magic_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    email text NOT NULL,
    token text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: course_modules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.course_modules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    course_id uuid NOT NULL,
    title text NOT NULL,
    description text,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: course_student_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.course_student_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    email text NOT NULL,
    session_token text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: courses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.courses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    title text NOT NULL,
    description text,
    slug text NOT NULL,
    price numeric(10,2),
    currency text DEFAULT 'USD'::text NOT NULL,
    is_free boolean DEFAULT false NOT NULL,
    is_published boolean DEFAULT false NOT NULL,
    image_url text,
    teaching_style text,
    target_audience text,
    generation_status text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    landing_copy jsonb,
    landing_style text DEFAULT 'warm'::text,
    terms_text text
);


--
-- Name: credit_balances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credit_balances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    balance numeric(10,4) DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: credit_packages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credit_packages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    credit_amount numeric(10,4) NOT NULL,
    price numeric(10,2) NOT NULL,
    stripe_price_id text,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: credit_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credit_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    amount numeric(10,4) NOT NULL,
    type text NOT NULL,
    description text NOT NULL,
    service text,
    reference_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: currencies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.currencies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    symbol text,
    decimal_places integer DEFAULT 2 NOT NULL,
    thousands_separator text,
    decimal_separator text,
    is_base boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: currency_fetch_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.currency_fetch_configs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    provider text NOT NULL,
    is_enabled boolean DEFAULT false NOT NULL,
    sync_time text,
    last_sync_at timestamp with time zone,
    last_sync_status text,
    last_sync_message text,
    last_sync_count integer,
    config jsonb,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: custom_entities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.custom_entities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_id text NOT NULL,
    label text NOT NULL,
    description text,
    label_field text,
    default_editor text,
    show_in_sidebar boolean DEFAULT false NOT NULL,
    organization_id uuid,
    tenant_id uuid,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: custom_entities_storage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.custom_entities_storage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    organization_id uuid,
    tenant_id uuid,
    doc jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: custom_field_defs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.custom_field_defs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_id text NOT NULL,
    organization_id uuid,
    tenant_id uuid,
    key text NOT NULL,
    kind text NOT NULL,
    config_json jsonb,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: custom_field_entity_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.custom_field_entity_configs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_id text NOT NULL,
    organization_id uuid,
    tenant_id uuid,
    config_json jsonb,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: custom_field_values; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.custom_field_values (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_id text NOT NULL,
    record_id text NOT NULL,
    organization_id uuid,
    tenant_id uuid,
    field_key text NOT NULL,
    value_text text,
    value_multiline text,
    value_int integer,
    value_float real,
    value_bool boolean,
    created_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: customer_activities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_activities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    activity_type text NOT NULL,
    subject text,
    body text,
    occurred_at timestamp with time zone,
    author_user_id uuid,
    appearance_icon text,
    appearance_color text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    entity_id uuid NOT NULL,
    deal_id uuid
);


--
-- Name: customer_addresses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_addresses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    name text,
    purpose text,
    address_line1 text NOT NULL,
    address_line2 text,
    city text,
    region text,
    postal_code text,
    country text,
    building_number text,
    flat_number text,
    latitude real,
    longitude real,
    is_primary boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    entity_id uuid NOT NULL,
    company_name text
);


--
-- Name: customer_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    body text NOT NULL,
    author_user_id uuid,
    appearance_icon text,
    appearance_color text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone,
    entity_id uuid NOT NULL,
    deal_id uuid
);


--
-- Name: customer_companies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_companies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    legal_name text,
    brand_name text,
    domain text,
    website_url text,
    industry text,
    size_bucket text,
    annual_revenue numeric(16,2),
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    entity_id uuid NOT NULL
);


--
-- Name: customer_deal_companies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_deal_companies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone NOT NULL,
    deal_id uuid NOT NULL,
    company_entity_id uuid NOT NULL
);


--
-- Name: customer_deal_people; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_deal_people (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    role text,
    created_at timestamp with time zone NOT NULL,
    deal_id uuid NOT NULL,
    person_entity_id uuid NOT NULL
);


--
-- Name: customer_deals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_deals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    title text NOT NULL,
    description text,
    status text DEFAULT 'open'::text NOT NULL,
    pipeline_stage text,
    value_amount numeric(14,2),
    value_currency text,
    probability integer,
    expected_close_at timestamp with time zone,
    owner_user_id uuid,
    source text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone,
    pipeline_id uuid,
    pipeline_stage_id uuid,
    ai_summary text,
    ai_summary_at timestamp with time zone
);


--
-- Name: customer_dictionary_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_dictionary_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    kind text NOT NULL,
    value text NOT NULL,
    normalized_value text NOT NULL,
    label text NOT NULL,
    color text,
    icon text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: customer_entities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_entities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    kind text NOT NULL,
    display_name text NOT NULL,
    description text,
    owner_user_id uuid,
    primary_email text,
    primary_phone text,
    status text,
    lifecycle_stage text,
    source text,
    next_interaction_at timestamp with time zone,
    next_interaction_name text,
    next_interaction_ref_id text,
    next_interaction_icon text,
    next_interaction_color text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone,
    ai_summary text,
    ai_summary_at timestamp with time zone,
    source_details jsonb,
    commitments_extracted_at timestamp with time zone,
    primary_email_hash text,
    primary_phone_hash text
);


--
-- Name: customer_people; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_people (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    first_name text,
    last_name text,
    preferred_name text,
    job_title text,
    department text,
    seniority text,
    timezone text,
    linked_in_url text,
    twitter_url text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    entity_id uuid NOT NULL,
    company_entity_id uuid,
    linkedin_url text,
    company_name_hint text
);


--
-- Name: customer_pipeline_automation_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_pipeline_automation_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    trigger_key text NOT NULL,
    filters jsonb DEFAULT '{}'::jsonb NOT NULL,
    target_entity text NOT NULL,
    target_pipeline_id uuid,
    target_stage_id uuid,
    target_lifecycle_stage text,
    target_action text NOT NULL,
    allow_backward boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: customer_pipeline_automation_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_pipeline_automation_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    rule_id uuid NOT NULL,
    trigger_event_id text NOT NULL,
    trigger_event_key text NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    from_stage text,
    to_stage text,
    outcome text NOT NULL,
    error text,
    ran_at timestamp with time zone NOT NULL
);


--
-- Name: customer_pipeline_stages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_pipeline_stages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    pipeline_id uuid NOT NULL,
    name text NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: customer_pipelines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_pipelines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: customer_role_acls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_role_acls (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    role_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    features_json jsonb,
    is_portal_admin boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone
);


--
-- Name: customer_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    description text,
    is_default boolean DEFAULT false NOT NULL,
    is_system boolean DEFAULT false NOT NULL,
    customer_assignable boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone
);


--
-- Name: customer_service_knowledge; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_service_knowledge (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    source_filename text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: customer_service_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_service_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    watched_connection_ids jsonb,
    reply_mode text DEFAULT 'draft'::text NOT NULL,
    signature text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    hybrid_confidence_threshold numeric DEFAULT 0.8 NOT NULL,
    source_modes jsonb,
    cs_sms_number text,
    flag_scenarios jsonb,
    cs_chat_enabled boolean DEFAULT false NOT NULL,
    skip_senders jsonb,
    auto_send_paused boolean DEFAULT false NOT NULL,
    auto_send_hold_minutes integer DEFAULT 10 NOT NULL,
    auto_send_hourly_cap integer DEFAULT 20 NOT NULL,
    auto_send_resumed_at timestamp with time zone
);


--
-- Name: customer_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    address_format text DEFAULT 'line_first'::text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: customer_tag_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_tag_assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    tag_id uuid NOT NULL,
    entity_id uuid NOT NULL
);


--
-- Name: customer_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_tags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    slug text NOT NULL,
    label text NOT NULL,
    color text,
    description text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: customer_todo_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_todo_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    todo_id uuid NOT NULL,
    todo_source text DEFAULT 'example:todo'::text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    created_by_user_id uuid,
    entity_id uuid NOT NULL
);


--
-- Name: customer_user_acls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_user_acls (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    features_json jsonb,
    is_portal_admin boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone
);


--
-- Name: customer_user_email_verifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_user_email_verifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token text NOT NULL,
    purpose text DEFAULT 'email_verification'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL
);


--
-- Name: customer_user_invitations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_user_invitations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    email text NOT NULL,
    email_hash text NOT NULL,
    token text NOT NULL,
    customer_entity_id uuid,
    role_ids_json jsonb,
    invited_by_user_id uuid,
    invited_by_customer_user_id uuid,
    display_name text,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL
);


--
-- Name: customer_user_password_resets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_user_password_resets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL
);


--
-- Name: customer_user_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_user_roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    role_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: customer_user_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_user_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    ip_address text,
    user_agent text,
    expires_at timestamp with time zone NOT NULL,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: customer_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    email text NOT NULL,
    email_hash text NOT NULL,
    password_hash text,
    display_name text NOT NULL,
    email_verified_at timestamp with time zone,
    failed_login_attempts integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    last_login_at timestamp with time zone,
    person_entity_id uuid,
    customer_entity_id uuid,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone
);


--
-- Name: dashboard_layouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dashboard_layouts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    tenant_id uuid,
    organization_id uuid,
    layout_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone
);


--
-- Name: dashboard_role_widgets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dashboard_role_widgets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    role_id uuid NOT NULL,
    tenant_id uuid,
    organization_id uuid,
    widget_ids_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone
);


--
-- Name: dashboard_user_widgets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dashboard_user_widgets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    tenant_id uuid,
    organization_id uuid,
    mode text DEFAULT 'inherit'::text NOT NULL,
    widget_ids_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone
);


--
-- Name: dictionaries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dictionaries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    description text,
    is_system boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    manager_visibility text DEFAULT 'default'::text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: dictionary_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dictionary_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    dictionary_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    value text NOT NULL,
    normalized_value text NOT NULL,
    label text NOT NULL,
    color text,
    icon text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: email_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    email_address text NOT NULL,
    display_name text,
    provider text DEFAULT 'resend'::text NOT NULL,
    config jsonb,
    is_default boolean DEFAULT true NOT NULL,
    sending_domain text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: email_campaign_recipients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_campaign_recipients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    campaign_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    email text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    sent_at timestamp with time zone,
    opened_at timestamp with time zone,
    clicked_at timestamp with time zone,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: email_campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_campaigns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    template_id uuid,
    subject text,
    body_html text,
    status text DEFAULT 'draft'::text NOT NULL,
    segment_filter jsonb,
    category text,
    scheduled_at timestamp with time zone,
    stats jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone,
    sent_at timestamp with time zone,
    deleted_at timestamp with time zone,
    scheduled_for timestamp with time zone
);


--
-- Name: email_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    provider text NOT NULL,
    email_address text NOT NULL,
    access_token text,
    refresh_token text,
    token_expiry timestamp with time zone,
    smtp_host text,
    smtp_port integer,
    smtp_user text,
    smtp_pass text,
    is_primary boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    imap_host text,
    imap_port integer,
    imap_secure boolean,
    purpose text,
    cs_last_fetch_at timestamp with time zone
);


--
-- Name: email_intelligence_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_intelligence_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    is_enabled boolean DEFAULT false NOT NULL,
    auto_create_contacts boolean DEFAULT true NOT NULL,
    auto_update_timeline boolean DEFAULT true NOT NULL,
    auto_update_engagement boolean DEFAULT true NOT NULL,
    auto_advance_stage boolean DEFAULT true NOT NULL,
    last_gmail_history_id text,
    last_outlook_delta_link text,
    last_sync_at timestamp with time zone,
    last_sync_status text,
    last_sync_error text,
    emails_processed_total integer DEFAULT 0,
    contacts_created_total integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: email_list_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_list_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    list_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    added_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: email_lists; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_lists (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    source_type text DEFAULT 'manual'::text NOT NULL,
    source_id uuid,
    member_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone
);


--
-- Name: email_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    account_id uuid,
    direction text NOT NULL,
    from_address text NOT NULL,
    to_address text NOT NULL,
    cc text,
    bcc text,
    subject text NOT NULL,
    body_html text NOT NULL,
    body_text text,
    thread_id text,
    contact_id uuid,
    deal_id uuid,
    campaign_id uuid,
    status text DEFAULT 'draft'::text NOT NULL,
    tracking_id uuid DEFAULT gen_random_uuid() NOT NULL,
    opened_at timestamp with time zone,
    clicked_at timestamp with time zone,
    bounced_at timestamp with time zone,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    sentiment text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: email_preference_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_preference_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    description text,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: email_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_preferences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    contact_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    category_slug text NOT NULL,
    opted_in boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: email_routing; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_routing (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    purpose text NOT NULL,
    provider_type text NOT NULL,
    provider_id uuid NOT NULL,
    from_name text,
    from_address text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: email_style_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_style_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    category text DEFAULT 'general'::text NOT NULL,
    html_template text NOT NULL,
    thumbnail_url text,
    is_default boolean DEFAULT false NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: email_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    subject text NOT NULL,
    body_html text NOT NULL,
    category text DEFAULT 'transactional'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: email_unsubscribes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_unsubscribes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    email text NOT NULL,
    contact_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: encryption_maps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.encryption_maps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_id text NOT NULL,
    tenant_id uuid,
    organization_id uuid,
    fields_json jsonb,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: engagement_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.engagement_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    contact_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    event_type text NOT NULL,
    points integer NOT NULL,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid NOT NULL
);


--
-- Name: entity_index_coverage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_index_coverage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_type text NOT NULL,
    tenant_id uuid,
    organization_id uuid,
    with_deleted boolean DEFAULT false NOT NULL,
    base_count integer DEFAULT 0 NOT NULL,
    indexed_count integer DEFAULT 0 NOT NULL,
    vector_indexed_count integer DEFAULT 0 NOT NULL,
    refreshed_at timestamp with time zone NOT NULL
);


--
-- Name: entity_index_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_index_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_type text NOT NULL,
    organization_id uuid,
    tenant_id uuid,
    partition_index integer,
    partition_count integer,
    processed_count integer,
    total_count integer,
    heartbeat_at timestamp with time zone,
    status text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone
);


--
-- Name: entity_indexes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_indexes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    organization_id uuid,
    tenant_id uuid,
    doc jsonb NOT NULL,
    embedding jsonb,
    index_version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: esp_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.esp_connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    provider text NOT NULL,
    api_key text NOT NULL,
    sending_domain text,
    default_sender_email text,
    default_sender_name text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: esp_sender_addresses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.esp_sender_addresses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    esp_connection_id uuid NOT NULL,
    sender_name text,
    sender_email text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: exchange_rates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.exchange_rates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    from_currency_code text NOT NULL,
    to_currency_code text NOT NULL,
    rate numeric(18,8) NOT NULL,
    date timestamp with time zone NOT NULL,
    source text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone,
    type text
);


--
-- Name: feature_toggle_audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feature_toggle_audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    toggle_id uuid NOT NULL,
    organization_id uuid,
    actor_user_id uuid,
    action text NOT NULL,
    previous_value jsonb,
    new_value jsonb,
    changed_fields jsonb,
    created_at timestamp with time zone NOT NULL
);


--
-- Name: feature_toggle_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feature_toggle_overrides (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    toggle_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    value jsonb NOT NULL
);


--
-- Name: feature_toggles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feature_toggles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    identifier text NOT NULL,
    name text NOT NULL,
    description text,
    category text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone,
    default_value jsonb NOT NULL,
    type text NOT NULL
);


--
-- Name: form_submissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.form_submissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    form_id uuid NOT NULL,
    landing_page_id uuid,
    data jsonb NOT NULL,
    contact_id uuid,
    source_ip text,
    user_agent text,
    referrer text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: forms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.forms (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    description text,
    template_id text,
    fields jsonb DEFAULT '[]'::jsonb NOT NULL,
    theme jsonb DEFAULT '{}'::jsonb NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    owner_user_id uuid,
    view_count integer DEFAULT 0 NOT NULL,
    submission_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    deleted_at timestamp with time zone,
    is_active boolean DEFAULT true NOT NULL
);


--
-- Name: funnel_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.funnel_orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    funnel_id uuid NOT NULL,
    step_id uuid NOT NULL,
    product_id uuid,
    amount numeric(10,2) NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    order_type text DEFAULT 'checkout'::text NOT NULL,
    stripe_payment_intent_id text,
    stripe_checkout_session_id text,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: funnel_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.funnel_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    funnel_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    visitor_id text NOT NULL,
    contact_id uuid,
    email text,
    stripe_customer_id text,
    stripe_payment_method_id text,
    current_step_id uuid,
    status text DEFAULT 'active'::text NOT NULL,
    total_revenue numeric(10,2) DEFAULT 0,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: funnel_steps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.funnel_steps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    funnel_id uuid NOT NULL,
    step_order integer NOT NULL,
    step_type text DEFAULT 'page'::text NOT NULL,
    page_id uuid,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    name text,
    product_id uuid,
    on_accept_step_id uuid,
    on_decline_step_id uuid
);


--
-- Name: funnel_visits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.funnel_visits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    funnel_id uuid NOT NULL,
    step_id uuid NOT NULL,
    contact_id uuid,
    visitor_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    session_id text,
    action text
);


--
-- Name: funnels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.funnels (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    is_published boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: gateway_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gateway_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    payment_id uuid NOT NULL,
    provider_key text NOT NULL,
    provider_session_id text,
    gateway_payment_id text,
    gateway_refund_id text,
    unified_status text DEFAULT 'pending'::text NOT NULL,
    gateway_status text,
    redirect_url text,
    client_secret text,
    amount numeric(18,4) NOT NULL,
    currency_code text NOT NULL,
    gateway_metadata jsonb,
    webhook_log jsonb,
    last_webhook_at timestamp with time zone,
    last_polled_at timestamp with time zone,
    expires_at timestamp with time zone,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: gateway_webhook_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gateway_webhook_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_key text NOT NULL,
    idempotency_key text NOT NULL,
    event_type text NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    processed_at timestamp with time zone NOT NULL
);


--
-- Name: google_calendar_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.google_calendar_connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    google_email text NOT NULL,
    access_token text NOT NULL,
    refresh_token text NOT NULL,
    token_expiry timestamp with time zone NOT NULL,
    calendar_id text DEFAULT 'primary'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: gtm_ai_telemetry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtm_ai_telemetry (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    operation_key text NOT NULL,
    surface text NOT NULL,
    model text,
    status text DEFAULT 'succeeded'::text NOT NULL,
    tokens_in integer DEFAULT 0 NOT NULL,
    tokens_out integer DEFAULT 0 NOT NULL,
    component_estimates jsonb,
    latency_ms integer,
    retry_count integer DEFAULT 0 NOT NULL,
    estimated_cost_microusd bigint,
    rate_card_version text,
    failure_code text,
    request_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    token_usage_known boolean DEFAULT true NOT NULL
);


--
-- Name: gtm_audit_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtm_audit_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    actor text NOT NULL,
    actor_user_id uuid,
    action text NOT NULL,
    object_type text NOT NULL,
    object_id uuid,
    object_version integer,
    request_id text,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: gtm_auto_refill_cycles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtm_auto_refill_cycles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    policy_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    campaign_version_id uuid NOT NULL,
    play_id uuid NOT NULL,
    research_run_id uuid,
    local_date text NOT NULL,
    policy_hash text NOT NULL,
    campaign_content_hash text NOT NULL,
    plan_hash text NOT NULL,
    status text DEFAULT 'planned'::text NOT NULL,
    failure_code text,
    result jsonb,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: gtm_auto_refill_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtm_auto_refill_policies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    play_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    campaign_version_id uuid NOT NULL,
    represented_noli_user_id uuid NOT NULL,
    noli_organization_id uuid NOT NULL,
    requested_by_user_id uuid NOT NULL,
    status text DEFAULT 'pending_schedule'::text NOT NULL,
    policy_hash text NOT NULL,
    campaign_content_hash text NOT NULL,
    plan_hash text NOT NULL,
    target_accepted_per_day integer NOT NULL,
    max_raw_candidates_per_day integer NOT NULL,
    max_credits_per_day integer NOT NULL,
    run_hour_local integer NOT NULL,
    timezone text NOT NULL,
    scheduled_job_id text NOT NULL,
    fence integer DEFAULT 0 NOT NULL,
    blocked_reason text,
    last_cycle_local_date text,
    last_cycle_at timestamp with time zone,
    last_success_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: gtm_campaign_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtm_campaign_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    version integer NOT NULL,
    snapshot jsonb NOT NULL,
    content_hash text NOT NULL,
    approved_by_user_id uuid,
    approved_at timestamp with time zone,
    invalidated_at timestamp with time zone,
    invalidated_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: gtm_campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtm_campaigns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    play_id uuid NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    current_version_id uuid,
    channel_mix jsonb,
    settings jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: gtm_candidate_matches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtm_candidate_matches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    play_id uuid NOT NULL,
    research_run_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    provider_operation_id uuid,
    fit_status text DEFAULT 'unscored'::text NOT NULL,
    fit_score numeric(6,3),
    reject_reason text,
    quality_status text,
    quality_score numeric(6,3),
    qualification jsonb,
    qualification_version text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: gtm_candidate_relations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtm_candidate_relations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    play_id uuid NOT NULL,
    research_run_id uuid NOT NULL,
    parent_match_id uuid NOT NULL,
    parent_candidate_id uuid NOT NULL,
    child_candidate_id uuid NOT NULL,
    provider_operation_id uuid NOT NULL,
    relationship_kind text NOT NULL,
    observed_title text NOT NULL,
    confidence numeric(6,3) NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: gtm_candidates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtm_candidates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    research_run_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    entity_kind text NOT NULL,
    identity jsonb NOT NULL,
    dedupe_key text NOT NULL,
    fit_status text DEFAULT 'unscored'::text NOT NULL,
    fit_score numeric(6,3),
    reject_reason text,
    quality_status text,
    quality_score numeric(6,3),
    qualification jsonb,
    qualification_version text,
    retention_expires_at timestamp with time zone,
    promoted_contact_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: gtm_chat_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtm_chat_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    role text NOT NULL,
    content jsonb NOT NULL,
    tool_ref text,
    seq integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: gtm_chat_threads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtm_chat_threads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    title text,
    status text DEFAULT 'active'::text NOT NULL,
    last_message_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: gtm_contact_points; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtm_contact_points (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    channel text NOT NULL,
    value text NOT NULL,
    verification_state text DEFAULT 'found'::text NOT NULL,
    provider_operation_id uuid,
    provenance jsonb,
    verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: gtm_deletion_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtm_deletion_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    scope text NOT NULL,
    address_hash text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    legal_hold boolean DEFAULT false NOT NULL,
    legal_hold_reason text,
    requested_at timestamp with time zone NOT NULL,
    due_at timestamp with time zone,
    completed_at timestamp with time zone,
    result_counts jsonb,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: gtm_dsr_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtm_dsr_operations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    deletion_request_id uuid NOT NULL,
    provider text NOT NULL,
    kind text NOT NULL,
    idempotency_key text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone,
    receipt jsonb,
    last_error text,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: gtm_enrollments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtm_enrollments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    campaign_version_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    contact_id uuid,
    status text DEFAULT 'active'::text NOT NULL,
    stop_reason text,
    stopped_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: gtm_evidence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtm_evidence (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    claim text NOT NULL,
    source_url text,
    provider_ref jsonb,
    observed_at timestamp with time zone,
    retrieved_at timestamp with time zone,
    confidence numeric(6,3),
    license jsonb,
    quality_status text,
    quality_issues jsonb,
    evidence_type text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    research_run_id uuid
);


--
-- Name: gtm_icp_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtm_icp_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    version integer NOT NULL,
    content jsonb NOT NULL,
    locked boolean DEFAULT false NOT NULL,
    locked_by_user_id uuid,
    locked_at timestamp with time zone,
    provenance jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: gtm_inbound_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtm_inbound_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    mailbox_connection_id uuid,
    provider text NOT NULL,
    provider_event_id text NOT NULL,
    dedupe_key text NOT NULL,
    event_kind text NOT NULL,
    provider_message_id text,
    rfc_message_id text,
    email_message_id uuid,
    send_attempt_id uuid,
    enrollment_id uuid,
    correlation_method text,
    correlation_confidence text,
    address_hash text,
    evidence_redacted jsonb,
    processing_state text DEFAULT 'pending'::text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    processed_at timestamp with time zone,
    last_error text,
    processing_claim_token uuid,
    processing_claim_expires_at timestamp with time zone,
    processing_fence integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: gtm_mailbox_cursors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtm_mailbox_cursors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    mailbox_connection_id uuid NOT NULL,
    provider text NOT NULL,
    cursor_kind text NOT NULL,
    cursor_hash text,
    sealed_cursor text,
    last_occurred_at timestamp with time zone,
    last_message_id uuid,
    lease_token uuid,
    lease_expires_at timestamp with time zone,
    fence integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'idle'::text NOT NULL,
    last_success_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: gtm_mailbox_health; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtm_mailbox_health (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    mailbox_connection_id uuid NOT NULL,
    policy_version text DEFAULT 'mailbox-health-v1'::text NOT NULL,
    status text DEFAULT 'healthy'::text NOT NULL,
    rolling_window_started_at timestamp with time zone NOT NULL,
    accepted_count integer DEFAULT 0 NOT NULL,
    delivered_count integer DEFAULT 0 NOT NULL,
    soft_bounce_count integer DEFAULT 0 NOT NULL,
    hard_bounce_count integer DEFAULT 0 NOT NULL,
    complaint_count integer DEFAULT 0 NOT NULL,
    pause_reason text,
    pause_until timestamp with time zone,
    last_event_at timestamp with time zone,
    fence integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: gtm_mailbox_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtm_mailbox_policies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    mailbox_connection_id uuid NOT NULL,
    policy_version text DEFAULT 'mailbox-capacity-v1'::text NOT NULL,
    daily_cap integer DEFAULT 25 NOT NULL,
    send_window_start_hour integer DEFAULT 9 NOT NULL,
    send_window_end_hour integer DEFAULT 17 NOT NULL,
    timezone text DEFAULT 'America/New_York'::text NOT NULL,
    bound_by_campaign_version_id uuid NOT NULL,
    fence integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: gtm_manual_outreach_drafts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtm_manual_outreach_drafts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    play_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    match_id uuid NOT NULL,
    channel text NOT NULL,
    destination_url text NOT NULL,
    body_text text NOT NULL,
    content_hash text NOT NULL,
    evidence_hash text NOT NULL,
    model text,
    provenance jsonb,
    idempotency_key_hash text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    copied_at timestamp with time zone,
    opened_at timestamp with time zone,
    dismissed_at timestamp with time zone,
    retention_expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: gtm_plays; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtm_plays (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    source text NOT NULL,
    imported_report_token_hash text,
    imported_play_key text,
    market_type text,
    audience text,
    signal text,
    signal_kind text,
    provider_query jsonb,
    source_hint text,
    geography text,
    recency_window text,
    why_now text,
    recommended_angle text,
    supported_channels jsonb,
    estimated_size jsonb,
    entity_unit text,
    estimate_method text,
    estimate_basis text,
    business_evidence jsonb,
    confidence text,
    confidence_rationale text,
    likely_buyer text,
    execution_eligibility text NOT NULL,
    eligibility_reason text,
    eligibility_evaluated_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    lead_mode text,
    research_eligibility text,
    research_eligibility_reason text,
    outreach_mode text,
    outreach_policy_reason text,
    policy_flags jsonb,
    policy_evaluated_at timestamp with time zone
);


--
-- Name: gtm_provider_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtm_provider_operations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    noli_core_operation_id uuid NOT NULL,
    research_run_id uuid,
    candidate_id uuid,
    kind text NOT NULL,
    provider text NOT NULL,
    local_status_mirror text,
    receipt jsonb,
    requested_at timestamp with time zone,
    settled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: gtm_provider_reconciliation_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtm_provider_reconciliation_actions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    provider_operation_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    decision text NOT NULL,
    expected_status text NOT NULL,
    resulting_status text,
    charged_credits bigint,
    evidence_hash text NOT NULL,
    evidence_redacted jsonb NOT NULL,
    actor_user_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    failure_reason text,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: gtm_rendered_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtm_rendered_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    campaign_version_id uuid NOT NULL,
    enrollment_id uuid NOT NULL,
    step_id uuid NOT NULL,
    subject text,
    body_html text,
    body_text text,
    content_hash text NOT NULL,
    edited_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: gtm_replies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtm_replies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    enrollment_id uuid NOT NULL,
    send_attempt_id uuid,
    step_id uuid,
    channel text NOT NULL,
    direction text DEFAULT 'inbound'::text NOT NULL,
    email_message_id uuid,
    classification text,
    classification_source text,
    draft_response jsonb,
    draft_status text DEFAULT 'none'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    inbound_event_id uuid,
    event_kind text,
    correlation_confidence text
);


--
-- Name: gtm_research_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtm_research_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    play_id uuid NOT NULL,
    input_snapshot jsonb,
    provider_plan jsonb,
    limits jsonb,
    status text DEFAULT 'planned'::text NOT NULL,
    estimated_credits numeric(12,4),
    reconciled_credits numeric(12,4),
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: gtm_send_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtm_send_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    enrollment_id uuid NOT NULL,
    step_id uuid NOT NULL,
    rendered_message_id uuid,
    campaign_version_id uuid NOT NULL,
    mailbox_connection_id uuid,
    state text DEFAULT 'planned'::text NOT NULL,
    claim_token uuid,
    claim_expires_at timestamp with time zone,
    fence integer DEFAULT 0 NOT NULL,
    attempt_no integer DEFAULT 1 NOT NULL,
    idempotency_key text NOT NULL,
    provider_message_id text,
    rfc_message_id text,
    provider_receipt jsonb,
    failure_reason text,
    ambiguous_at timestamp with time zone,
    scheduled_for timestamp with time zone,
    sent_at timestamp with time zone,
    accepted_at timestamp with time zone,
    failed_at timestamp with time zone,
    delivered_at timestamp with time zone,
    bounced_at timestamp with time zone,
    complained_at timestamp with time zone,
    replied_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    capacity_slot_key text,
    kind text DEFAULT 'campaign'::text NOT NULL,
    transport_retry_count integer DEFAULT 0 NOT NULL
);


--
-- Name: gtm_social_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtm_social_connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    provider text NOT NULL,
    provider_user_id text NOT NULL,
    username text,
    display_name text,
    access_token_sealed text NOT NULL,
    token_issued_at timestamp with time zone NOT NULL,
    token_expires_at timestamp with time zone,
    last_refreshed_at timestamp with time zone,
    scopes jsonb,
    status text DEFAULT 'active'::text NOT NULL,
    status_reason text,
    query_window_started_at timestamp with time zone,
    queries_in_window integer DEFAULT 0 NOT NULL,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: gtm_steps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtm_steps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    campaign_version_id uuid NOT NULL,
    "order" integer NOT NULL,
    channel text NOT NULL,
    mode text NOT NULL,
    delay_days integer DEFAULT 0 NOT NULL,
    send_window jsonb,
    depends_on_step_id uuid,
    dependency_kind text DEFAULT 'none'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: gtm_suppressions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtm_suppressions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    scope text DEFAULT 'org'::text NOT NULL,
    channel text NOT NULL,
    address_hash text NOT NULL,
    address_display text,
    reason text NOT NULL,
    source jsonb,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: gtm_voice_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtm_voice_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    version integer NOT NULL,
    content jsonb NOT NULL,
    locked boolean DEFAULT false NOT NULL,
    locked_by_user_id uuid,
    locked_at timestamp with time zone,
    provenance jsonb,
    derived_from jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: gtm_workspaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gtm_workspaces (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    business_context jsonb,
    settings jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: inbox_ai_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inbox_ai_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    knowledge_base text,
    tone text DEFAULT 'professional'::text,
    instructions text,
    business_name text,
    business_description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    signature text,
    reply_mode text DEFAULT 'draft'::text NOT NULL,
    hybrid_confidence_threshold numeric DEFAULT 0.85 NOT NULL,
    flag_scenarios jsonb,
    voice_auto_learn boolean DEFAULT false NOT NULL
);


--
-- Name: inbox_audiences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inbox_audiences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    action text DEFAULT 'no_draft'::text NOT NULL,
    emails jsonb DEFAULT '[]'::jsonb NOT NULL,
    crm_list_id uuid,
    contact_stages jsonb DEFAULT '[]'::jsonb NOT NULL,
    is_default_team boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    crm_list_ids jsonb DEFAULT '[]'::jsonb NOT NULL
);


--
-- Name: inbox_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inbox_conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    contact_id uuid,
    chat_conversation_id uuid,
    status text DEFAULT 'open'::text NOT NULL,
    unread_count integer DEFAULT 0 NOT NULL,
    last_message_at timestamp with time zone,
    last_message_channel text,
    last_message_preview text,
    last_message_direction text,
    display_name text,
    avatar_email text,
    avatar_phone text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    cs_drafted_at timestamp with time zone,
    source_mailbox_purpose text,
    inbox_drafted_at timestamp with time zone,
    inbox_draft_skip_reason text,
    ai_summary text,
    ai_summary_at timestamp with time zone,
    seq_suggestion jsonb
);


--
-- Name: inbox_discrepancies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inbox_discrepancies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    proposal_id uuid NOT NULL,
    action_id uuid,
    type text NOT NULL,
    severity text NOT NULL,
    description text NOT NULL,
    expected_value text,
    found_value text,
    resolved boolean DEFAULT false NOT NULL,
    metadata jsonb,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: inbox_emails; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inbox_emails (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    message_id text,
    content_hash text,
    forwarded_by_address text NOT NULL,
    forwarded_by_name text,
    to_address text NOT NULL,
    subject text NOT NULL,
    reply_to text,
    in_reply_to text,
    "references" jsonb,
    raw_text text,
    raw_html text,
    cleaned_text text,
    thread_messages jsonb,
    detected_language text,
    attachment_ids jsonb,
    received_at timestamp with time zone NOT NULL,
    status text DEFAULT 'received'::text NOT NULL,
    processing_error text,
    is_active boolean DEFAULT true NOT NULL,
    metadata jsonb,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: inbox_knowledge; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inbox_knowledge (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    source_url text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: inbox_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inbox_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    inbox_conversation_id uuid NOT NULL,
    user_id uuid NOT NULL,
    user_name text,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: inbox_proposal_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inbox_proposal_actions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    proposal_id uuid NOT NULL,
    sort_order integer NOT NULL,
    action_type text NOT NULL,
    description text NOT NULL,
    payload jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    confidence numeric(3,2) NOT NULL,
    required_feature text,
    matched_entity_id uuid,
    matched_entity_type text,
    created_entity_id uuid,
    created_entity_type text,
    execution_error text,
    executed_at timestamp with time zone,
    executed_by_user_id uuid,
    is_active boolean DEFAULT true NOT NULL,
    metadata jsonb,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: inbox_proposals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inbox_proposals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    inbox_email_id uuid NOT NULL,
    summary text NOT NULL,
    participants jsonb NOT NULL,
    confidence numeric(3,2) NOT NULL,
    detected_language text,
    status text DEFAULT 'pending'::text NOT NULL,
    possibly_incomplete boolean DEFAULT false NOT NULL,
    reviewed_by_user_id uuid,
    reviewed_at timestamp with time zone,
    llm_model text,
    llm_tokens_used integer,
    is_active boolean DEFAULT true NOT NULL,
    metadata jsonb,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone,
    working_language text,
    translations jsonb,
    category text
);


--
-- Name: inbox_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inbox_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    inbox_address text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone,
    working_language text DEFAULT 'en'::text NOT NULL
);


--
-- Name: indexer_error_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.indexer_error_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source text NOT NULL,
    handler text NOT NULL,
    entity_type text,
    record_id text,
    tenant_id uuid,
    organization_id uuid,
    payload jsonb,
    message text NOT NULL,
    stack text,
    occurred_at timestamp with time zone NOT NULL
);


--
-- Name: indexer_status_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.indexer_status_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source text NOT NULL,
    handler text NOT NULL,
    level text DEFAULT 'info'::text NOT NULL,
    entity_type text,
    record_id text,
    tenant_id uuid,
    organization_id uuid,
    message text NOT NULL,
    details jsonb,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: integrations_api_ams_commands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integrations_api_ams_commands (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    source_organization_id uuid NOT NULL,
    principal_ref uuid NOT NULL,
    command_id uuid NOT NULL,
    command_type text NOT NULL,
    command_ref text NOT NULL,
    idempotency_digest text NOT NULL,
    nonce_digest text NOT NULL,
    canonical_hash text NOT NULL,
    payload_digest text NOT NULL,
    issuer text NOT NULL,
    audience text NOT NULL,
    contract_version text NOT NULL,
    schema_version integer NOT NULL,
    key_version text NOT NULL,
    issued_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    state text DEFAULT 'shadow_validated'::text NOT NULL,
    safe_failure_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: integrations_api_ams_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integrations_api_ams_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    source_organization_id uuid NOT NULL,
    event_id uuid NOT NULL,
    event_type text NOT NULL,
    contract_version text NOT NULL,
    schema_version integer NOT NULL,
    issuer text NOT NULL,
    audience text NOT NULL,
    canonical_hash text NOT NULL,
    payload_digest text NOT NULL,
    nonce_digest text NOT NULL,
    key_version text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    state text DEFAULT 'held_dark'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    projection_digest text,
    signed_envelope jsonb
);


--
-- Name: integrations_api_consent_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integrations_api_consent_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    crm_contact_ref text NOT NULL,
    purpose text NOT NULL,
    version bigint NOT NULL,
    state text NOT NULL,
    policy_ref text NOT NULL,
    source_ref text NOT NULL,
    effective_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: integrations_api_suppression_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integrations_api_suppression_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    crm_contact_ref text NOT NULL,
    channel text NOT NULL,
    version bigint NOT NULL,
    active boolean NOT NULL,
    reason_code text NOT NULL,
    effective_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    invoice_number text NOT NULL,
    contact_id uuid,
    deal_id uuid,
    status text DEFAULT 'draft'::text NOT NULL,
    line_items jsonb DEFAULT '[]'::jsonb NOT NULL,
    subtotal numeric(10,2) DEFAULT 0 NOT NULL,
    tax numeric(10,2) DEFAULT 0 NOT NULL,
    total numeric(10,2) DEFAULT 0 NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    due_date timestamp with time zone,
    notes text,
    stripe_payment_link text,
    stripe_invoice_id text,
    sent_at timestamp with time zone,
    paid_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    terms_url text
);


--
-- Name: landing_page_daily_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.landing_page_daily_stats (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    landing_page_id uuid NOT NULL,
    variant_id uuid DEFAULT '00000000-0000-0000-0000-000000000000'::uuid NOT NULL,
    day date NOT NULL,
    views integer DEFAULT 0 NOT NULL,
    submissions integer DEFAULT 0 NOT NULL
);


--
-- Name: landing_page_forms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.landing_page_forms (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    landing_page_id uuid NOT NULL,
    name text DEFAULT 'default'::text NOT NULL,
    fields jsonb DEFAULT '[]'::jsonb NOT NULL,
    redirect_url text,
    notification_email text,
    success_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: landing_page_referrers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.landing_page_referrers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    landing_page_id uuid NOT NULL,
    host text NOT NULL,
    count integer DEFAULT 0 NOT NULL
);


--
-- Name: landing_page_variants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.landing_page_variants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    landing_page_id uuid NOT NULL,
    name text NOT NULL,
    published_html text,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    weight integer DEFAULT 50 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    view_count integer DEFAULT 0 NOT NULL,
    submission_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: landing_pages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.landing_pages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    title text NOT NULL,
    slug text NOT NULL,
    template_id text,
    template_category text,
    status text DEFAULT 'draft'::text NOT NULL,
    config jsonb,
    custom_domain text,
    published_html text,
    owner_user_id uuid,
    view_count integer DEFAULT 0 NOT NULL,
    submission_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    deleted_at timestamp with time zone,
    ab_enabled boolean DEFAULT false NOT NULL
);


--
-- Name: lesson_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lesson_progress (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    enrollment_id uuid NOT NULL,
    lesson_id uuid NOT NULL,
    completed_at timestamp with time zone
);


--
-- Name: meeting_prep_briefs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meeting_prep_briefs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    event_summary text,
    event_start timestamp with time zone NOT NULL,
    brief_html text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    emailed_at timestamp with time zone
);


--
-- Name: message_access_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_access_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    message_id uuid NOT NULL,
    recipient_user_id uuid NOT NULL,
    token text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    use_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone NOT NULL
);


--
-- Name: message_confirmations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_confirmations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    message_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid,
    confirmed boolean DEFAULT true NOT NULL,
    confirmed_by_user_id uuid,
    confirmed_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: message_objects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_objects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    message_id uuid NOT NULL,
    entity_module text NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    action_required boolean DEFAULT false NOT NULL,
    action_type text,
    action_label text,
    entity_snapshot jsonb,
    created_at timestamp with time zone NOT NULL
);


--
-- Name: message_recipients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_recipients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    message_id uuid NOT NULL,
    recipient_user_id uuid NOT NULL,
    recipient_type text DEFAULT 'to'::text NOT NULL,
    status text DEFAULT 'unread'::text NOT NULL,
    read_at timestamp with time zone,
    archived_at timestamp with time zone,
    deleted_at timestamp with time zone,
    email_sent_at timestamp with time zone,
    email_delivered_at timestamp with time zone,
    email_opened_at timestamp with time zone,
    email_failed_at timestamp with time zone,
    email_error text,
    created_at timestamp with time zone NOT NULL
);


--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    type text DEFAULT 'default'::text NOT NULL,
    thread_id uuid,
    parent_message_id uuid,
    sender_user_id uuid NOT NULL,
    subject text NOT NULL,
    body text NOT NULL,
    body_format text DEFAULT 'text'::text NOT NULL,
    priority text DEFAULT 'normal'::text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    is_draft boolean DEFAULT true NOT NULL,
    sent_at timestamp with time zone,
    action_data jsonb,
    action_result jsonb,
    action_taken text,
    action_taken_by_user_id uuid,
    action_taken_at timestamp with time zone,
    send_via_email boolean DEFAULT false NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone,
    visibility text,
    source_entity_type text,
    source_entity_id uuid,
    external_email text,
    external_name text,
    external_email_sent_at timestamp with time zone,
    external_email_failed_at timestamp with time zone,
    external_email_error text
);


--
-- Name: mikro_orm_migrations_api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mikro_orm_migrations_api_keys (
    id integer NOT NULL,
    name character varying(255),
    executed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: mikro_orm_migrations_api_keys_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mikro_orm_migrations_api_keys_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mikro_orm_migrations_api_keys_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mikro_orm_migrations_api_keys_id_seq OWNED BY public.mikro_orm_migrations_api_keys.id;


--
-- Name: mikro_orm_migrations_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mikro_orm_migrations_attachments (
    id integer NOT NULL,
    name character varying(255),
    executed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: mikro_orm_migrations_attachments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mikro_orm_migrations_attachments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mikro_orm_migrations_attachments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mikro_orm_migrations_attachments_id_seq OWNED BY public.mikro_orm_migrations_attachments.id;


--
-- Name: mikro_orm_migrations_audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mikro_orm_migrations_audit_logs (
    id integer NOT NULL,
    name character varying(255),
    executed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: mikro_orm_migrations_audit_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mikro_orm_migrations_audit_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mikro_orm_migrations_audit_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mikro_orm_migrations_audit_logs_id_seq OWNED BY public.mikro_orm_migrations_audit_logs.id;


--
-- Name: mikro_orm_migrations_auth; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mikro_orm_migrations_auth (
    id integer NOT NULL,
    name character varying(255),
    executed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: mikro_orm_migrations_auth_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mikro_orm_migrations_auth_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mikro_orm_migrations_auth_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mikro_orm_migrations_auth_id_seq OWNED BY public.mikro_orm_migrations_auth.id;


--
-- Name: mikro_orm_migrations_billing; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mikro_orm_migrations_billing (
    id integer NOT NULL,
    name character varying(255),
    executed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: mikro_orm_migrations_billing_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mikro_orm_migrations_billing_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mikro_orm_migrations_billing_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mikro_orm_migrations_billing_id_seq OWNED BY public.mikro_orm_migrations_billing.id;


--
-- Name: mikro_orm_migrations_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mikro_orm_migrations_configs (
    id integer NOT NULL,
    name character varying(255),
    executed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: mikro_orm_migrations_configs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mikro_orm_migrations_configs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mikro_orm_migrations_configs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mikro_orm_migrations_configs_id_seq OWNED BY public.mikro_orm_migrations_configs.id;


--
-- Name: mikro_orm_migrations_currencies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mikro_orm_migrations_currencies (
    id integer NOT NULL,
    name character varying(255),
    executed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: mikro_orm_migrations_currencies_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mikro_orm_migrations_currencies_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mikro_orm_migrations_currencies_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mikro_orm_migrations_currencies_id_seq OWNED BY public.mikro_orm_migrations_currencies.id;


--
-- Name: mikro_orm_migrations_customer_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mikro_orm_migrations_customer_accounts (
    id integer NOT NULL,
    name character varying(255),
    executed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: mikro_orm_migrations_customer_accounts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mikro_orm_migrations_customer_accounts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mikro_orm_migrations_customer_accounts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mikro_orm_migrations_customer_accounts_id_seq OWNED BY public.mikro_orm_migrations_customer_accounts.id;


--
-- Name: mikro_orm_migrations_customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mikro_orm_migrations_customers (
    id integer NOT NULL,
    name character varying(255),
    executed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: mikro_orm_migrations_customers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mikro_orm_migrations_customers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mikro_orm_migrations_customers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mikro_orm_migrations_customers_id_seq OWNED BY public.mikro_orm_migrations_customers.id;


--
-- Name: mikro_orm_migrations_dashboards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mikro_orm_migrations_dashboards (
    id integer NOT NULL,
    name character varying(255),
    executed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: mikro_orm_migrations_dashboards_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mikro_orm_migrations_dashboards_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mikro_orm_migrations_dashboards_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mikro_orm_migrations_dashboards_id_seq OWNED BY public.mikro_orm_migrations_dashboards.id;


--
-- Name: mikro_orm_migrations_dictionaries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mikro_orm_migrations_dictionaries (
    id integer NOT NULL,
    name character varying(255),
    executed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: mikro_orm_migrations_dictionaries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mikro_orm_migrations_dictionaries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mikro_orm_migrations_dictionaries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mikro_orm_migrations_dictionaries_id_seq OWNED BY public.mikro_orm_migrations_dictionaries.id;


--
-- Name: mikro_orm_migrations_directory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mikro_orm_migrations_directory (
    id integer NOT NULL,
    name character varying(255),
    executed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: mikro_orm_migrations_directory_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mikro_orm_migrations_directory_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mikro_orm_migrations_directory_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mikro_orm_migrations_directory_id_seq OWNED BY public.mikro_orm_migrations_directory.id;


--
-- Name: mikro_orm_migrations_email; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mikro_orm_migrations_email (
    id integer NOT NULL,
    name character varying(255),
    executed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: mikro_orm_migrations_email_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mikro_orm_migrations_email_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mikro_orm_migrations_email_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mikro_orm_migrations_email_id_seq OWNED BY public.mikro_orm_migrations_email.id;


--
-- Name: mikro_orm_migrations_entities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mikro_orm_migrations_entities (
    id integer NOT NULL,
    name character varying(255),
    executed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: mikro_orm_migrations_entities_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mikro_orm_migrations_entities_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mikro_orm_migrations_entities_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mikro_orm_migrations_entities_id_seq OWNED BY public.mikro_orm_migrations_entities.id;


--
-- Name: mikro_orm_migrations_feature_toggles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mikro_orm_migrations_feature_toggles (
    id integer NOT NULL,
    name character varying(255),
    executed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: mikro_orm_migrations_feature_toggles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mikro_orm_migrations_feature_toggles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mikro_orm_migrations_feature_toggles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mikro_orm_migrations_feature_toggles_id_seq OWNED BY public.mikro_orm_migrations_feature_toggles.id;


--
-- Name: mikro_orm_migrations_gtm; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mikro_orm_migrations_gtm (
    id integer NOT NULL,
    name character varying(255),
    executed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: mikro_orm_migrations_gtm_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mikro_orm_migrations_gtm_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mikro_orm_migrations_gtm_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mikro_orm_migrations_gtm_id_seq OWNED BY public.mikro_orm_migrations_gtm.id;


--
-- Name: mikro_orm_migrations_integrations_api; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mikro_orm_migrations_integrations_api (
    id integer NOT NULL,
    name character varying(255),
    executed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: mikro_orm_migrations_integrations_api_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mikro_orm_migrations_integrations_api_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mikro_orm_migrations_integrations_api_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mikro_orm_migrations_integrations_api_id_seq OWNED BY public.mikro_orm_migrations_integrations_api.id;


--
-- Name: mikro_orm_migrations_landing_pages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mikro_orm_migrations_landing_pages (
    id integer NOT NULL,
    name character varying(255),
    executed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: mikro_orm_migrations_landing_pages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mikro_orm_migrations_landing_pages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mikro_orm_migrations_landing_pages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mikro_orm_migrations_landing_pages_id_seq OWNED BY public.mikro_orm_migrations_landing_pages.id;


--
-- Name: mikro_orm_migrations_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mikro_orm_migrations_messages (
    id integer NOT NULL,
    name character varying(255),
    executed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: mikro_orm_migrations_messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mikro_orm_migrations_messages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mikro_orm_migrations_messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mikro_orm_migrations_messages_id_seq OWNED BY public.mikro_orm_migrations_messages.id;


--
-- Name: mikro_orm_migrations_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mikro_orm_migrations_notifications (
    id integer NOT NULL,
    name character varying(255),
    executed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: mikro_orm_migrations_notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mikro_orm_migrations_notifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mikro_orm_migrations_notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mikro_orm_migrations_notifications_id_seq OWNED BY public.mikro_orm_migrations_notifications.id;


--
-- Name: mikro_orm_migrations_onboarding; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mikro_orm_migrations_onboarding (
    id integer NOT NULL,
    name character varying(255),
    executed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: mikro_orm_migrations_onboarding_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mikro_orm_migrations_onboarding_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mikro_orm_migrations_onboarding_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mikro_orm_migrations_onboarding_id_seq OWNED BY public.mikro_orm_migrations_onboarding.id;


--
-- Name: mikro_orm_migrations_payment_gateways; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mikro_orm_migrations_payment_gateways (
    id integer NOT NULL,
    name character varying(255),
    executed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: mikro_orm_migrations_payment_gateways_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mikro_orm_migrations_payment_gateways_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mikro_orm_migrations_payment_gateways_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mikro_orm_migrations_payment_gateways_id_seq OWNED BY public.mikro_orm_migrations_payment_gateways.id;


--
-- Name: mikro_orm_migrations_planner; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mikro_orm_migrations_planner (
    id integer NOT NULL,
    name character varying(255),
    executed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: mikro_orm_migrations_planner_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mikro_orm_migrations_planner_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mikro_orm_migrations_planner_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mikro_orm_migrations_planner_id_seq OWNED BY public.mikro_orm_migrations_planner.id;


--
-- Name: mikro_orm_migrations_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mikro_orm_migrations_progress (
    id integer NOT NULL,
    name character varying(255),
    executed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: mikro_orm_migrations_progress_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mikro_orm_migrations_progress_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mikro_orm_migrations_progress_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mikro_orm_migrations_progress_id_seq OWNED BY public.mikro_orm_migrations_progress.id;


--
-- Name: mikro_orm_migrations_query_index; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mikro_orm_migrations_query_index (
    id integer NOT NULL,
    name character varying(255),
    executed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: mikro_orm_migrations_query_index_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mikro_orm_migrations_query_index_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mikro_orm_migrations_query_index_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mikro_orm_migrations_query_index_id_seq OWNED BY public.mikro_orm_migrations_query_index.id;


--
-- Name: mikro_orm_migrations_scheduler; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mikro_orm_migrations_scheduler (
    id integer NOT NULL,
    name character varying(255),
    executed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: mikro_orm_migrations_scheduler_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mikro_orm_migrations_scheduler_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mikro_orm_migrations_scheduler_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mikro_orm_migrations_scheduler_id_seq OWNED BY public.mikro_orm_migrations_scheduler.id;


--
-- Name: mikro_orm_migrations_staff; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mikro_orm_migrations_staff (
    id integer NOT NULL,
    name character varying(255),
    executed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: mikro_orm_migrations_staff_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mikro_orm_migrations_staff_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mikro_orm_migrations_staff_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mikro_orm_migrations_staff_id_seq OWNED BY public.mikro_orm_migrations_staff.id;


--
-- Name: mikro_orm_migrations_webhooks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mikro_orm_migrations_webhooks (
    id integer NOT NULL,
    name character varying(255),
    executed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: mikro_orm_migrations_webhooks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mikro_orm_migrations_webhooks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mikro_orm_migrations_webhooks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mikro_orm_migrations_webhooks_id_seq OWNED BY public.mikro_orm_migrations_webhooks.id;


--
-- Name: mikro_orm_migrations_workflows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mikro_orm_migrations_workflows (
    id integer NOT NULL,
    name character varying(255),
    executed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: mikro_orm_migrations_workflows_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mikro_orm_migrations_workflows_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mikro_orm_migrations_workflows_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mikro_orm_migrations_workflows_id_seq OWNED BY public.mikro_orm_migrations_workflows.id;


--
-- Name: module_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.module_configs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    module_id text NOT NULL,
    name text NOT NULL,
    value_json jsonb,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    recipient_user_id uuid NOT NULL,
    type text NOT NULL,
    title text NOT NULL,
    body text,
    icon text,
    severity text DEFAULT 'info'::text NOT NULL,
    status text DEFAULT 'unread'::text NOT NULL,
    action_data jsonb,
    action_result jsonb,
    action_taken text,
    source_module text,
    source_entity_type text,
    source_entity_id uuid,
    link_href text,
    group_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    read_at timestamp with time zone,
    actioned_at timestamp with time zone,
    dismissed_at timestamp with time zone,
    expires_at timestamp with time zone,
    tenant_id uuid NOT NULL,
    organization_id uuid,
    title_key text,
    body_key text,
    title_variables jsonb,
    body_variables jsonb
);


--
-- Name: COLUMN notifications.title_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notifications.title_key IS 'i18n key for notification title';


--
-- Name: COLUMN notifications.body_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notifications.body_key IS 'i18n key for notification body';


--
-- Name: COLUMN notifications.title_variables; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notifications.title_variables IS 'Variables for i18n interpolation in title';


--
-- Name: COLUMN notifications.body_variables; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notifications.body_variables IS 'Variables for i18n interpolation in body';


--
-- Name: onboarding_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.onboarding_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    token_hash text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    first_name text NOT NULL,
    last_name text NOT NULL,
    organization_name text NOT NULL,
    locale text,
    terms_accepted boolean DEFAULT false NOT NULL,
    password_hash text,
    expires_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    tenant_id uuid,
    organization_id uuid,
    user_id uuid,
    last_email_sent_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone,
    processing_started_at timestamp with time zone
);


--
-- Name: organizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organizations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    parent_id uuid,
    root_id uuid,
    tree_path text,
    depth integer DEFAULT 0 NOT NULL,
    ancestor_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    child_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    descendant_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone,
    slug text,
    noli_org_id text,
    owner_user_id uuid,
    max_seats integer
);


--
-- Name: password_resets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_resets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: payment_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    product_id uuid,
    name text NOT NULL,
    url_slug text NOT NULL,
    stripe_payment_link_id text,
    stripe_url text,
    is_active boolean DEFAULT true NOT NULL,
    view_count integer DEFAULT 0 NOT NULL,
    payment_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: payment_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_records (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    invoice_id uuid,
    contact_id uuid,
    amount numeric(10,2) NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    stripe_payment_intent_id text,
    stripe_checkout_session_id text,
    stripe_subscription_id text,
    refunded_amount numeric(10,2) DEFAULT 0,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: planner_availability_rule_sets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.planner_availability_rule_sets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    timezone text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: planner_availability_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.planner_availability_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    subject_type text NOT NULL,
    subject_id uuid NOT NULL,
    timezone text NOT NULL,
    rrule text NOT NULL,
    exdates jsonb DEFAULT '[]'::jsonb NOT NULL,
    kind text DEFAULT 'availability'::text NOT NULL,
    note text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone,
    unavailability_reason_entry_id uuid,
    unavailability_reason_value text,
    CONSTRAINT planner_availability_rules_kind_check CHECK ((kind = ANY (ARRAY['availability'::text, 'unavailability'::text]))),
    CONSTRAINT planner_availability_rules_subject_type_check CHECK ((subject_type = ANY (ARRAY['member'::text, 'resource'::text, 'ruleset'::text])))
);


--
-- Name: products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.products (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    price numeric(10,2) NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    billing_type text DEFAULT 'one_time'::text NOT NULL,
    recurring_interval text,
    stripe_price_id text,
    stripe_product_id text,
    trial_days integer,
    terms_url text,
    requires_shipping boolean DEFAULT false NOT NULL,
    collect_phone boolean DEFAULT false NOT NULL,
    product_type text DEFAULT 'digital'::text,
    course_ids jsonb DEFAULT '[]'::jsonb,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: progress_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.progress_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_type text NOT NULL,
    name text NOT NULL,
    description text,
    status text DEFAULT 'pending'::text NOT NULL,
    progress_percent smallint DEFAULT 0 NOT NULL,
    processed_count integer DEFAULT 0 NOT NULL,
    total_count integer,
    eta_seconds integer,
    started_by_user_id uuid,
    started_at timestamp with time zone,
    heartbeat_at timestamp with time zone,
    finished_at timestamp with time zone,
    result_summary jsonb,
    error_message text,
    error_stack text,
    meta jsonb,
    cancellable boolean DEFAULT false NOT NULL,
    cancelled_by_user_id uuid,
    cancel_requested_at timestamp with time zone,
    parent_job_id uuid,
    partition_index integer,
    partition_count integer,
    tenant_id uuid NOT NULL,
    organization_id uuid,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: reminders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reminders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    message text NOT NULL,
    remind_at timestamp with time zone NOT NULL,
    sent boolean DEFAULT false NOT NULL,
    sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: response_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.response_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    subject text,
    body_text text NOT NULL,
    category text DEFAULT 'general'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: review_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.review_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    channel text DEFAULT 'email'::text NOT NULL,
    status text DEFAULT 'sent'::text NOT NULL,
    rule_id uuid,
    sent_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: role_acls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role_acls (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    role_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    features_json jsonb,
    is_super_admin boolean DEFAULT false NOT NULL,
    organizations_json jsonb,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone
);


--
-- Name: role_sidebar_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role_sidebar_preferences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    role_id uuid NOT NULL,
    tenant_id uuid,
    locale text NOT NULL,
    settings_json jsonb,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone
);


--
-- Name: roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    tenant_id uuid,
    created_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: scheduled_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduled_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid,
    tenant_id uuid,
    scope_type text DEFAULT 'tenant'::text NOT NULL,
    name text NOT NULL,
    description text,
    schedule_type text NOT NULL,
    schedule_value text NOT NULL,
    timezone text DEFAULT 'UTC'::text NOT NULL,
    target_type text NOT NULL,
    target_queue text,
    target_command text,
    target_payload jsonb,
    require_feature text,
    is_enabled boolean DEFAULT true NOT NULL,
    last_run_at timestamp with time zone,
    next_run_at timestamp with time zone,
    source_type text DEFAULT 'user'::text NOT NULL,
    source_module text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    created_by_user_id uuid,
    updated_by_user_id uuid
);


--
-- Name: search_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.search_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    organization_id uuid,
    tenant_id uuid,
    field text NOT NULL,
    token_hash text NOT NULL,
    token text,
    created_at timestamp with time zone NOT NULL
);


--
-- Name: sequence_enrollments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sequence_enrollments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sequence_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    current_step_order integer DEFAULT 1 NOT NULL,
    enrolled_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    paused_at timestamp with time zone
);


--
-- Name: sequence_step_executions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sequence_step_executions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    enrollment_id uuid NOT NULL,
    step_id uuid NOT NULL,
    status text DEFAULT 'scheduled'::text NOT NULL,
    scheduled_for timestamp with time zone NOT NULL,
    executed_at timestamp with time zone,
    result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sequence_steps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sequence_steps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sequence_id uuid NOT NULL,
    step_order integer NOT NULL,
    step_type text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    branch_config jsonb,
    is_goal boolean DEFAULT false NOT NULL,
    goal_config jsonb
);


--
-- Name: sequences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sequences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    trigger_type text DEFAULT 'manual'::text NOT NULL,
    trigger_config jsonb,
    status text DEFAULT 'draft'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone NOT NULL,
    last_used_at timestamp with time zone,
    deleted_at timestamp with time zone
);


--
-- Name: sms_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sms_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    contact_id uuid,
    direction text NOT NULL,
    from_number text NOT NULL,
    to_number text NOT NULL,
    body text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    twilio_sid text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: staff_leave_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_leave_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    member_id uuid NOT NULL,
    start_date timestamp with time zone NOT NULL,
    end_date timestamp with time zone NOT NULL,
    timezone text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    unavailability_reason_entry_id uuid,
    unavailability_reason_value text,
    note text,
    decision_comment text,
    submitted_by_user_id uuid,
    decided_by_user_id uuid,
    decided_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT staff_leave_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))
);


--
-- Name: staff_team_member_activities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_team_member_activities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    activity_type text NOT NULL,
    subject text,
    body text,
    occurred_at timestamp with time zone,
    author_user_id uuid,
    appearance_icon text,
    appearance_color text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    member_id uuid NOT NULL
);


--
-- Name: staff_team_member_addresses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_team_member_addresses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    name text,
    purpose text,
    company_name text,
    address_line1 text NOT NULL,
    address_line2 text,
    city text,
    region text,
    postal_code text,
    country text,
    building_number text,
    flat_number text,
    latitude real,
    longitude real,
    is_primary boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    member_id uuid NOT NULL
);


--
-- Name: staff_team_member_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_team_member_comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    body text NOT NULL,
    author_user_id uuid,
    appearance_icon text,
    appearance_color text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone,
    member_id uuid NOT NULL
);


--
-- Name: staff_team_member_job_histories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_team_member_job_histories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    company_name text,
    description text,
    start_date timestamp with time zone NOT NULL,
    end_date timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    member_id uuid NOT NULL
);


--
-- Name: staff_team_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_team_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    team_id uuid,
    display_name text NOT NULL,
    description text,
    user_id uuid,
    role_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    availability_rule_set_id uuid,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: staff_team_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_team_roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    team_id uuid,
    name text NOT NULL,
    description text,
    appearance_icon text,
    appearance_color text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: staff_teams; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_teams (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: stage_automations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stage_automations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    trigger_stage text NOT NULL,
    action_type text NOT NULL,
    action_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: step_instances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.step_instances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workflow_instance_id uuid NOT NULL,
    step_id character varying(100) NOT NULL,
    step_name character varying(255) NOT NULL,
    step_type character varying(50) NOT NULL,
    status character varying(20) NOT NULL,
    input_data jsonb,
    output_data jsonb,
    error_data jsonb,
    entered_at timestamp with time zone,
    exited_at timestamp with time zone,
    execution_time_ms integer,
    retry_count integer DEFAULT 0 NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: stripe_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stripe_connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    stripe_account_id text NOT NULL,
    access_token text,
    refresh_token text,
    business_name text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: survey_responses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.survey_responses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    survey_id uuid NOT NULL,
    contact_id uuid,
    respondent_email text,
    respondent_name text,
    responses jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: surveys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.surveys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    title text NOT NULL,
    description text,
    slug text NOT NULL,
    fields jsonb DEFAULT '[]'::jsonb NOT NULL,
    thank_you_message text DEFAULT 'Thank you for your response!'::text,
    is_active boolean DEFAULT true NOT NULL,
    response_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: task_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    trigger_type text DEFAULT 'manual'::text NOT NULL,
    trigger_config jsonb DEFAULT '{}'::jsonb,
    tasks jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    title text NOT NULL,
    description text,
    contact_id uuid,
    deal_id uuid,
    due_date timestamp with time zone,
    is_done boolean DEFAULT false NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: team_invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_invites (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    email text NOT NULL,
    role text NOT NULL,
    token text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    invited_by uuid,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tenants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: twilio_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.twilio_connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    account_sid text NOT NULL,
    auth_token text NOT NULL,
    phone_number text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: upgrade_action_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.upgrade_action_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    version text NOT NULL,
    action_id text NOT NULL,
    organization_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    completed_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone NOT NULL
);


--
-- Name: user_acls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_acls (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    features_json jsonb,
    is_super_admin boolean DEFAULT false NOT NULL,
    organizations_json jsonb,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone
);


--
-- Name: user_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    role_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: user_sidebar_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_sidebar_preferences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    tenant_id uuid,
    organization_id uuid,
    locale text NOT NULL,
    settings_json jsonb,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone
);


--
-- Name: user_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workflow_instance_id uuid NOT NULL,
    step_instance_id uuid NOT NULL,
    task_name character varying(255) NOT NULL,
    description text,
    status character varying(20) NOT NULL,
    form_schema jsonb,
    form_data jsonb,
    assigned_to character varying(255),
    assigned_to_roles text[],
    claimed_by character varying(255),
    claimed_at timestamp with time zone,
    due_date timestamp with time zone,
    escalated_at timestamp with time zone,
    escalated_to character varying(255),
    completed_by character varying(255),
    completed_at timestamp with time zone,
    comments text,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid,
    organization_id uuid,
    email text NOT NULL,
    name text,
    password_hash text,
    is_confirmed boolean DEFAULT true NOT NULL,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone,
    email_hash text,
    google_sub text,
    clerk_user_id text
);


--
-- Name: vector_search; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vector_search (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    driver_id text NOT NULL,
    entity_id text NOT NULL,
    record_id text NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid,
    checksum text NOT NULL,
    embedding public.vector(1536) NOT NULL,
    url text,
    presenter jsonb,
    links jsonb,
    payload jsonb,
    result_title text,
    result_subtitle text,
    result_icon text,
    result_badge text,
    result_snapshot text,
    primary_link_href text,
    primary_link_label text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: vector_search_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vector_search_migrations (
    id text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: webhook_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webhook_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    subscription_id uuid NOT NULL,
    event text NOT NULL,
    payload jsonb NOT NULL,
    status_code integer,
    response_body text,
    attempt integer DEFAULT 1 NOT NULL,
    delivered_at timestamp with time zone,
    failed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: webhook_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webhook_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    event text NOT NULL,
    target_url text NOT NULL,
    secret text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workflow_definitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_definitions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workflow_id character varying(100) NOT NULL,
    workflow_name character varying(255) NOT NULL,
    description text,
    version integer DEFAULT 1 NOT NULL,
    definition jsonb NOT NULL,
    metadata jsonb,
    enabled boolean DEFAULT true NOT NULL,
    effective_from timestamp with time zone,
    effective_to timestamp with time zone,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    created_by character varying(255),
    updated_by character varying(255),
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: workflow_event_triggers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_event_triggers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    workflow_definition_id uuid NOT NULL,
    event_pattern character varying(255) NOT NULL,
    config jsonb,
    enabled boolean DEFAULT true NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    created_by character varying(255),
    updated_by character varying(255),
    created_at timestamp(6) with time zone NOT NULL,
    updated_at timestamp(6) with time zone NOT NULL,
    deleted_at timestamp(6) with time zone
);


--
-- Name: workflow_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_events (
    id bigint NOT NULL,
    workflow_instance_id uuid NOT NULL,
    step_instance_id uuid,
    event_type character varying(50) NOT NULL,
    event_data jsonb NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    user_id character varying(255),
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL
);


--
-- Name: workflow_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.workflow_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: workflow_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.workflow_events_id_seq OWNED BY public.workflow_events.id;


--
-- Name: workflow_instances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_instances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    definition_id uuid NOT NULL,
    workflow_id character varying(100) NOT NULL,
    version integer NOT NULL,
    status character varying(30) NOT NULL,
    current_step_id character varying(100) NOT NULL,
    context jsonb NOT NULL,
    correlation_key character varying(255),
    metadata jsonb,
    started_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    paused_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    error_message text,
    error_details jsonb,
    retry_count integer DEFAULT 0 NOT NULL,
    tenant_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone,
    pending_transition jsonb
);


--
-- Name: mikro_orm_migrations_api_keys id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_api_keys ALTER COLUMN id SET DEFAULT nextval('public.mikro_orm_migrations_api_keys_id_seq'::regclass);


--
-- Name: mikro_orm_migrations_attachments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_attachments ALTER COLUMN id SET DEFAULT nextval('public.mikro_orm_migrations_attachments_id_seq'::regclass);


--
-- Name: mikro_orm_migrations_audit_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_audit_logs ALTER COLUMN id SET DEFAULT nextval('public.mikro_orm_migrations_audit_logs_id_seq'::regclass);


--
-- Name: mikro_orm_migrations_auth id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_auth ALTER COLUMN id SET DEFAULT nextval('public.mikro_orm_migrations_auth_id_seq'::regclass);


--
-- Name: mikro_orm_migrations_billing id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_billing ALTER COLUMN id SET DEFAULT nextval('public.mikro_orm_migrations_billing_id_seq'::regclass);


--
-- Name: mikro_orm_migrations_configs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_configs ALTER COLUMN id SET DEFAULT nextval('public.mikro_orm_migrations_configs_id_seq'::regclass);


--
-- Name: mikro_orm_migrations_currencies id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_currencies ALTER COLUMN id SET DEFAULT nextval('public.mikro_orm_migrations_currencies_id_seq'::regclass);


--
-- Name: mikro_orm_migrations_customer_accounts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_customer_accounts ALTER COLUMN id SET DEFAULT nextval('public.mikro_orm_migrations_customer_accounts_id_seq'::regclass);


--
-- Name: mikro_orm_migrations_customers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_customers ALTER COLUMN id SET DEFAULT nextval('public.mikro_orm_migrations_customers_id_seq'::regclass);


--
-- Name: mikro_orm_migrations_dashboards id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_dashboards ALTER COLUMN id SET DEFAULT nextval('public.mikro_orm_migrations_dashboards_id_seq'::regclass);


--
-- Name: mikro_orm_migrations_dictionaries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_dictionaries ALTER COLUMN id SET DEFAULT nextval('public.mikro_orm_migrations_dictionaries_id_seq'::regclass);


--
-- Name: mikro_orm_migrations_directory id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_directory ALTER COLUMN id SET DEFAULT nextval('public.mikro_orm_migrations_directory_id_seq'::regclass);


--
-- Name: mikro_orm_migrations_email id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_email ALTER COLUMN id SET DEFAULT nextval('public.mikro_orm_migrations_email_id_seq'::regclass);


--
-- Name: mikro_orm_migrations_entities id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_entities ALTER COLUMN id SET DEFAULT nextval('public.mikro_orm_migrations_entities_id_seq'::regclass);


--
-- Name: mikro_orm_migrations_feature_toggles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_feature_toggles ALTER COLUMN id SET DEFAULT nextval('public.mikro_orm_migrations_feature_toggles_id_seq'::regclass);


--
-- Name: mikro_orm_migrations_gtm id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_gtm ALTER COLUMN id SET DEFAULT nextval('public.mikro_orm_migrations_gtm_id_seq'::regclass);


--
-- Name: mikro_orm_migrations_integrations_api id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_integrations_api ALTER COLUMN id SET DEFAULT nextval('public.mikro_orm_migrations_integrations_api_id_seq'::regclass);


--
-- Name: mikro_orm_migrations_landing_pages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_landing_pages ALTER COLUMN id SET DEFAULT nextval('public.mikro_orm_migrations_landing_pages_id_seq'::regclass);


--
-- Name: mikro_orm_migrations_messages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_messages ALTER COLUMN id SET DEFAULT nextval('public.mikro_orm_migrations_messages_id_seq'::regclass);


--
-- Name: mikro_orm_migrations_notifications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_notifications ALTER COLUMN id SET DEFAULT nextval('public.mikro_orm_migrations_notifications_id_seq'::regclass);


--
-- Name: mikro_orm_migrations_onboarding id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_onboarding ALTER COLUMN id SET DEFAULT nextval('public.mikro_orm_migrations_onboarding_id_seq'::regclass);


--
-- Name: mikro_orm_migrations_payment_gateways id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_payment_gateways ALTER COLUMN id SET DEFAULT nextval('public.mikro_orm_migrations_payment_gateways_id_seq'::regclass);


--
-- Name: mikro_orm_migrations_planner id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_planner ALTER COLUMN id SET DEFAULT nextval('public.mikro_orm_migrations_planner_id_seq'::regclass);


--
-- Name: mikro_orm_migrations_progress id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_progress ALTER COLUMN id SET DEFAULT nextval('public.mikro_orm_migrations_progress_id_seq'::regclass);


--
-- Name: mikro_orm_migrations_query_index id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_query_index ALTER COLUMN id SET DEFAULT nextval('public.mikro_orm_migrations_query_index_id_seq'::regclass);


--
-- Name: mikro_orm_migrations_scheduler id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_scheduler ALTER COLUMN id SET DEFAULT nextval('public.mikro_orm_migrations_scheduler_id_seq'::regclass);


--
-- Name: mikro_orm_migrations_staff id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_staff ALTER COLUMN id SET DEFAULT nextval('public.mikro_orm_migrations_staff_id_seq'::regclass);


--
-- Name: mikro_orm_migrations_webhooks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_webhooks ALTER COLUMN id SET DEFAULT nextval('public.mikro_orm_migrations_webhooks_id_seq'::regclass);


--
-- Name: mikro_orm_migrations_workflows id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_workflows ALTER COLUMN id SET DEFAULT nextval('public.mikro_orm_migrations_workflows_id_seq'::regclass);


--
-- Name: workflow_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_events ALTER COLUMN id SET DEFAULT nextval('public.workflow_events_id_seq'::regclass);


--
-- Name: access_logs access_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_logs
    ADD CONSTRAINT access_logs_pkey PRIMARY KEY (id);


--
-- Name: action_logs action_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.action_logs
    ADD CONSTRAINT action_logs_pkey PRIMARY KEY (id);


--
-- Name: affiliate_campaigns affiliate_campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_campaigns
    ADD CONSTRAINT affiliate_campaigns_pkey PRIMARY KEY (id);


--
-- Name: affiliate_payouts affiliate_payouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_payouts
    ADD CONSTRAINT affiliate_payouts_pkey PRIMARY KEY (id);


--
-- Name: affiliate_referrals affiliate_referrals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_referrals
    ADD CONSTRAINT affiliate_referrals_pkey PRIMARY KEY (id);


--
-- Name: affiliates affiliates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliates
    ADD CONSTRAINT affiliates_pkey PRIMARY KEY (id);


--
-- Name: ai_settings ai_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_settings
    ADD CONSTRAINT ai_settings_pkey PRIMARY KEY (id);


--
-- Name: ai_usage ai_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_usage
    ADD CONSTRAINT ai_usage_pkey PRIMARY KEY (id);


--
-- Name: api_keys api_keys_key_prefix_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_key_prefix_unique UNIQUE (key_prefix);


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: assistant_conversations assistant_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assistant_conversations
    ADD CONSTRAINT assistant_conversations_pkey PRIMARY KEY (id);


--
-- Name: attachment_partitions attachment_partitions_code_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachment_partitions
    ADD CONSTRAINT attachment_partitions_code_unique UNIQUE (code);


--
-- Name: attachment_partitions attachment_partitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachment_partitions
    ADD CONSTRAINT attachment_partitions_pkey PRIMARY KEY (id);


--
-- Name: attachments attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_pkey PRIMARY KEY (id);


--
-- Name: automation_rule_logs automation_rule_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_rule_logs
    ADD CONSTRAINT automation_rule_logs_pkey PRIMARY KEY (id);


--
-- Name: automation_rules automation_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_rules
    ADD CONSTRAINT automation_rules_pkey PRIMARY KEY (id);


--
-- Name: booking_pages booking_pages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_pages
    ADD CONSTRAINT booking_pages_pkey PRIMARY KEY (id);


--
-- Name: bookings bookings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_pkey PRIMARY KEY (id);


--
-- Name: business_profiles business_profiles_organization_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_profiles
    ADD CONSTRAINT business_profiles_organization_id_key UNIQUE (organization_id);


--
-- Name: business_profiles business_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_profiles
    ADD CONSTRAINT business_profiles_pkey PRIMARY KEY (id);


--
-- Name: chat_conversations chat_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_conversations
    ADD CONSTRAINT chat_conversations_pkey PRIMARY KEY (id);


--
-- Name: chat_messages chat_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_pkey PRIMARY KEY (id);


--
-- Name: chat_widgets chat_widgets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_widgets
    ADD CONSTRAINT chat_widgets_pkey PRIMARY KEY (id);


--
-- Name: commitments commitments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commitments
    ADD CONSTRAINT commitments_pkey PRIMARY KEY (id);


--
-- Name: contact_attachments contact_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_attachments
    ADD CONSTRAINT contact_attachments_pkey PRIMARY KEY (id);


--
-- Name: contact_engagement_scores contact_engagement_scores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_engagement_scores
    ADD CONSTRAINT contact_engagement_scores_pkey PRIMARY KEY (id);


--
-- Name: contact_notes contact_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_notes
    ADD CONSTRAINT contact_notes_pkey PRIMARY KEY (id);


--
-- Name: contact_open_times contact_open_times_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_open_times
    ADD CONSTRAINT contact_open_times_pkey PRIMARY KEY (id);


--
-- Name: contact_timeline_events contact_timeline_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_timeline_events
    ADD CONSTRAINT contact_timeline_events_pkey PRIMARY KEY (id);


--
-- Name: course_enrollments course_enrollments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.course_enrollments
    ADD CONSTRAINT course_enrollments_pkey PRIMARY KEY (id);


--
-- Name: course_lessons course_lessons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.course_lessons
    ADD CONSTRAINT course_lessons_pkey PRIMARY KEY (id);


--
-- Name: course_magic_tokens course_magic_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.course_magic_tokens
    ADD CONSTRAINT course_magic_tokens_pkey PRIMARY KEY (id);


--
-- Name: course_magic_tokens course_magic_tokens_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.course_magic_tokens
    ADD CONSTRAINT course_magic_tokens_token_key UNIQUE (token);


--
-- Name: course_modules course_modules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.course_modules
    ADD CONSTRAINT course_modules_pkey PRIMARY KEY (id);


--
-- Name: course_student_sessions course_student_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.course_student_sessions
    ADD CONSTRAINT course_student_sessions_pkey PRIMARY KEY (id);


--
-- Name: course_student_sessions course_student_sessions_session_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.course_student_sessions
    ADD CONSTRAINT course_student_sessions_session_token_key UNIQUE (session_token);


--
-- Name: courses courses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.courses
    ADD CONSTRAINT courses_pkey PRIMARY KEY (id);


--
-- Name: credit_balances credit_balances_organization_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_balances
    ADD CONSTRAINT credit_balances_organization_id_key UNIQUE (organization_id);


--
-- Name: credit_balances credit_balances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_balances
    ADD CONSTRAINT credit_balances_pkey PRIMARY KEY (id);


--
-- Name: credit_packages credit_packages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_packages
    ADD CONSTRAINT credit_packages_pkey PRIMARY KEY (id);


--
-- Name: credit_transactions credit_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_transactions
    ADD CONSTRAINT credit_transactions_pkey PRIMARY KEY (id);


--
-- Name: customer_service_settings css_org_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_service_settings
    ADD CONSTRAINT css_org_key UNIQUE (organization_id);


--
-- Name: currencies currencies_code_scope_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.currencies
    ADD CONSTRAINT currencies_code_scope_unique UNIQUE (organization_id, tenant_id, code);


--
-- Name: currencies currencies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.currencies
    ADD CONSTRAINT currencies_pkey PRIMARY KEY (id);


--
-- Name: currency_fetch_configs currency_fetch_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.currency_fetch_configs
    ADD CONSTRAINT currency_fetch_configs_pkey PRIMARY KEY (id);


--
-- Name: currency_fetch_configs currency_fetch_configs_provider_scope_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.currency_fetch_configs
    ADD CONSTRAINT currency_fetch_configs_provider_scope_unique UNIQUE (organization_id, tenant_id, provider);


--
-- Name: custom_entities custom_entities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_entities
    ADD CONSTRAINT custom_entities_pkey PRIMARY KEY (id);


--
-- Name: custom_entities_storage custom_entities_storage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_entities_storage
    ADD CONSTRAINT custom_entities_storage_pkey PRIMARY KEY (id);


--
-- Name: custom_field_defs custom_field_defs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_field_defs
    ADD CONSTRAINT custom_field_defs_pkey PRIMARY KEY (id);


--
-- Name: custom_field_entity_configs custom_field_entity_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_field_entity_configs
    ADD CONSTRAINT custom_field_entity_configs_pkey PRIMARY KEY (id);


--
-- Name: custom_field_values custom_field_values_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_field_values
    ADD CONSTRAINT custom_field_values_pkey PRIMARY KEY (id);


--
-- Name: customer_activities customer_activities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_activities
    ADD CONSTRAINT customer_activities_pkey PRIMARY KEY (id);


--
-- Name: customer_addresses customer_addresses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_addresses
    ADD CONSTRAINT customer_addresses_pkey PRIMARY KEY (id);


--
-- Name: customer_comments customer_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_comments
    ADD CONSTRAINT customer_comments_pkey PRIMARY KEY (id);


--
-- Name: customer_companies customer_companies_entity_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_companies
    ADD CONSTRAINT customer_companies_entity_id_unique UNIQUE (entity_id);


--
-- Name: customer_companies customer_companies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_companies
    ADD CONSTRAINT customer_companies_pkey PRIMARY KEY (id);


--
-- Name: customer_deal_companies customer_deal_companies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_deal_companies
    ADD CONSTRAINT customer_deal_companies_pkey PRIMARY KEY (id);


--
-- Name: customer_deal_companies customer_deal_companies_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_deal_companies
    ADD CONSTRAINT customer_deal_companies_unique UNIQUE (deal_id, company_entity_id);


--
-- Name: customer_deal_people customer_deal_people_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_deal_people
    ADD CONSTRAINT customer_deal_people_pkey PRIMARY KEY (id);


--
-- Name: customer_deal_people customer_deal_people_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_deal_people
    ADD CONSTRAINT customer_deal_people_unique UNIQUE (deal_id, person_entity_id);


--
-- Name: customer_deals customer_deals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_deals
    ADD CONSTRAINT customer_deals_pkey PRIMARY KEY (id);


--
-- Name: customer_dictionary_entries customer_dictionary_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_dictionary_entries
    ADD CONSTRAINT customer_dictionary_entries_pkey PRIMARY KEY (id);


--
-- Name: customer_dictionary_entries customer_dictionary_entries_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_dictionary_entries
    ADD CONSTRAINT customer_dictionary_entries_unique UNIQUE (organization_id, tenant_id, kind, normalized_value);


--
-- Name: customer_entities customer_entities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_entities
    ADD CONSTRAINT customer_entities_pkey PRIMARY KEY (id);


--
-- Name: customer_people customer_people_entity_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_people
    ADD CONSTRAINT customer_people_entity_id_unique UNIQUE (entity_id);


--
-- Name: customer_people customer_people_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_people
    ADD CONSTRAINT customer_people_pkey PRIMARY KEY (id);


--
-- Name: customer_pipeline_automation_rules customer_pipeline_automation_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_pipeline_automation_rules
    ADD CONSTRAINT customer_pipeline_automation_rules_pkey PRIMARY KEY (id);


--
-- Name: customer_pipeline_automation_runs customer_pipeline_automation_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_pipeline_automation_runs
    ADD CONSTRAINT customer_pipeline_automation_runs_pkey PRIMARY KEY (id);


--
-- Name: customer_pipeline_stages customer_pipeline_stages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_pipeline_stages
    ADD CONSTRAINT customer_pipeline_stages_pkey PRIMARY KEY (id);


--
-- Name: customer_pipelines customer_pipelines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_pipelines
    ADD CONSTRAINT customer_pipelines_pkey PRIMARY KEY (id);


--
-- Name: customer_role_acls customer_role_acls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_role_acls
    ADD CONSTRAINT customer_role_acls_pkey PRIMARY KEY (id);


--
-- Name: customer_role_acls customer_role_acls_role_tenant_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_role_acls
    ADD CONSTRAINT customer_role_acls_role_tenant_uniq UNIQUE (role_id, tenant_id);


--
-- Name: customer_roles customer_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_roles
    ADD CONSTRAINT customer_roles_pkey PRIMARY KEY (id);


--
-- Name: customer_roles customer_roles_tenant_slug_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_roles
    ADD CONSTRAINT customer_roles_tenant_slug_uniq UNIQUE (tenant_id, slug);


--
-- Name: customer_service_knowledge customer_service_knowledge_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_service_knowledge
    ADD CONSTRAINT customer_service_knowledge_pkey PRIMARY KEY (id);


--
-- Name: customer_service_settings customer_service_settings_organization_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_service_settings
    ADD CONSTRAINT customer_service_settings_organization_id_key UNIQUE (organization_id);


--
-- Name: customer_service_settings customer_service_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_service_settings
    ADD CONSTRAINT customer_service_settings_pkey PRIMARY KEY (id);


--
-- Name: customer_settings customer_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_settings
    ADD CONSTRAINT customer_settings_pkey PRIMARY KEY (id);


--
-- Name: customer_settings customer_settings_scope_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_settings
    ADD CONSTRAINT customer_settings_scope_unique UNIQUE (organization_id, tenant_id);


--
-- Name: customer_tag_assignments customer_tag_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_tag_assignments
    ADD CONSTRAINT customer_tag_assignments_pkey PRIMARY KEY (id);


--
-- Name: customer_tag_assignments customer_tag_assignments_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_tag_assignments
    ADD CONSTRAINT customer_tag_assignments_unique UNIQUE (tag_id, entity_id);


--
-- Name: customer_tags customer_tags_org_slug_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_tags
    ADD CONSTRAINT customer_tags_org_slug_unique UNIQUE (organization_id, tenant_id, slug);


--
-- Name: customer_tags customer_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_tags
    ADD CONSTRAINT customer_tags_pkey PRIMARY KEY (id);


--
-- Name: customer_todo_links customer_todo_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_todo_links
    ADD CONSTRAINT customer_todo_links_pkey PRIMARY KEY (id);


--
-- Name: customer_todo_links customer_todo_links_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_todo_links
    ADD CONSTRAINT customer_todo_links_unique UNIQUE (entity_id, todo_id, todo_source);


--
-- Name: customer_user_acls customer_user_acls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_user_acls
    ADD CONSTRAINT customer_user_acls_pkey PRIMARY KEY (id);


--
-- Name: customer_user_acls customer_user_acls_user_tenant_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_user_acls
    ADD CONSTRAINT customer_user_acls_user_tenant_uniq UNIQUE (user_id, tenant_id);


--
-- Name: customer_user_email_verifications customer_user_email_verifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_user_email_verifications
    ADD CONSTRAINT customer_user_email_verifications_pkey PRIMARY KEY (id);


--
-- Name: customer_user_invitations customer_user_invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_user_invitations
    ADD CONSTRAINT customer_user_invitations_pkey PRIMARY KEY (id);


--
-- Name: customer_user_password_resets customer_user_password_resets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_user_password_resets
    ADD CONSTRAINT customer_user_password_resets_pkey PRIMARY KEY (id);


--
-- Name: customer_user_roles customer_user_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_user_roles
    ADD CONSTRAINT customer_user_roles_pkey PRIMARY KEY (id);


--
-- Name: customer_user_roles customer_user_roles_user_role_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_user_roles
    ADD CONSTRAINT customer_user_roles_user_role_uniq UNIQUE (user_id, role_id);


--
-- Name: customer_user_sessions customer_user_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_user_sessions
    ADD CONSTRAINT customer_user_sessions_pkey PRIMARY KEY (id);


--
-- Name: customer_users customer_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_users
    ADD CONSTRAINT customer_users_pkey PRIMARY KEY (id);


--
-- Name: customer_users customer_users_tenant_email_hash_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_users
    ADD CONSTRAINT customer_users_tenant_email_hash_uniq UNIQUE (tenant_id, email_hash);


--
-- Name: dashboard_layouts dashboard_layouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_layouts
    ADD CONSTRAINT dashboard_layouts_pkey PRIMARY KEY (id);


--
-- Name: dashboard_layouts dashboard_layouts_user_id_tenant_id_organization_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_layouts
    ADD CONSTRAINT dashboard_layouts_user_id_tenant_id_organization_id_unique UNIQUE (user_id, tenant_id, organization_id);


--
-- Name: dashboard_role_widgets dashboard_role_widgets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_role_widgets
    ADD CONSTRAINT dashboard_role_widgets_pkey PRIMARY KEY (id);


--
-- Name: dashboard_role_widgets dashboard_role_widgets_role_id_tenant_id_organization_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_role_widgets
    ADD CONSTRAINT dashboard_role_widgets_role_id_tenant_id_organization_id_unique UNIQUE (role_id, tenant_id, organization_id);


--
-- Name: dashboard_user_widgets dashboard_user_widgets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_user_widgets
    ADD CONSTRAINT dashboard_user_widgets_pkey PRIMARY KEY (id);


--
-- Name: dashboard_user_widgets dashboard_user_widgets_user_id_tenant_id_organization_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_user_widgets
    ADD CONSTRAINT dashboard_user_widgets_user_id_tenant_id_organization_id_unique UNIQUE (user_id, tenant_id, organization_id);


--
-- Name: dictionaries dictionaries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dictionaries
    ADD CONSTRAINT dictionaries_pkey PRIMARY KEY (id);


--
-- Name: dictionaries dictionaries_scope_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dictionaries
    ADD CONSTRAINT dictionaries_scope_key_unique UNIQUE (organization_id, tenant_id, key);


--
-- Name: dictionary_entries dictionary_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dictionary_entries
    ADD CONSTRAINT dictionary_entries_pkey PRIMARY KEY (id);


--
-- Name: dictionary_entries dictionary_entries_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dictionary_entries
    ADD CONSTRAINT dictionary_entries_unique UNIQUE (dictionary_id, organization_id, tenant_id, normalized_value);


--
-- Name: email_accounts email_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_accounts
    ADD CONSTRAINT email_accounts_pkey PRIMARY KEY (id);


--
-- Name: email_campaign_recipients email_campaign_recipients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_campaign_recipients
    ADD CONSTRAINT email_campaign_recipients_pkey PRIMARY KEY (id);


--
-- Name: email_campaigns email_campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_campaigns
    ADD CONSTRAINT email_campaigns_pkey PRIMARY KEY (id);


--
-- Name: email_connections email_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_connections
    ADD CONSTRAINT email_connections_pkey PRIMARY KEY (id);


--
-- Name: email_intelligence_settings email_intelligence_settings_organization_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_intelligence_settings
    ADD CONSTRAINT email_intelligence_settings_organization_id_user_id_key UNIQUE (organization_id, user_id);


--
-- Name: email_intelligence_settings email_intelligence_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_intelligence_settings
    ADD CONSTRAINT email_intelligence_settings_pkey PRIMARY KEY (id);


--
-- Name: email_list_members email_list_members_list_id_contact_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_list_members
    ADD CONSTRAINT email_list_members_list_id_contact_id_key UNIQUE (list_id, contact_id);


--
-- Name: email_list_members email_list_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_list_members
    ADD CONSTRAINT email_list_members_pkey PRIMARY KEY (id);


--
-- Name: email_lists email_lists_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_lists
    ADD CONSTRAINT email_lists_pkey PRIMARY KEY (id);


--
-- Name: email_messages email_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_messages
    ADD CONSTRAINT email_messages_pkey PRIMARY KEY (id);


--
-- Name: email_preference_categories email_preference_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_preference_categories
    ADD CONSTRAINT email_preference_categories_pkey PRIMARY KEY (id);


--
-- Name: email_preferences email_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_preferences
    ADD CONSTRAINT email_preferences_pkey PRIMARY KEY (id);


--
-- Name: email_routing email_routing_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_routing
    ADD CONSTRAINT email_routing_pkey PRIMARY KEY (id);


--
-- Name: email_style_templates email_style_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_style_templates
    ADD CONSTRAINT email_style_templates_pkey PRIMARY KEY (id);


--
-- Name: email_templates email_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_templates
    ADD CONSTRAINT email_templates_pkey PRIMARY KEY (id);


--
-- Name: email_unsubscribes email_unsubscribes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_unsubscribes
    ADD CONSTRAINT email_unsubscribes_pkey PRIMARY KEY (id);


--
-- Name: encryption_maps encryption_maps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encryption_maps
    ADD CONSTRAINT encryption_maps_pkey PRIMARY KEY (id);


--
-- Name: engagement_events engagement_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.engagement_events
    ADD CONSTRAINT engagement_events_pkey PRIMARY KEY (id);


--
-- Name: entity_index_coverage entity_index_coverage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_index_coverage
    ADD CONSTRAINT entity_index_coverage_pkey PRIMARY KEY (id);


--
-- Name: entity_index_coverage entity_index_coverage_scope_idx; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_index_coverage
    ADD CONSTRAINT entity_index_coverage_scope_idx UNIQUE (entity_type, tenant_id, organization_id, with_deleted);


--
-- Name: entity_index_jobs entity_index_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_index_jobs
    ADD CONSTRAINT entity_index_jobs_pkey PRIMARY KEY (id);


--
-- Name: entity_indexes entity_indexes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_indexes
    ADD CONSTRAINT entity_indexes_pkey PRIMARY KEY (id);


--
-- Name: esp_connections esp_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.esp_connections
    ADD CONSTRAINT esp_connections_pkey PRIMARY KEY (id);


--
-- Name: esp_sender_addresses esp_sender_addresses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.esp_sender_addresses
    ADD CONSTRAINT esp_sender_addresses_pkey PRIMARY KEY (id);


--
-- Name: exchange_rates exchange_rates_pair_datetime_source_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exchange_rates
    ADD CONSTRAINT exchange_rates_pair_datetime_source_unique UNIQUE (organization_id, tenant_id, from_currency_code, to_currency_code, date, source);


--
-- Name: exchange_rates exchange_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exchange_rates
    ADD CONSTRAINT exchange_rates_pkey PRIMARY KEY (id);


--
-- Name: feature_toggle_audit_logs feature_toggle_audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_toggle_audit_logs
    ADD CONSTRAINT feature_toggle_audit_logs_pkey PRIMARY KEY (id);


--
-- Name: feature_toggle_overrides feature_toggle_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_toggle_overrides
    ADD CONSTRAINT feature_toggle_overrides_pkey PRIMARY KEY (id);


--
-- Name: feature_toggle_overrides feature_toggle_overrides_toggle_tenant_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_toggle_overrides
    ADD CONSTRAINT feature_toggle_overrides_toggle_tenant_unique UNIQUE (toggle_id, tenant_id);


--
-- Name: feature_toggles feature_toggles_identifier_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_toggles
    ADD CONSTRAINT feature_toggles_identifier_unique UNIQUE (identifier);


--
-- Name: feature_toggles feature_toggles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_toggles
    ADD CONSTRAINT feature_toggles_pkey PRIMARY KEY (id);


--
-- Name: form_submissions form_submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_submissions
    ADD CONSTRAINT form_submissions_pkey PRIMARY KEY (id);


--
-- Name: forms forms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forms
    ADD CONSTRAINT forms_pkey PRIMARY KEY (id);


--
-- Name: funnel_orders funnel_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.funnel_orders
    ADD CONSTRAINT funnel_orders_pkey PRIMARY KEY (id);


--
-- Name: funnel_sessions funnel_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.funnel_sessions
    ADD CONSTRAINT funnel_sessions_pkey PRIMARY KEY (id);


--
-- Name: funnel_steps funnel_steps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.funnel_steps
    ADD CONSTRAINT funnel_steps_pkey PRIMARY KEY (id);


--
-- Name: funnel_visits funnel_visits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.funnel_visits
    ADD CONSTRAINT funnel_visits_pkey PRIMARY KEY (id);


--
-- Name: funnels funnels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.funnels
    ADD CONSTRAINT funnels_pkey PRIMARY KEY (id);


--
-- Name: gateway_transactions gateway_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gateway_transactions
    ADD CONSTRAINT gateway_transactions_pkey PRIMARY KEY (id);


--
-- Name: gateway_webhook_events gateway_webhook_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gateway_webhook_events
    ADD CONSTRAINT gateway_webhook_events_pkey PRIMARY KEY (id);


--
-- Name: google_calendar_connections google_calendar_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_calendar_connections
    ADD CONSTRAINT google_calendar_connections_pkey PRIMARY KEY (id);


--
-- Name: gtm_ai_telemetry gtm_ai_telemetry_org_operation_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_ai_telemetry
    ADD CONSTRAINT gtm_ai_telemetry_org_operation_unique UNIQUE (organization_id, operation_key);


--
-- Name: gtm_ai_telemetry gtm_ai_telemetry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_ai_telemetry
    ADD CONSTRAINT gtm_ai_telemetry_pkey PRIMARY KEY (id);


--
-- Name: gtm_audit_events gtm_audit_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_audit_events
    ADD CONSTRAINT gtm_audit_events_pkey PRIMARY KEY (id);


--
-- Name: gtm_auto_refill_cycles gtm_auto_refill_cycles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_auto_refill_cycles
    ADD CONSTRAINT gtm_auto_refill_cycles_pkey PRIMARY KEY (id);


--
-- Name: gtm_auto_refill_cycles gtm_auto_refill_cycles_policy_local_date_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_auto_refill_cycles
    ADD CONSTRAINT gtm_auto_refill_cycles_policy_local_date_unique UNIQUE (policy_id, local_date);


--
-- Name: gtm_auto_refill_policies gtm_auto_refill_policies_org_tenant_campaign_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_auto_refill_policies
    ADD CONSTRAINT gtm_auto_refill_policies_org_tenant_campaign_unique UNIQUE (organization_id, tenant_id, campaign_id);


--
-- Name: gtm_auto_refill_policies gtm_auto_refill_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_auto_refill_policies
    ADD CONSTRAINT gtm_auto_refill_policies_pkey PRIMARY KEY (id);


--
-- Name: gtm_campaign_versions gtm_campaign_versions_campaign_version_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_campaign_versions
    ADD CONSTRAINT gtm_campaign_versions_campaign_version_unique UNIQUE (campaign_id, version);


--
-- Name: gtm_campaign_versions gtm_campaign_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_campaign_versions
    ADD CONSTRAINT gtm_campaign_versions_pkey PRIMARY KEY (id);


--
-- Name: gtm_campaigns gtm_campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_campaigns
    ADD CONSTRAINT gtm_campaigns_pkey PRIMARY KEY (id);


--
-- Name: gtm_candidate_matches gtm_candidate_matches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_candidate_matches
    ADD CONSTRAINT gtm_candidate_matches_pkey PRIMARY KEY (id);


--
-- Name: gtm_candidate_matches gtm_candidate_matches_run_candidate_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_candidate_matches
    ADD CONSTRAINT gtm_candidate_matches_run_candidate_unique UNIQUE (research_run_id, candidate_id);


--
-- Name: gtm_candidate_relations gtm_candidate_relations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_candidate_relations
    ADD CONSTRAINT gtm_candidate_relations_pkey PRIMARY KEY (id);


--
-- Name: gtm_candidate_relations gtm_candidate_relations_run_parent_child_kind_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_candidate_relations
    ADD CONSTRAINT gtm_candidate_relations_run_parent_child_kind_unique UNIQUE (research_run_id, parent_candidate_id, child_candidate_id, relationship_kind);


--
-- Name: gtm_candidates gtm_candidates_org_workspace_dedupe_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_candidates
    ADD CONSTRAINT gtm_candidates_org_workspace_dedupe_unique UNIQUE (organization_id, workspace_id, dedupe_key);


--
-- Name: gtm_candidates gtm_candidates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_candidates
    ADD CONSTRAINT gtm_candidates_pkey PRIMARY KEY (id);


--
-- Name: gtm_chat_messages gtm_chat_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_chat_messages
    ADD CONSTRAINT gtm_chat_messages_pkey PRIMARY KEY (id);


--
-- Name: gtm_chat_messages gtm_chat_messages_thread_seq_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_chat_messages
    ADD CONSTRAINT gtm_chat_messages_thread_seq_unique UNIQUE (thread_id, seq);


--
-- Name: gtm_chat_threads gtm_chat_threads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_chat_threads
    ADD CONSTRAINT gtm_chat_threads_pkey PRIMARY KEY (id);


--
-- Name: gtm_contact_points gtm_contact_points_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_contact_points
    ADD CONSTRAINT gtm_contact_points_pkey PRIMARY KEY (id);


--
-- Name: gtm_deletion_requests gtm_deletion_requests_org_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_deletion_requests
    ADD CONSTRAINT gtm_deletion_requests_org_key_unique UNIQUE (organization_id, idempotency_key);


--
-- Name: gtm_deletion_requests gtm_deletion_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_deletion_requests
    ADD CONSTRAINT gtm_deletion_requests_pkey PRIMARY KEY (id);


--
-- Name: gtm_dsr_operations gtm_dsr_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_dsr_operations
    ADD CONSTRAINT gtm_dsr_operations_pkey PRIMARY KEY (id);


--
-- Name: gtm_dsr_operations gtm_dsr_operations_request_org_provider_kind_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_dsr_operations
    ADD CONSTRAINT gtm_dsr_operations_request_org_provider_kind_unique UNIQUE (deletion_request_id, organization_id, provider, kind);


--
-- Name: gtm_enrollments gtm_enrollments_campaign_candidate_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_enrollments
    ADD CONSTRAINT gtm_enrollments_campaign_candidate_unique UNIQUE (campaign_id, candidate_id);


--
-- Name: gtm_enrollments gtm_enrollments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_enrollments
    ADD CONSTRAINT gtm_enrollments_pkey PRIMARY KEY (id);


--
-- Name: gtm_evidence gtm_evidence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_evidence
    ADD CONSTRAINT gtm_evidence_pkey PRIMARY KEY (id);


--
-- Name: gtm_icp_versions gtm_icp_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_icp_versions
    ADD CONSTRAINT gtm_icp_versions_pkey PRIMARY KEY (id);


--
-- Name: gtm_icp_versions gtm_icp_versions_workspace_version_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_icp_versions
    ADD CONSTRAINT gtm_icp_versions_workspace_version_unique UNIQUE (workspace_id, version);


--
-- Name: gtm_inbound_events gtm_inbound_events_org_tenant_dedupe_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_inbound_events
    ADD CONSTRAINT gtm_inbound_events_org_tenant_dedupe_unique UNIQUE (organization_id, tenant_id, dedupe_key);


--
-- Name: gtm_inbound_events gtm_inbound_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_inbound_events
    ADD CONSTRAINT gtm_inbound_events_pkey PRIMARY KEY (id);


--
-- Name: gtm_mailbox_cursors gtm_mailbox_cursors_mailbox_provider_kind_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_mailbox_cursors
    ADD CONSTRAINT gtm_mailbox_cursors_mailbox_provider_kind_unique UNIQUE (organization_id, tenant_id, mailbox_connection_id, provider, cursor_kind);


--
-- Name: gtm_mailbox_cursors gtm_mailbox_cursors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_mailbox_cursors
    ADD CONSTRAINT gtm_mailbox_cursors_pkey PRIMARY KEY (id);


--
-- Name: gtm_mailbox_health gtm_mailbox_health_org_tenant_mailbox_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_mailbox_health
    ADD CONSTRAINT gtm_mailbox_health_org_tenant_mailbox_unique UNIQUE (organization_id, tenant_id, mailbox_connection_id);


--
-- Name: gtm_mailbox_health gtm_mailbox_health_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_mailbox_health
    ADD CONSTRAINT gtm_mailbox_health_pkey PRIMARY KEY (id);


--
-- Name: gtm_mailbox_policies gtm_mailbox_policies_org_tenant_mailbox_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_mailbox_policies
    ADD CONSTRAINT gtm_mailbox_policies_org_tenant_mailbox_unique UNIQUE (organization_id, tenant_id, mailbox_connection_id);


--
-- Name: gtm_mailbox_policies gtm_mailbox_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_mailbox_policies
    ADD CONSTRAINT gtm_mailbox_policies_pkey PRIMARY KEY (id);


--
-- Name: gtm_manual_outreach_drafts gtm_manual_outreach_drafts_org_idempotency_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_manual_outreach_drafts
    ADD CONSTRAINT gtm_manual_outreach_drafts_org_idempotency_unique UNIQUE (organization_id, tenant_id, idempotency_key_hash);


--
-- Name: gtm_manual_outreach_drafts gtm_manual_outreach_drafts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_manual_outreach_drafts
    ADD CONSTRAINT gtm_manual_outreach_drafts_pkey PRIMARY KEY (id);


--
-- Name: gtm_plays gtm_plays_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_plays
    ADD CONSTRAINT gtm_plays_pkey PRIMARY KEY (id);


--
-- Name: gtm_provider_operations gtm_provider_operations_noli_core_operation_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_provider_operations
    ADD CONSTRAINT gtm_provider_operations_noli_core_operation_unique UNIQUE (noli_core_operation_id);


--
-- Name: gtm_provider_operations gtm_provider_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_provider_operations
    ADD CONSTRAINT gtm_provider_operations_pkey PRIMARY KEY (id);


--
-- Name: gtm_provider_reconciliation_actions gtm_provider_reconciliation_actions_org_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_provider_reconciliation_actions
    ADD CONSTRAINT gtm_provider_reconciliation_actions_org_key_unique UNIQUE (organization_id, idempotency_key);


--
-- Name: gtm_provider_reconciliation_actions gtm_provider_reconciliation_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_provider_reconciliation_actions
    ADD CONSTRAINT gtm_provider_reconciliation_actions_pkey PRIMARY KEY (id);


--
-- Name: gtm_rendered_messages gtm_rendered_messages_enrollment_step_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_rendered_messages
    ADD CONSTRAINT gtm_rendered_messages_enrollment_step_unique UNIQUE (enrollment_id, step_id);


--
-- Name: gtm_rendered_messages gtm_rendered_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_rendered_messages
    ADD CONSTRAINT gtm_rendered_messages_pkey PRIMARY KEY (id);


--
-- Name: gtm_replies gtm_replies_org_tenant_event_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_replies
    ADD CONSTRAINT gtm_replies_org_tenant_event_unique UNIQUE (organization_id, tenant_id, inbound_event_id);


--
-- Name: gtm_replies gtm_replies_org_tenant_message_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_replies
    ADD CONSTRAINT gtm_replies_org_tenant_message_unique UNIQUE (organization_id, tenant_id, email_message_id);


--
-- Name: gtm_replies gtm_replies_org_tenant_social_step_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_replies
    ADD CONSTRAINT gtm_replies_org_tenant_social_step_unique UNIQUE (organization_id, tenant_id, enrollment_id, step_id);


--
-- Name: gtm_replies gtm_replies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_replies
    ADD CONSTRAINT gtm_replies_pkey PRIMARY KEY (id);


--
-- Name: gtm_research_runs gtm_research_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_research_runs
    ADD CONSTRAINT gtm_research_runs_pkey PRIMARY KEY (id);


--
-- Name: gtm_send_attempts gtm_send_attempts_org_capacity_slot_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_send_attempts
    ADD CONSTRAINT gtm_send_attempts_org_capacity_slot_unique UNIQUE (organization_id, capacity_slot_key);


--
-- Name: gtm_send_attempts gtm_send_attempts_org_idempotency_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_send_attempts
    ADD CONSTRAINT gtm_send_attempts_org_idempotency_unique UNIQUE (organization_id, idempotency_key);


--
-- Name: gtm_send_attempts gtm_send_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_send_attempts
    ADD CONSTRAINT gtm_send_attempts_pkey PRIMARY KEY (id);


--
-- Name: gtm_social_connections gtm_social_connections_org_provider_user_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_social_connections
    ADD CONSTRAINT gtm_social_connections_org_provider_user_unique UNIQUE (organization_id, tenant_id, provider, provider_user_id);


--
-- Name: gtm_social_connections gtm_social_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_social_connections
    ADD CONSTRAINT gtm_social_connections_pkey PRIMARY KEY (id);


--
-- Name: gtm_steps gtm_steps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_steps
    ADD CONSTRAINT gtm_steps_pkey PRIMARY KEY (id);


--
-- Name: gtm_suppressions gtm_suppressions_org_channel_address_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_suppressions
    ADD CONSTRAINT gtm_suppressions_org_channel_address_unique UNIQUE (organization_id, channel, address_hash);


--
-- Name: gtm_suppressions gtm_suppressions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_suppressions
    ADD CONSTRAINT gtm_suppressions_pkey PRIMARY KEY (id);


--
-- Name: gtm_voice_versions gtm_voice_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_voice_versions
    ADD CONSTRAINT gtm_voice_versions_pkey PRIMARY KEY (id);


--
-- Name: gtm_voice_versions gtm_voice_versions_workspace_version_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_voice_versions
    ADD CONSTRAINT gtm_voice_versions_workspace_version_unique UNIQUE (workspace_id, version);


--
-- Name: gtm_workspaces gtm_workspaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_workspaces
    ADD CONSTRAINT gtm_workspaces_pkey PRIMARY KEY (id);


--
-- Name: inbox_ai_settings inbox_ai_settings_organization_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbox_ai_settings
    ADD CONSTRAINT inbox_ai_settings_organization_id_key UNIQUE (organization_id);


--
-- Name: inbox_ai_settings inbox_ai_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbox_ai_settings
    ADD CONSTRAINT inbox_ai_settings_pkey PRIMARY KEY (id);


--
-- Name: inbox_audiences inbox_audiences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbox_audiences
    ADD CONSTRAINT inbox_audiences_pkey PRIMARY KEY (id);


--
-- Name: inbox_conversations inbox_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbox_conversations
    ADD CONSTRAINT inbox_conversations_pkey PRIMARY KEY (id);


--
-- Name: inbox_discrepancies inbox_discrepancies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbox_discrepancies
    ADD CONSTRAINT inbox_discrepancies_pkey PRIMARY KEY (id);


--
-- Name: inbox_emails inbox_emails_organization_id_tenant_id_content_hash_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbox_emails
    ADD CONSTRAINT inbox_emails_organization_id_tenant_id_content_hash_unique UNIQUE (organization_id, tenant_id, content_hash);


--
-- Name: inbox_emails inbox_emails_organization_id_tenant_id_message_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbox_emails
    ADD CONSTRAINT inbox_emails_organization_id_tenant_id_message_id_unique UNIQUE (organization_id, tenant_id, message_id);


--
-- Name: inbox_emails inbox_emails_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbox_emails
    ADD CONSTRAINT inbox_emails_pkey PRIMARY KEY (id);


--
-- Name: inbox_knowledge inbox_knowledge_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbox_knowledge
    ADD CONSTRAINT inbox_knowledge_pkey PRIMARY KEY (id);


--
-- Name: inbox_notes inbox_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbox_notes
    ADD CONSTRAINT inbox_notes_pkey PRIMARY KEY (id);


--
-- Name: inbox_proposal_actions inbox_proposal_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbox_proposal_actions
    ADD CONSTRAINT inbox_proposal_actions_pkey PRIMARY KEY (id);


--
-- Name: inbox_proposals inbox_proposals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbox_proposals
    ADD CONSTRAINT inbox_proposals_pkey PRIMARY KEY (id);


--
-- Name: inbox_settings inbox_settings_inbox_address_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbox_settings
    ADD CONSTRAINT inbox_settings_inbox_address_unique UNIQUE (inbox_address);


--
-- Name: inbox_settings inbox_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbox_settings
    ADD CONSTRAINT inbox_settings_pkey PRIMARY KEY (id);


--
-- Name: indexer_error_logs indexer_error_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.indexer_error_logs
    ADD CONSTRAINT indexer_error_logs_pkey PRIMARY KEY (id);


--
-- Name: indexer_status_logs indexer_status_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.indexer_status_logs
    ADD CONSTRAINT indexer_status_logs_pkey PRIMARY KEY (id);


--
-- Name: integrations_api_ams_commands integrations_api_ams_commands_command_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integrations_api_ams_commands
    ADD CONSTRAINT integrations_api_ams_commands_command_unique UNIQUE (organization_id, tenant_id, command_id);


--
-- Name: integrations_api_ams_commands integrations_api_ams_commands_idempotency_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integrations_api_ams_commands
    ADD CONSTRAINT integrations_api_ams_commands_idempotency_unique UNIQUE (organization_id, tenant_id, idempotency_digest);


--
-- Name: integrations_api_ams_commands integrations_api_ams_commands_nonce_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integrations_api_ams_commands
    ADD CONSTRAINT integrations_api_ams_commands_nonce_unique UNIQUE (organization_id, tenant_id, nonce_digest);


--
-- Name: integrations_api_ams_commands integrations_api_ams_commands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integrations_api_ams_commands
    ADD CONSTRAINT integrations_api_ams_commands_pkey PRIMARY KEY (id);


--
-- Name: integrations_api_ams_events integrations_api_ams_events_event_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integrations_api_ams_events
    ADD CONSTRAINT integrations_api_ams_events_event_unique UNIQUE (organization_id, tenant_id, event_id);


--
-- Name: integrations_api_ams_events integrations_api_ams_events_nonce_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integrations_api_ams_events
    ADD CONSTRAINT integrations_api_ams_events_nonce_unique UNIQUE (organization_id, tenant_id, nonce_digest);


--
-- Name: integrations_api_ams_events integrations_api_ams_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integrations_api_ams_events
    ADD CONSTRAINT integrations_api_ams_events_pkey PRIMARY KEY (id);


--
-- Name: integrations_api_ams_events integrations_api_ams_events_projection_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integrations_api_ams_events
    ADD CONSTRAINT integrations_api_ams_events_projection_unique UNIQUE (organization_id, tenant_id, projection_digest);


--
-- Name: integrations_api_consent_versions integrations_api_consent_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integrations_api_consent_versions
    ADD CONSTRAINT integrations_api_consent_versions_pkey PRIMARY KEY (id);


--
-- Name: integrations_api_consent_versions integrations_api_consent_versions_subject_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integrations_api_consent_versions
    ADD CONSTRAINT integrations_api_consent_versions_subject_unique UNIQUE (organization_id, tenant_id, crm_contact_ref, purpose, version);


--
-- Name: integrations_api_suppression_versions integrations_api_suppression_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integrations_api_suppression_versions
    ADD CONSTRAINT integrations_api_suppression_versions_pkey PRIMARY KEY (id);


--
-- Name: integrations_api_suppression_versions integrations_api_suppression_versions_subject_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integrations_api_suppression_versions
    ADD CONSTRAINT integrations_api_suppression_versions_subject_unique UNIQUE (organization_id, tenant_id, crm_contact_ref, channel, version);


--
-- Name: invoices invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);


--
-- Name: landing_page_daily_stats landing_page_daily_stats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.landing_page_daily_stats
    ADD CONSTRAINT landing_page_daily_stats_pkey PRIMARY KEY (id);


--
-- Name: landing_page_forms landing_page_forms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.landing_page_forms
    ADD CONSTRAINT landing_page_forms_pkey PRIMARY KEY (id);


--
-- Name: landing_page_referrers landing_page_referrers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.landing_page_referrers
    ADD CONSTRAINT landing_page_referrers_pkey PRIMARY KEY (id);


--
-- Name: landing_page_variants landing_page_variants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.landing_page_variants
    ADD CONSTRAINT landing_page_variants_pkey PRIMARY KEY (id);


--
-- Name: landing_pages landing_pages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.landing_pages
    ADD CONSTRAINT landing_pages_pkey PRIMARY KEY (id);


--
-- Name: lesson_progress lesson_progress_enrollment_id_lesson_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lesson_progress
    ADD CONSTRAINT lesson_progress_enrollment_id_lesson_id_key UNIQUE (enrollment_id, lesson_id);


--
-- Name: lesson_progress lesson_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lesson_progress
    ADD CONSTRAINT lesson_progress_pkey PRIMARY KEY (id);


--
-- Name: meeting_prep_briefs meeting_prep_briefs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_prep_briefs
    ADD CONSTRAINT meeting_prep_briefs_pkey PRIMARY KEY (id);


--
-- Name: message_access_tokens message_access_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_access_tokens
    ADD CONSTRAINT message_access_tokens_pkey PRIMARY KEY (id);


--
-- Name: message_access_tokens message_access_tokens_token_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_access_tokens
    ADD CONSTRAINT message_access_tokens_token_unique UNIQUE (token);


--
-- Name: message_confirmations message_confirmations_message_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_confirmations
    ADD CONSTRAINT message_confirmations_message_unique UNIQUE (message_id);


--
-- Name: message_confirmations message_confirmations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_confirmations
    ADD CONSTRAINT message_confirmations_pkey PRIMARY KEY (id);


--
-- Name: message_objects message_objects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_objects
    ADD CONSTRAINT message_objects_pkey PRIMARY KEY (id);


--
-- Name: message_recipients message_recipients_message_user_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_recipients
    ADD CONSTRAINT message_recipients_message_user_unique UNIQUE (message_id, recipient_user_id);


--
-- Name: message_recipients message_recipients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_recipients
    ADD CONSTRAINT message_recipients_pkey PRIMARY KEY (id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: mikro_orm_migrations_api_keys mikro_orm_migrations_api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_api_keys
    ADD CONSTRAINT mikro_orm_migrations_api_keys_pkey PRIMARY KEY (id);


--
-- Name: mikro_orm_migrations_attachments mikro_orm_migrations_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_attachments
    ADD CONSTRAINT mikro_orm_migrations_attachments_pkey PRIMARY KEY (id);


--
-- Name: mikro_orm_migrations_audit_logs mikro_orm_migrations_audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_audit_logs
    ADD CONSTRAINT mikro_orm_migrations_audit_logs_pkey PRIMARY KEY (id);


--
-- Name: mikro_orm_migrations_auth mikro_orm_migrations_auth_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_auth
    ADD CONSTRAINT mikro_orm_migrations_auth_pkey PRIMARY KEY (id);


--
-- Name: mikro_orm_migrations_billing mikro_orm_migrations_billing_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_billing
    ADD CONSTRAINT mikro_orm_migrations_billing_pkey PRIMARY KEY (id);


--
-- Name: mikro_orm_migrations_configs mikro_orm_migrations_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_configs
    ADD CONSTRAINT mikro_orm_migrations_configs_pkey PRIMARY KEY (id);


--
-- Name: mikro_orm_migrations_currencies mikro_orm_migrations_currencies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_currencies
    ADD CONSTRAINT mikro_orm_migrations_currencies_pkey PRIMARY KEY (id);


--
-- Name: mikro_orm_migrations_customer_accounts mikro_orm_migrations_customer_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_customer_accounts
    ADD CONSTRAINT mikro_orm_migrations_customer_accounts_pkey PRIMARY KEY (id);


--
-- Name: mikro_orm_migrations_customers mikro_orm_migrations_customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_customers
    ADD CONSTRAINT mikro_orm_migrations_customers_pkey PRIMARY KEY (id);


--
-- Name: mikro_orm_migrations_dashboards mikro_orm_migrations_dashboards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_dashboards
    ADD CONSTRAINT mikro_orm_migrations_dashboards_pkey PRIMARY KEY (id);


--
-- Name: mikro_orm_migrations_dictionaries mikro_orm_migrations_dictionaries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_dictionaries
    ADD CONSTRAINT mikro_orm_migrations_dictionaries_pkey PRIMARY KEY (id);


--
-- Name: mikro_orm_migrations_directory mikro_orm_migrations_directory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_directory
    ADD CONSTRAINT mikro_orm_migrations_directory_pkey PRIMARY KEY (id);


--
-- Name: mikro_orm_migrations_email mikro_orm_migrations_email_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_email
    ADD CONSTRAINT mikro_orm_migrations_email_pkey PRIMARY KEY (id);


--
-- Name: mikro_orm_migrations_entities mikro_orm_migrations_entities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_entities
    ADD CONSTRAINT mikro_orm_migrations_entities_pkey PRIMARY KEY (id);


--
-- Name: mikro_orm_migrations_feature_toggles mikro_orm_migrations_feature_toggles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_feature_toggles
    ADD CONSTRAINT mikro_orm_migrations_feature_toggles_pkey PRIMARY KEY (id);


--
-- Name: mikro_orm_migrations_gtm mikro_orm_migrations_gtm_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_gtm
    ADD CONSTRAINT mikro_orm_migrations_gtm_pkey PRIMARY KEY (id);


--
-- Name: mikro_orm_migrations_integrations_api mikro_orm_migrations_integrations_api_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_integrations_api
    ADD CONSTRAINT mikro_orm_migrations_integrations_api_pkey PRIMARY KEY (id);


--
-- Name: mikro_orm_migrations_landing_pages mikro_orm_migrations_landing_pages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_landing_pages
    ADD CONSTRAINT mikro_orm_migrations_landing_pages_pkey PRIMARY KEY (id);


--
-- Name: mikro_orm_migrations_messages mikro_orm_migrations_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_messages
    ADD CONSTRAINT mikro_orm_migrations_messages_pkey PRIMARY KEY (id);


--
-- Name: mikro_orm_migrations_notifications mikro_orm_migrations_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_notifications
    ADD CONSTRAINT mikro_orm_migrations_notifications_pkey PRIMARY KEY (id);


--
-- Name: mikro_orm_migrations_onboarding mikro_orm_migrations_onboarding_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_onboarding
    ADD CONSTRAINT mikro_orm_migrations_onboarding_pkey PRIMARY KEY (id);


--
-- Name: mikro_orm_migrations_payment_gateways mikro_orm_migrations_payment_gateways_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_payment_gateways
    ADD CONSTRAINT mikro_orm_migrations_payment_gateways_pkey PRIMARY KEY (id);


--
-- Name: mikro_orm_migrations_planner mikro_orm_migrations_planner_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_planner
    ADD CONSTRAINT mikro_orm_migrations_planner_pkey PRIMARY KEY (id);


--
-- Name: mikro_orm_migrations_progress mikro_orm_migrations_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_progress
    ADD CONSTRAINT mikro_orm_migrations_progress_pkey PRIMARY KEY (id);


--
-- Name: mikro_orm_migrations_query_index mikro_orm_migrations_query_index_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_query_index
    ADD CONSTRAINT mikro_orm_migrations_query_index_pkey PRIMARY KEY (id);


--
-- Name: mikro_orm_migrations_scheduler mikro_orm_migrations_scheduler_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_scheduler
    ADD CONSTRAINT mikro_orm_migrations_scheduler_pkey PRIMARY KEY (id);


--
-- Name: mikro_orm_migrations_staff mikro_orm_migrations_staff_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_staff
    ADD CONSTRAINT mikro_orm_migrations_staff_pkey PRIMARY KEY (id);


--
-- Name: mikro_orm_migrations_webhooks mikro_orm_migrations_webhooks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_webhooks
    ADD CONSTRAINT mikro_orm_migrations_webhooks_pkey PRIMARY KEY (id);


--
-- Name: mikro_orm_migrations_workflows mikro_orm_migrations_workflows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mikro_orm_migrations_workflows
    ADD CONSTRAINT mikro_orm_migrations_workflows_pkey PRIMARY KEY (id);


--
-- Name: module_configs module_configs_module_name_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.module_configs
    ADD CONSTRAINT module_configs_module_name_unique UNIQUE (module_id, name);


--
-- Name: module_configs module_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.module_configs
    ADD CONSTRAINT module_configs_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: onboarding_requests onboarding_requests_email_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.onboarding_requests
    ADD CONSTRAINT onboarding_requests_email_unique UNIQUE (email);


--
-- Name: onboarding_requests onboarding_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.onboarding_requests
    ADD CONSTRAINT onboarding_requests_pkey PRIMARY KEY (id);


--
-- Name: onboarding_requests onboarding_requests_token_hash_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.onboarding_requests
    ADD CONSTRAINT onboarding_requests_token_hash_unique UNIQUE (token_hash);


--
-- Name: organizations organizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);


--
-- Name: organizations organizations_tenant_slug_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_tenant_slug_uniq UNIQUE (tenant_id, slug);


--
-- Name: password_resets password_resets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_resets
    ADD CONSTRAINT password_resets_pkey PRIMARY KEY (id);


--
-- Name: password_resets password_resets_token_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_resets
    ADD CONSTRAINT password_resets_token_unique UNIQUE (token);


--
-- Name: payment_links payment_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_links
    ADD CONSTRAINT payment_links_pkey PRIMARY KEY (id);


--
-- Name: payment_records payment_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_records
    ADD CONSTRAINT payment_records_pkey PRIMARY KEY (id);


--
-- Name: planner_availability_rule_sets planner_availability_rule_sets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planner_availability_rule_sets
    ADD CONSTRAINT planner_availability_rule_sets_pkey PRIMARY KEY (id);


--
-- Name: planner_availability_rules planner_availability_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.planner_availability_rules
    ADD CONSTRAINT planner_availability_rules_pkey PRIMARY KEY (id);


--
-- Name: products products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);


--
-- Name: progress_jobs progress_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.progress_jobs
    ADD CONSTRAINT progress_jobs_pkey PRIMARY KEY (id);


--
-- Name: reminders reminders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reminders
    ADD CONSTRAINT reminders_pkey PRIMARY KEY (id);


--
-- Name: response_templates response_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.response_templates
    ADD CONSTRAINT response_templates_pkey PRIMARY KEY (id);


--
-- Name: review_requests review_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_requests
    ADD CONSTRAINT review_requests_pkey PRIMARY KEY (id);


--
-- Name: role_acls role_acls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_acls
    ADD CONSTRAINT role_acls_pkey PRIMARY KEY (id);


--
-- Name: role_sidebar_preferences role_sidebar_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_sidebar_preferences
    ADD CONSTRAINT role_sidebar_preferences_pkey PRIMARY KEY (id);


--
-- Name: role_sidebar_preferences role_sidebar_preferences_role_id_tenant_id_locale_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_sidebar_preferences
    ADD CONSTRAINT role_sidebar_preferences_role_id_tenant_id_locale_unique UNIQUE (role_id, tenant_id, locale);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);


--
-- Name: roles roles_tenant_id_name_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_tenant_id_name_unique UNIQUE (tenant_id, name);


--
-- Name: scheduled_jobs scheduled_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_jobs
    ADD CONSTRAINT scheduled_jobs_pkey PRIMARY KEY (id);


--
-- Name: search_tokens search_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_tokens
    ADD CONSTRAINT search_tokens_pkey PRIMARY KEY (id);


--
-- Name: sequence_enrollments sequence_enrollments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequence_enrollments
    ADD CONSTRAINT sequence_enrollments_pkey PRIMARY KEY (id);


--
-- Name: sequence_step_executions sequence_step_executions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequence_step_executions
    ADD CONSTRAINT sequence_step_executions_pkey PRIMARY KEY (id);


--
-- Name: sequence_steps sequence_steps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequence_steps
    ADD CONSTRAINT sequence_steps_pkey PRIMARY KEY (id);


--
-- Name: sequences sequences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequences
    ADD CONSTRAINT sequences_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_token_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_token_unique UNIQUE (token);


--
-- Name: sms_messages sms_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_messages
    ADD CONSTRAINT sms_messages_pkey PRIMARY KEY (id);


--
-- Name: staff_leave_requests staff_leave_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_leave_requests
    ADD CONSTRAINT staff_leave_requests_pkey PRIMARY KEY (id);


--
-- Name: staff_team_member_activities staff_team_member_activities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_team_member_activities
    ADD CONSTRAINT staff_team_member_activities_pkey PRIMARY KEY (id);


--
-- Name: staff_team_member_addresses staff_team_member_addresses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_team_member_addresses
    ADD CONSTRAINT staff_team_member_addresses_pkey PRIMARY KEY (id);


--
-- Name: staff_team_member_comments staff_team_member_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_team_member_comments
    ADD CONSTRAINT staff_team_member_comments_pkey PRIMARY KEY (id);


--
-- Name: staff_team_member_job_histories staff_team_member_job_histories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_team_member_job_histories
    ADD CONSTRAINT staff_team_member_job_histories_pkey PRIMARY KEY (id);


--
-- Name: staff_team_members staff_team_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_team_members
    ADD CONSTRAINT staff_team_members_pkey PRIMARY KEY (id);


--
-- Name: staff_team_roles staff_team_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_team_roles
    ADD CONSTRAINT staff_team_roles_pkey PRIMARY KEY (id);


--
-- Name: staff_teams staff_teams_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_teams
    ADD CONSTRAINT staff_teams_pkey PRIMARY KEY (id);


--
-- Name: stage_automations stage_automations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stage_automations
    ADD CONSTRAINT stage_automations_pkey PRIMARY KEY (id);


--
-- Name: step_instances step_instances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.step_instances
    ADD CONSTRAINT step_instances_pkey PRIMARY KEY (id);


--
-- Name: stripe_connections stripe_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stripe_connections
    ADD CONSTRAINT stripe_connections_pkey PRIMARY KEY (id);


--
-- Name: survey_responses survey_responses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.survey_responses
    ADD CONSTRAINT survey_responses_pkey PRIMARY KEY (id);


--
-- Name: surveys surveys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.surveys
    ADD CONSTRAINT surveys_pkey PRIMARY KEY (id);


--
-- Name: task_templates task_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_templates
    ADD CONSTRAINT task_templates_pkey PRIMARY KEY (id);


--
-- Name: tasks tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);


--
-- Name: team_invites team_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_invites
    ADD CONSTRAINT team_invites_pkey PRIMARY KEY (id);


--
-- Name: tenants tenants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);


--
-- Name: twilio_connections twilio_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.twilio_connections
    ADD CONSTRAINT twilio_connections_pkey PRIMARY KEY (id);


--
-- Name: upgrade_action_runs upgrade_action_runs_action_scope_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upgrade_action_runs
    ADD CONSTRAINT upgrade_action_runs_action_scope_unique UNIQUE (version, action_id, organization_id, tenant_id);


--
-- Name: upgrade_action_runs upgrade_action_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upgrade_action_runs
    ADD CONSTRAINT upgrade_action_runs_pkey PRIMARY KEY (id);


--
-- Name: user_acls user_acls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_acls
    ADD CONSTRAINT user_acls_pkey PRIMARY KEY (id);


--
-- Name: user_roles user_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_pkey PRIMARY KEY (id);


--
-- Name: user_sidebar_preferences user_sidebar_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sidebar_preferences
    ADD CONSTRAINT user_sidebar_preferences_pkey PRIMARY KEY (id);


--
-- Name: user_sidebar_preferences user_sidebar_preferences_user_id_tenant_id_organi_f3f2f_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sidebar_preferences
    ADD CONSTRAINT user_sidebar_preferences_user_id_tenant_id_organi_f3f2f_unique UNIQUE (user_id, tenant_id, organization_id, locale);


--
-- Name: user_tasks user_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_tasks
    ADD CONSTRAINT user_tasks_pkey PRIMARY KEY (id);


--
-- Name: users users_email_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_unique UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: vector_search_migrations vector_search_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vector_search_migrations
    ADD CONSTRAINT vector_search_migrations_pkey PRIMARY KEY (id);


--
-- Name: vector_search vector_search_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vector_search
    ADD CONSTRAINT vector_search_pkey PRIMARY KEY (id);


--
-- Name: webhook_deliveries webhook_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_pkey PRIMARY KEY (id);


--
-- Name: webhook_subscriptions webhook_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_subscriptions
    ADD CONSTRAINT webhook_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: workflow_definitions workflow_definitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_definitions
    ADD CONSTRAINT workflow_definitions_pkey PRIMARY KEY (id);


--
-- Name: workflow_definitions workflow_definitions_workflow_id_tenant_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_definitions
    ADD CONSTRAINT workflow_definitions_workflow_id_tenant_id_unique UNIQUE (workflow_id, tenant_id);


--
-- Name: workflow_event_triggers workflow_event_triggers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_event_triggers
    ADD CONSTRAINT workflow_event_triggers_pkey PRIMARY KEY (id);


--
-- Name: workflow_events workflow_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_events
    ADD CONSTRAINT workflow_events_pkey PRIMARY KEY (id);


--
-- Name: workflow_instances workflow_instances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_instances
    ADD CONSTRAINT workflow_instances_pkey PRIMARY KEY (id);


--
-- Name: access_logs_actor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX access_logs_actor_idx ON public.access_logs USING btree (actor_user_id, created_at);


--
-- Name: access_logs_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX access_logs_tenant_idx ON public.access_logs USING btree (tenant_id, created_at);


--
-- Name: action_logs_actor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX action_logs_actor_idx ON public.action_logs USING btree (actor_user_id, created_at);


--
-- Name: action_logs_parent_resource_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX action_logs_parent_resource_idx ON public.action_logs USING btree (tenant_id, parent_resource_kind, parent_resource_id, created_at);


--
-- Name: action_logs_resource_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX action_logs_resource_idx ON public.action_logs USING btree (tenant_id, resource_kind, resource_id, created_at);


--
-- Name: action_logs_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX action_logs_tenant_idx ON public.action_logs USING btree (tenant_id, created_at);


--
-- Name: affiliate_campaigns_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX affiliate_campaigns_org_idx ON public.affiliate_campaigns USING btree (organization_id, status);


--
-- Name: affiliates_org_code_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX affiliates_org_code_idx ON public.affiliates USING btree (organization_id, affiliate_code);


--
-- Name: affiliates_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX affiliates_org_idx ON public.affiliates USING btree (organization_id, status);


--
-- Name: ai_usage_org_month_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ai_usage_org_month_idx ON public.ai_usage USING btree (organization_id, month);


--
-- Name: assistant_conversations_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX assistant_conversations_tenant_idx ON public.assistant_conversations USING btree (tenant_id);


--
-- Name: assistant_conversations_user_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX assistant_conversations_user_org_idx ON public.assistant_conversations USING btree (user_id, organization_id, updated_at DESC);


--
-- Name: attachments_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX attachments_contact_idx ON public.contact_attachments USING btree (contact_id, created_at DESC);


--
-- Name: attachments_entity_record_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX attachments_entity_record_idx ON public.attachments USING btree (record_id);


--
-- Name: attachments_partition_code_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX attachments_partition_code_idx ON public.attachments USING btree (partition_code);


--
-- Name: automation_logs_rule_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX automation_logs_rule_idx ON public.automation_rule_logs USING btree (rule_id, created_at DESC);


--
-- Name: automation_rules_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX automation_rules_org_idx ON public.automation_rules USING btree (organization_id, trigger_type, is_active);


--
-- Name: bookings_org_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bookings_org_time_idx ON public.bookings USING btree (organization_id, start_time);


--
-- Name: bookings_recurrence_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bookings_recurrence_parent_idx ON public.bookings USING btree (recurrence_parent_id);


--
-- Name: cf_defs_active_entity_global_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cf_defs_active_entity_global_idx ON public.custom_field_defs USING btree (entity_id);


--
-- Name: cf_defs_active_entity_key_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cf_defs_active_entity_key_scope_idx ON public.custom_field_defs USING btree (entity_id, key, tenant_id, organization_id);


--
-- Name: cf_defs_active_entity_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cf_defs_active_entity_org_idx ON public.custom_field_defs USING btree (entity_id, organization_id);


--
-- Name: cf_defs_active_entity_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cf_defs_active_entity_tenant_idx ON public.custom_field_defs USING btree (entity_id, tenant_id);


--
-- Name: cf_defs_active_entity_tenant_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cf_defs_active_entity_tenant_org_idx ON public.custom_field_defs USING btree (entity_id, tenant_id, organization_id);


--
-- Name: cf_defs_entity_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cf_defs_entity_key_idx ON public.custom_field_defs USING btree (key);


--
-- Name: cf_entity_cfgs_entity_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cf_entity_cfgs_entity_org_idx ON public.custom_field_entity_configs USING btree (entity_id, organization_id);


--
-- Name: cf_entity_cfgs_entity_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cf_entity_cfgs_entity_scope_idx ON public.custom_field_entity_configs USING btree (entity_id, tenant_id, organization_id);


--
-- Name: cf_entity_cfgs_entity_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cf_entity_cfgs_entity_tenant_idx ON public.custom_field_entity_configs USING btree (entity_id, tenant_id);


--
-- Name: cf_values_entity_record_field_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cf_values_entity_record_field_idx ON public.custom_field_values USING btree (field_key);


--
-- Name: cf_values_entity_record_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cf_values_entity_record_tenant_idx ON public.custom_field_values USING btree (entity_id, record_id, tenant_id);


--
-- Name: chat_conv_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_conv_org_idx ON public.chat_conversations USING btree (organization_id, status, updated_at DESC);


--
-- Name: chat_msg_conv_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_msg_conv_idx ON public.chat_messages USING btree (conversation_id, created_at);


--
-- Name: chat_widgets_org_slug_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX chat_widgets_org_slug_idx ON public.chat_widgets USING btree (organization_id, slug);


--
-- Name: commitments_org_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX commitments_org_contact_idx ON public.commitments USING btree (organization_id, contact_id, status);


--
-- Name: commitments_org_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX commitments_org_status_idx ON public.commitments USING btree (organization_id, status, due_at);


--
-- Name: contact_notes_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contact_notes_contact_idx ON public.contact_notes USING btree (contact_id, created_at);


--
-- Name: contact_timeline_events_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contact_timeline_events_contact_idx ON public.contact_timeline_events USING btree (contact_id, created_at DESC);


--
-- Name: contact_timeline_events_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contact_timeline_events_org_idx ON public.contact_timeline_events USING btree (organization_id, created_at DESC);


--
-- Name: credit_transactions_org_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX credit_transactions_org_date_idx ON public.credit_transactions USING btree (organization_id, created_at);


--
-- Name: currencies_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX currencies_scope_idx ON public.currencies USING btree (organization_id, tenant_id);


--
-- Name: currency_fetch_configs_enabled_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX currency_fetch_configs_enabled_idx ON public.currency_fetch_configs USING btree (is_enabled, sync_time);


--
-- Name: currency_fetch_configs_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX currency_fetch_configs_scope_idx ON public.currency_fetch_configs USING btree (organization_id, tenant_id);


--
-- Name: custom_entities_storage_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX custom_entities_storage_unique_idx ON public.custom_entities_storage USING btree (entity_type, entity_id, organization_id);


--
-- Name: custom_entities_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX custom_entities_unique_idx ON public.custom_entities USING btree (entity_id, organization_id, tenant_id);


--
-- Name: customer_activities_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_activities_entity_idx ON public.customer_activities USING btree (entity_id);


--
-- Name: customer_activities_entity_occurred_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_activities_entity_occurred_created_idx ON public.customer_activities USING btree (entity_id, occurred_at, created_at);


--
-- Name: customer_activities_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_activities_org_tenant_idx ON public.customer_activities USING btree (organization_id, tenant_id);


--
-- Name: customer_addresses_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_addresses_entity_idx ON public.customer_addresses USING btree (entity_id);


--
-- Name: customer_comments_entity_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_comments_entity_created_idx ON public.customer_comments USING btree (entity_id, created_at);


--
-- Name: customer_comments_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_comments_entity_idx ON public.customer_comments USING btree (entity_id);


--
-- Name: customer_companies_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_companies_org_tenant_idx ON public.customer_companies USING btree (organization_id, tenant_id);


--
-- Name: customer_deal_companies_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_deal_companies_company_idx ON public.customer_deal_companies USING btree (company_entity_id);


--
-- Name: customer_deal_companies_deal_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_deal_companies_deal_idx ON public.customer_deal_companies USING btree (deal_id);


--
-- Name: customer_deal_people_deal_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_deal_people_deal_idx ON public.customer_deal_people USING btree (deal_id);


--
-- Name: customer_deal_people_person_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_deal_people_person_idx ON public.customer_deal_people USING btree (person_entity_id);


--
-- Name: customer_deals_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_deals_org_tenant_idx ON public.customer_deals USING btree (organization_id, tenant_id);


--
-- Name: customer_dictionary_entries_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_dictionary_entries_scope_idx ON public.customer_dictionary_entries USING btree (organization_id, tenant_id, kind);


--
-- Name: customer_entities_org_email_hash_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX customer_entities_org_email_hash_uniq ON public.customer_entities USING btree (organization_id, primary_email_hash) WHERE ((primary_email_hash IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: customer_entities_org_email_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX customer_entities_org_email_uniq ON public.customer_entities USING btree (organization_id, lower(primary_email)) WHERE ((primary_email IS NOT NULL) AND (primary_email <> ''::text) AND (deleted_at IS NULL));


--
-- Name: customer_entities_org_phone_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_entities_org_phone_hash_idx ON public.customer_entities USING btree (organization_id, primary_phone_hash) WHERE (primary_phone_hash IS NOT NULL);


--
-- Name: customer_entities_org_tenant_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_entities_org_tenant_kind_idx ON public.customer_entities USING btree (organization_id, tenant_id, kind);


--
-- Name: customer_people_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_people_org_tenant_idx ON public.customer_people USING btree (organization_id, tenant_id);


--
-- Name: customer_pipeline_automation_rules_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_pipeline_automation_rules_org_tenant_idx ON public.customer_pipeline_automation_rules USING btree (organization_id, tenant_id);


--
-- Name: customer_pipeline_automation_rules_trigger_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_pipeline_automation_rules_trigger_active_idx ON public.customer_pipeline_automation_rules USING btree (trigger_key) WHERE ((is_active = true) AND (deleted_at IS NULL));


--
-- Name: customer_pipeline_automation_runs_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_pipeline_automation_runs_entity_idx ON public.customer_pipeline_automation_runs USING btree (entity_type, entity_id, ran_at);


--
-- Name: customer_pipeline_automation_runs_idempotency_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_pipeline_automation_runs_idempotency_idx ON public.customer_pipeline_automation_runs USING btree (rule_id, entity_id, trigger_event_id);


--
-- Name: customer_pipeline_automation_runs_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_pipeline_automation_runs_org_tenant_idx ON public.customer_pipeline_automation_runs USING btree (organization_id, tenant_id);


--
-- Name: customer_pipeline_stages_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_pipeline_stages_org_tenant_idx ON public.customer_pipeline_stages USING btree (organization_id, tenant_id);


--
-- Name: customer_pipeline_stages_pipeline_position_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_pipeline_stages_pipeline_position_idx ON public.customer_pipeline_stages USING btree (pipeline_id, "position");


--
-- Name: customer_pipelines_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_pipelines_org_tenant_idx ON public.customer_pipelines USING btree (organization_id, tenant_id);


--
-- Name: customer_service_knowledge_org_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_service_knowledge_org_active_idx ON public.customer_service_knowledge USING btree (organization_id, is_active);


--
-- Name: customer_tag_assignments_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_tag_assignments_entity_idx ON public.customer_tag_assignments USING btree (entity_id);


--
-- Name: customer_tags_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_tags_org_tenant_idx ON public.customer_tags USING btree (organization_id, tenant_id);


--
-- Name: customer_todo_links_entity_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_todo_links_entity_created_idx ON public.customer_todo_links USING btree (entity_id, created_at);


--
-- Name: customer_todo_links_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_todo_links_entity_idx ON public.customer_todo_links USING btree (entity_id);


--
-- Name: customer_user_email_verifications_token_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_user_email_verifications_token_idx ON public.customer_user_email_verifications USING btree (token);


--
-- Name: customer_user_invitations_tenant_email_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_user_invitations_tenant_email_hash_idx ON public.customer_user_invitations USING btree (tenant_id, email_hash);


--
-- Name: customer_user_invitations_token_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_user_invitations_token_idx ON public.customer_user_invitations USING btree (token);


--
-- Name: customer_user_password_resets_token_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_user_password_resets_token_idx ON public.customer_user_password_resets USING btree (token);


--
-- Name: customer_user_sessions_token_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_user_sessions_token_hash_idx ON public.customer_user_sessions USING btree (token_hash);


--
-- Name: customer_users_customer_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_users_customer_entity_idx ON public.customer_users USING btree (customer_entity_id);


--
-- Name: customer_users_email_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_users_email_hash_idx ON public.customer_users USING btree (email_hash);


--
-- Name: customer_users_person_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_users_person_entity_idx ON public.customer_users USING btree (person_entity_id);


--
-- Name: dictionary_entries_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dictionary_entries_scope_idx ON public.dictionary_entries USING btree (dictionary_id, organization_id, tenant_id);


--
-- Name: email_campaign_recipients_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_campaign_recipients_idx ON public.email_campaign_recipients USING btree (campaign_id, contact_id);


--
-- Name: email_conn_org_user_provider_purpose_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX email_conn_org_user_provider_purpose_idx ON public.email_connections USING btree (organization_id, user_id, provider, purpose);


--
-- Name: email_list_members_list_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_list_members_list_idx ON public.email_list_members USING btree (list_id);


--
-- Name: email_lists_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_lists_org_idx ON public.email_lists USING btree (organization_id);


--
-- Name: email_messages_org_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_messages_org_contact_idx ON public.email_messages USING btree (organization_id, contact_id);


--
-- Name: email_messages_org_tenant_account_direction_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_messages_org_tenant_account_direction_created_idx ON public.email_messages USING btree (organization_id, tenant_id, account_id, direction, created_at);


--
-- Name: email_messages_org_tenant_direction_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_messages_org_tenant_direction_created_idx ON public.email_messages USING btree (organization_id, tenant_id, direction, created_at);


--
-- Name: email_messages_tracking_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_messages_tracking_idx ON public.email_messages USING btree (tracking_id);


--
-- Name: email_pref_contact_cat_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX email_pref_contact_cat_idx ON public.email_preferences USING btree (contact_id, organization_id, category_slug);


--
-- Name: email_routing_org_purpose_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX email_routing_org_purpose_idx ON public.email_routing USING btree (organization_id, purpose);


--
-- Name: email_templates_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_templates_org_idx ON public.email_style_templates USING btree (organization_id, category);


--
-- Name: email_unsubscribes_org_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_unsubscribes_org_email_idx ON public.email_unsubscribes USING btree (organization_id, email);


--
-- Name: encryption_maps_entity_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX encryption_maps_entity_scope_idx ON public.encryption_maps USING btree (entity_id, tenant_id, organization_id);


--
-- Name: engagement_events_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX engagement_events_contact_idx ON public.engagement_events USING btree (contact_id, created_at DESC);


--
-- Name: engagement_scores_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX engagement_scores_contact_idx ON public.contact_engagement_scores USING btree (contact_id);


--
-- Name: engagement_scores_org_score_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX engagement_scores_org_score_idx ON public.contact_engagement_scores USING btree (organization_id, score DESC);


--
-- Name: enrollments_course_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX enrollments_course_idx ON public.course_enrollments USING btree (course_id, status);


--
-- Name: enrollments_org_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX enrollments_org_status_idx ON public.sequence_enrollments USING btree (organization_id, status);


--
-- Name: enrollments_seq_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX enrollments_seq_contact_idx ON public.sequence_enrollments USING btree (sequence_id, contact_id) WHERE (status = 'active'::text);


--
-- Name: entity_index_jobs_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_index_jobs_org_idx ON public.entity_index_jobs USING btree (organization_id);


--
-- Name: entity_index_jobs_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_index_jobs_type_idx ON public.entity_index_jobs USING btree (entity_type);


--
-- Name: entity_indexes_customer_company_profile_doc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_indexes_customer_company_profile_doc_idx ON public.entity_indexes USING btree (entity_id, organization_id, tenant_id) INCLUDE (doc) WHERE ((deleted_at IS NULL) AND (entity_type = 'customers:customer_company_profile'::text) AND (organization_id IS NOT NULL) AND (tenant_id IS NOT NULL));


--
-- Name: entity_indexes_customer_company_profile_tenant_doc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_indexes_customer_company_profile_tenant_doc_idx ON public.entity_indexes USING btree (tenant_id, entity_id) INCLUDE (doc) WHERE ((deleted_at IS NULL) AND (entity_type = 'customers:customer_company_profile'::text) AND (organization_id IS NULL) AND (tenant_id IS NOT NULL));


--
-- Name: entity_indexes_customer_entity_doc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_indexes_customer_entity_doc_idx ON public.entity_indexes USING btree (entity_id, organization_id, tenant_id) INCLUDE (doc) WHERE ((deleted_at IS NULL) AND (entity_type = 'customers:customer_entity'::text) AND (organization_id IS NOT NULL) AND (tenant_id IS NOT NULL));


--
-- Name: entity_indexes_customer_entity_tenant_doc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_indexes_customer_entity_tenant_doc_idx ON public.entity_indexes USING btree (tenant_id, entity_id) INCLUDE (doc) WHERE ((deleted_at IS NULL) AND (entity_type = 'customers:customer_entity'::text) AND (organization_id IS NULL) AND (tenant_id IS NOT NULL));


--
-- Name: entity_indexes_customer_person_profile_doc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_indexes_customer_person_profile_doc_idx ON public.entity_indexes USING btree (entity_id, organization_id, tenant_id) INCLUDE (doc) WHERE ((deleted_at IS NULL) AND (entity_type = 'customers:customer_person_profile'::text) AND (organization_id IS NOT NULL) AND (tenant_id IS NOT NULL));


--
-- Name: entity_indexes_customer_person_profile_tenant_doc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_indexes_customer_person_profile_tenant_doc_idx ON public.entity_indexes USING btree (tenant_id, entity_id) INCLUDE (doc) WHERE ((deleted_at IS NULL) AND (entity_type = 'customers:customer_person_profile'::text) AND (organization_id IS NULL) AND (tenant_id IS NOT NULL));


--
-- Name: entity_indexes_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_indexes_entity_idx ON public.entity_indexes USING btree (entity_id);


--
-- Name: entity_indexes_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_indexes_org_idx ON public.entity_indexes USING btree (organization_id);


--
-- Name: entity_indexes_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_indexes_type_idx ON public.entity_indexes USING btree (entity_type);


--
-- Name: entity_indexes_type_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_indexes_type_tenant_idx ON public.entity_indexes USING btree (entity_type, tenant_id);


--
-- Name: esp_conn_org_provider_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX esp_conn_org_provider_idx ON public.esp_connections USING btree (organization_id, provider);


--
-- Name: esp_sender_addr_org_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX esp_sender_addr_org_email_idx ON public.esp_sender_addresses USING btree (organization_id, sender_email);


--
-- Name: exchange_rates_pair_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX exchange_rates_pair_idx ON public.exchange_rates USING btree (from_currency_code, to_currency_code, date);


--
-- Name: exchange_rates_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX exchange_rates_scope_idx ON public.exchange_rates USING btree (organization_id, tenant_id);


--
-- Name: feature_toggle_audit_action_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX feature_toggle_audit_action_idx ON public.feature_toggle_audit_logs USING btree (action, created_at);


--
-- Name: feature_toggle_audit_actor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX feature_toggle_audit_actor_idx ON public.feature_toggle_audit_logs USING btree (actor_user_id, created_at);


--
-- Name: feature_toggle_audit_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX feature_toggle_audit_org_idx ON public.feature_toggle_audit_logs USING btree (organization_id, created_at);


--
-- Name: feature_toggle_audit_toggle_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX feature_toggle_audit_toggle_idx ON public.feature_toggle_audit_logs USING btree (toggle_id, created_at);


--
-- Name: feature_toggle_overrides_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX feature_toggle_overrides_tenant_idx ON public.feature_toggle_overrides USING btree (tenant_id);


--
-- Name: feature_toggle_overrides_toggle_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX feature_toggle_overrides_toggle_idx ON public.feature_toggle_overrides USING btree (toggle_id);


--
-- Name: feature_toggles_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX feature_toggles_category_idx ON public.feature_toggles USING btree (category);


--
-- Name: feature_toggles_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX feature_toggles_name_idx ON public.feature_toggles USING btree (name);


--
-- Name: form_submissions_org_page_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX form_submissions_org_page_idx ON public.form_submissions USING btree (organization_id, landing_page_id);


--
-- Name: forms_org_slug_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX forms_org_slug_idx ON public.forms USING btree (organization_id, slug);


--
-- Name: forms_org_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX forms_org_status_idx ON public.forms USING btree (organization_id, status);


--
-- Name: funnel_orders_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX funnel_orders_session_idx ON public.funnel_orders USING btree (session_id);


--
-- Name: funnel_sessions_funnel_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX funnel_sessions_funnel_idx ON public.funnel_sessions USING btree (funnel_id, started_at DESC);


--
-- Name: funnel_sessions_visitor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX funnel_sessions_visitor_idx ON public.funnel_sessions USING btree (visitor_id);


--
-- Name: funnel_steps_funnel_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX funnel_steps_funnel_idx ON public.funnel_steps USING btree (funnel_id, step_order);


--
-- Name: funnel_visits_funnel_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX funnel_visits_funnel_idx ON public.funnel_visits USING btree (funnel_id, created_at DESC);


--
-- Name: funnel_visits_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX funnel_visits_session_idx ON public.funnel_visits USING btree (session_id);


--
-- Name: funnels_org_slug_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX funnels_org_slug_idx ON public.funnels USING btree (organization_id, slug);


--
-- Name: gateway_transactions_organization_id_tenant_id_uni_5a9b9_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gateway_transactions_organization_id_tenant_id_uni_5a9b9_index ON public.gateway_transactions USING btree (organization_id, tenant_id, unified_status);


--
-- Name: gateway_transactions_payment_id_organization_id_tenant_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gateway_transactions_payment_id_organization_id_tenant_id_index ON public.gateway_transactions USING btree (payment_id, organization_id, tenant_id);


--
-- Name: gateway_transactions_provider_key_provider_session_d8577_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gateway_transactions_provider_key_provider_session_d8577_index ON public.gateway_transactions USING btree (provider_key, provider_session_id, organization_id);


--
-- Name: gateway_webhook_events_idempotency_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gateway_webhook_events_idempotency_unique ON public.gateway_webhook_events USING btree (idempotency_key, provider_key, organization_id, tenant_id);


--
-- Name: google_cal_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX google_cal_user_idx ON public.google_calendar_connections USING btree (user_id);


--
-- Name: gtm_ai_telemetry_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_ai_telemetry_org_tenant_idx ON public.gtm_ai_telemetry USING btree (organization_id, tenant_id);


--
-- Name: gtm_ai_telemetry_org_tenant_surface_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_ai_telemetry_org_tenant_surface_idx ON public.gtm_ai_telemetry USING btree (organization_id, tenant_id, surface, created_at);


--
-- Name: gtm_audit_events_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_audit_events_org_tenant_idx ON public.gtm_audit_events USING btree (organization_id, tenant_id);


--
-- Name: gtm_audit_events_org_tenant_object_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_audit_events_org_tenant_object_idx ON public.gtm_audit_events USING btree (organization_id, tenant_id, object_type, object_id);


--
-- Name: gtm_auto_refill_cycles_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_auto_refill_cycles_org_tenant_idx ON public.gtm_auto_refill_cycles USING btree (organization_id, tenant_id);


--
-- Name: gtm_auto_refill_cycles_policy_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_auto_refill_cycles_policy_status_idx ON public.gtm_auto_refill_cycles USING btree (policy_id, status);


--
-- Name: gtm_auto_refill_policies_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_auto_refill_policies_org_tenant_idx ON public.gtm_auto_refill_policies USING btree (organization_id, tenant_id);


--
-- Name: gtm_auto_refill_policies_org_tenant_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_auto_refill_policies_org_tenant_status_idx ON public.gtm_auto_refill_policies USING btree (organization_id, tenant_id, status);


--
-- Name: gtm_campaign_versions_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_campaign_versions_org_tenant_idx ON public.gtm_campaign_versions USING btree (organization_id, tenant_id);


--
-- Name: gtm_campaigns_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_campaigns_org_tenant_idx ON public.gtm_campaigns USING btree (organization_id, tenant_id);


--
-- Name: gtm_candidate_matches_org_tenant_candidate_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_candidate_matches_org_tenant_candidate_idx ON public.gtm_candidate_matches USING btree (organization_id, tenant_id, candidate_id);


--
-- Name: gtm_candidate_matches_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_candidate_matches_org_tenant_idx ON public.gtm_candidate_matches USING btree (organization_id, tenant_id);


--
-- Name: gtm_candidate_matches_org_tenant_play_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_candidate_matches_org_tenant_play_idx ON public.gtm_candidate_matches USING btree (organization_id, tenant_id, play_id);


--
-- Name: gtm_candidate_matches_org_tenant_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_candidate_matches_org_tenant_run_idx ON public.gtm_candidate_matches USING btree (organization_id, tenant_id, research_run_id);


--
-- Name: gtm_candidate_relations_org_tenant_child_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_candidate_relations_org_tenant_child_idx ON public.gtm_candidate_relations USING btree (organization_id, tenant_id, child_candidate_id);


--
-- Name: gtm_candidate_relations_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_candidate_relations_org_tenant_idx ON public.gtm_candidate_relations USING btree (organization_id, tenant_id);


--
-- Name: gtm_candidate_relations_org_tenant_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_candidate_relations_org_tenant_parent_idx ON public.gtm_candidate_relations USING btree (organization_id, tenant_id, parent_candidate_id);


--
-- Name: gtm_candidate_relations_org_tenant_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_candidate_relations_org_tenant_run_idx ON public.gtm_candidate_relations USING btree (organization_id, tenant_id, research_run_id);


--
-- Name: gtm_candidates_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_candidates_org_tenant_idx ON public.gtm_candidates USING btree (organization_id, tenant_id);


--
-- Name: gtm_candidates_org_tenant_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_candidates_org_tenant_run_idx ON public.gtm_candidates USING btree (organization_id, tenant_id, research_run_id);


--
-- Name: gtm_chat_messages_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_chat_messages_org_tenant_idx ON public.gtm_chat_messages USING btree (organization_id, tenant_id);


--
-- Name: gtm_chat_messages_org_tenant_thread_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_chat_messages_org_tenant_thread_idx ON public.gtm_chat_messages USING btree (organization_id, tenant_id, thread_id);


--
-- Name: gtm_chat_threads_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_chat_threads_org_tenant_idx ON public.gtm_chat_threads USING btree (organization_id, tenant_id);


--
-- Name: gtm_chat_threads_org_tenant_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_chat_threads_org_tenant_workspace_idx ON public.gtm_chat_threads USING btree (organization_id, tenant_id, workspace_id);


--
-- Name: gtm_contact_points_org_tenant_candidate_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_contact_points_org_tenant_candidate_idx ON public.gtm_contact_points USING btree (organization_id, tenant_id, candidate_id);


--
-- Name: gtm_contact_points_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_contact_points_org_tenant_idx ON public.gtm_contact_points USING btree (organization_id, tenant_id);


--
-- Name: gtm_deletion_requests_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_deletion_requests_org_tenant_idx ON public.gtm_deletion_requests USING btree (organization_id, tenant_id);


--
-- Name: gtm_dsr_operations_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_dsr_operations_org_tenant_idx ON public.gtm_dsr_operations USING btree (organization_id, tenant_id);


--
-- Name: gtm_enrollments_org_tenant_campaign_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_enrollments_org_tenant_campaign_idx ON public.gtm_enrollments USING btree (organization_id, tenant_id, campaign_id);


--
-- Name: gtm_enrollments_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_enrollments_org_tenant_idx ON public.gtm_enrollments USING btree (organization_id, tenant_id);


--
-- Name: gtm_evidence_org_tenant_candidate_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_evidence_org_tenant_candidate_idx ON public.gtm_evidence USING btree (organization_id, tenant_id, candidate_id);


--
-- Name: gtm_evidence_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_evidence_org_tenant_idx ON public.gtm_evidence USING btree (organization_id, tenant_id);


--
-- Name: gtm_evidence_org_tenant_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_evidence_org_tenant_run_idx ON public.gtm_evidence USING btree (organization_id, tenant_id, research_run_id);


--
-- Name: gtm_icp_versions_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_icp_versions_org_tenant_idx ON public.gtm_icp_versions USING btree (organization_id, tenant_id);


--
-- Name: gtm_inbound_events_attempt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_inbound_events_attempt_idx ON public.gtm_inbound_events USING btree (organization_id, tenant_id, send_attempt_id);


--
-- Name: gtm_inbound_events_org_tenant_enrollment_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_inbound_events_org_tenant_enrollment_idx ON public.gtm_inbound_events USING btree (organization_id, tenant_id, enrollment_id);


--
-- Name: gtm_inbound_events_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_inbound_events_org_tenant_idx ON public.gtm_inbound_events USING btree (organization_id, tenant_id);


--
-- Name: gtm_inbound_events_org_tenant_mailbox_occurred_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_inbound_events_org_tenant_mailbox_occurred_idx ON public.gtm_inbound_events USING btree (organization_id, tenant_id, mailbox_connection_id, occurred_at);


--
-- Name: gtm_mailbox_cursors_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_mailbox_cursors_org_tenant_idx ON public.gtm_mailbox_cursors USING btree (organization_id, tenant_id);


--
-- Name: gtm_mailbox_health_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_mailbox_health_org_tenant_idx ON public.gtm_mailbox_health USING btree (organization_id, tenant_id);


--
-- Name: gtm_mailbox_policies_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_mailbox_policies_org_tenant_idx ON public.gtm_mailbox_policies USING btree (organization_id, tenant_id);


--
-- Name: gtm_manual_outreach_drafts_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_manual_outreach_drafts_org_tenant_idx ON public.gtm_manual_outreach_drafts USING btree (organization_id, tenant_id);


--
-- Name: gtm_manual_outreach_drafts_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_manual_outreach_drafts_scope_idx ON public.gtm_manual_outreach_drafts USING btree (organization_id, tenant_id, workspace_id, play_id, candidate_id);


--
-- Name: gtm_plays_org_report_play_key_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX gtm_plays_org_report_play_key_unique ON public.gtm_plays USING btree (organization_id, imported_report_token_hash, imported_play_key) WHERE ((imported_report_token_hash IS NOT NULL) AND (imported_play_key IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: gtm_plays_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_plays_org_tenant_idx ON public.gtm_plays USING btree (organization_id, tenant_id);


--
-- Name: gtm_plays_org_tenant_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_plays_org_tenant_workspace_idx ON public.gtm_plays USING btree (organization_id, tenant_id, workspace_id);


--
-- Name: gtm_provider_operations_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_provider_operations_org_tenant_idx ON public.gtm_provider_operations USING btree (organization_id, tenant_id);


--
-- Name: gtm_provider_operations_research_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_provider_operations_research_run_idx ON public.gtm_provider_operations USING btree (research_run_id);


--
-- Name: gtm_provider_reconciliation_actions_operation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_provider_reconciliation_actions_operation_idx ON public.gtm_provider_reconciliation_actions USING btree (organization_id, tenant_id, provider_operation_id);


--
-- Name: gtm_provider_reconciliation_actions_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_provider_reconciliation_actions_org_tenant_idx ON public.gtm_provider_reconciliation_actions USING btree (organization_id, tenant_id);


--
-- Name: gtm_rendered_messages_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_rendered_messages_org_tenant_idx ON public.gtm_rendered_messages USING btree (organization_id, tenant_id);


--
-- Name: gtm_replies_org_tenant_enrollment_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_replies_org_tenant_enrollment_idx ON public.gtm_replies USING btree (organization_id, tenant_id, enrollment_id);


--
-- Name: gtm_replies_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_replies_org_tenant_idx ON public.gtm_replies USING btree (organization_id, tenant_id);


--
-- Name: gtm_research_runs_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_research_runs_org_tenant_idx ON public.gtm_research_runs USING btree (organization_id, tenant_id);


--
-- Name: gtm_send_attempts_mailbox_capacity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_send_attempts_mailbox_capacity_idx ON public.gtm_send_attempts USING btree (organization_id, tenant_id, mailbox_connection_id, state, scheduled_for);


--
-- Name: gtm_send_attempts_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_send_attempts_org_tenant_idx ON public.gtm_send_attempts USING btree (organization_id, tenant_id);


--
-- Name: gtm_send_attempts_org_tenant_kind_state_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_send_attempts_org_tenant_kind_state_due_idx ON public.gtm_send_attempts USING btree (organization_id, tenant_id, kind, state, scheduled_for);


--
-- Name: gtm_send_attempts_org_tenant_state_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_send_attempts_org_tenant_state_due_idx ON public.gtm_send_attempts USING btree (organization_id, tenant_id, state, scheduled_for);


--
-- Name: gtm_send_attempts_rfc_message_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_send_attempts_rfc_message_id_idx ON public.gtm_send_attempts USING btree (rfc_message_id);


--
-- Name: gtm_social_connections_org_tenant_provider_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_social_connections_org_tenant_provider_idx ON public.gtm_social_connections USING btree (organization_id, tenant_id, provider);


--
-- Name: gtm_steps_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_steps_org_tenant_idx ON public.gtm_steps USING btree (organization_id, tenant_id);


--
-- Name: gtm_steps_org_tenant_version_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_steps_org_tenant_version_idx ON public.gtm_steps USING btree (organization_id, tenant_id, campaign_version_id);


--
-- Name: gtm_suppressions_global_channel_address_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX gtm_suppressions_global_channel_address_unique ON public.gtm_suppressions USING btree (channel, address_hash) WHERE (scope = 'global'::text);


--
-- Name: gtm_suppressions_org_address_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_suppressions_org_address_hash_idx ON public.gtm_suppressions USING btree (organization_id, address_hash);


--
-- Name: gtm_suppressions_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_suppressions_org_tenant_idx ON public.gtm_suppressions USING btree (organization_id, tenant_id);


--
-- Name: gtm_voice_versions_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_voice_versions_org_tenant_idx ON public.gtm_voice_versions USING btree (organization_id, tenant_id);


--
-- Name: gtm_workspaces_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gtm_workspaces_org_tenant_idx ON public.gtm_workspaces USING btree (organization_id, tenant_id);


--
-- Name: idx_ce_tenant_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ce_tenant_company_id ON public.customer_entities USING btree (tenant_id, id);


--
-- Name: idx_ce_tenant_org_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ce_tenant_org_company_id ON public.customer_entities USING btree (tenant_id, organization_id, id);


--
-- Name: idx_ce_tenant_org_person_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ce_tenant_org_person_id ON public.customer_entities USING btree (tenant_id, organization_id, id);


--
-- Name: idx_ce_tenant_person_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ce_tenant_person_id ON public.customer_entities USING btree (tenant_id, id);


--
-- Name: idx_customer_companies_entity_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customer_companies_entity_id ON public.customer_companies USING btree (entity_id);


--
-- Name: idx_customer_people_entity_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customer_people_entity_id ON public.customer_people USING btree (entity_id);


--
-- Name: inbox_audiences_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inbox_audiences_org_idx ON public.inbox_audiences USING btree (organization_id);


--
-- Name: inbox_conv_chat_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inbox_conv_chat_idx ON public.inbox_conversations USING btree (chat_conversation_id) WHERE (chat_conversation_id IS NOT NULL);


--
-- Name: inbox_conv_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inbox_conv_contact_idx ON public.inbox_conversations USING btree (contact_id) WHERE (contact_id IS NOT NULL);


--
-- Name: inbox_conv_org_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inbox_conv_org_status_idx ON public.inbox_conversations USING btree (organization_id, status, last_message_at DESC);


--
-- Name: inbox_conversations_org_contact_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX inbox_conversations_org_contact_uniq ON public.inbox_conversations USING btree (organization_id, contact_id) WHERE (contact_id IS NOT NULL);


--
-- Name: inbox_discrepancies_organization_id_tenant_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inbox_discrepancies_organization_id_tenant_id_index ON public.inbox_discrepancies USING btree (organization_id, tenant_id);


--
-- Name: inbox_discrepancies_proposal_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inbox_discrepancies_proposal_id_index ON public.inbox_discrepancies USING btree (proposal_id);


--
-- Name: inbox_emails_organization_id_tenant_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inbox_emails_organization_id_tenant_id_index ON public.inbox_emails USING btree (organization_id, tenant_id);


--
-- Name: inbox_emails_organization_id_tenant_id_received_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inbox_emails_organization_id_tenant_id_received_at_index ON public.inbox_emails USING btree (organization_id, tenant_id, received_at);


--
-- Name: inbox_emails_organization_id_tenant_id_status_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inbox_emails_organization_id_tenant_id_status_index ON public.inbox_emails USING btree (organization_id, tenant_id, status);


--
-- Name: inbox_knowledge_org_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inbox_knowledge_org_active_idx ON public.inbox_knowledge USING btree (organization_id, is_active);


--
-- Name: inbox_notes_conv_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inbox_notes_conv_idx ON public.inbox_notes USING btree (inbox_conversation_id, created_at);


--
-- Name: inbox_proposal_actions_organization_id_tenant_id_status_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inbox_proposal_actions_organization_id_tenant_id_status_index ON public.inbox_proposal_actions USING btree (organization_id, tenant_id, status);


--
-- Name: inbox_proposal_actions_proposal_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inbox_proposal_actions_proposal_id_index ON public.inbox_proposal_actions USING btree (proposal_id);


--
-- Name: inbox_proposals_inbox_email_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inbox_proposals_inbox_email_id_index ON public.inbox_proposals USING btree (inbox_email_id);


--
-- Name: inbox_proposals_organization_id_tenant_id_category_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inbox_proposals_organization_id_tenant_id_category_index ON public.inbox_proposals USING btree (organization_id, tenant_id, category);


--
-- Name: inbox_proposals_organization_id_tenant_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inbox_proposals_organization_id_tenant_id_index ON public.inbox_proposals USING btree (organization_id, tenant_id);


--
-- Name: inbox_proposals_organization_id_tenant_id_status_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inbox_proposals_organization_id_tenant_id_status_index ON public.inbox_proposals USING btree (organization_id, tenant_id, status);


--
-- Name: inbox_settings_organization_id_tenant_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inbox_settings_organization_id_tenant_id_index ON public.inbox_settings USING btree (organization_id, tenant_id);


--
-- Name: indexer_error_logs_occurred_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX indexer_error_logs_occurred_idx ON public.indexer_error_logs USING btree (occurred_at);


--
-- Name: indexer_error_logs_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX indexer_error_logs_source_idx ON public.indexer_error_logs USING btree (source);


--
-- Name: indexer_status_logs_occurred_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX indexer_status_logs_occurred_idx ON public.indexer_status_logs USING btree (occurred_at);


--
-- Name: indexer_status_logs_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX indexer_status_logs_source_idx ON public.indexer_status_logs USING btree (source);


--
-- Name: integrations_api_ams_commands_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX integrations_api_ams_commands_org_tenant_idx ON public.integrations_api_ams_commands USING btree (organization_id, tenant_id);


--
-- Name: integrations_api_ams_events_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX integrations_api_ams_events_org_tenant_idx ON public.integrations_api_ams_events USING btree (organization_id, tenant_id);


--
-- Name: integrations_api_consent_versions_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX integrations_api_consent_versions_org_tenant_idx ON public.integrations_api_consent_versions USING btree (organization_id, tenant_id);


--
-- Name: integrations_api_suppression_versions_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX integrations_api_suppression_versions_org_tenant_idx ON public.integrations_api_suppression_versions USING btree (organization_id, tenant_id);


--
-- Name: invoices_org_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invoices_org_status_idx ON public.invoices USING btree (organization_id, status);


--
-- Name: landing_page_daily_stats_page_variant_day_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX landing_page_daily_stats_page_variant_day_uq ON public.landing_page_daily_stats USING btree (landing_page_id, variant_id, day);


--
-- Name: landing_page_referrers_page_host_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX landing_page_referrers_page_host_uq ON public.landing_page_referrers USING btree (landing_page_id, host);


--
-- Name: landing_page_variants_page_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX landing_page_variants_page_idx ON public.landing_page_variants USING btree (landing_page_id);


--
-- Name: landing_pages_custom_domain_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX landing_pages_custom_domain_idx ON public.landing_pages USING btree (custom_domain) WHERE (custom_domain IS NOT NULL);


--
-- Name: landing_pages_custom_domain_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX landing_pages_custom_domain_uidx ON public.landing_pages USING btree (lower(custom_domain)) WHERE ((custom_domain IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: landing_pages_org_slug_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX landing_pages_org_slug_idx ON public.landing_pages USING btree (organization_id, slug);


--
-- Name: magic_tokens_token_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX magic_tokens_token_idx ON public.course_magic_tokens USING btree (token);


--
-- Name: meeting_prep_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX meeting_prep_idx ON public.meeting_prep_briefs USING btree (organization_id, event_start DESC);


--
-- Name: message_access_tokens_message_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_access_tokens_message_idx ON public.message_access_tokens USING btree (message_id);


--
-- Name: message_access_tokens_token_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_access_tokens_token_idx ON public.message_access_tokens USING btree (token);


--
-- Name: message_confirmations_message_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_confirmations_message_idx ON public.message_confirmations USING btree (message_id);


--
-- Name: message_confirmations_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_confirmations_scope_idx ON public.message_confirmations USING btree (tenant_id, organization_id);


--
-- Name: message_objects_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_objects_entity_idx ON public.message_objects USING btree (entity_type, entity_id);


--
-- Name: message_objects_message_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_objects_message_idx ON public.message_objects USING btree (message_id);


--
-- Name: message_recipients_message_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_recipients_message_idx ON public.message_recipients USING btree (message_id);


--
-- Name: message_recipients_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_recipients_user_idx ON public.message_recipients USING btree (recipient_user_id, status);


--
-- Name: messages_sender_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_sender_idx ON public.messages USING btree (sender_user_id, sent_at);


--
-- Name: messages_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_tenant_idx ON public.messages USING btree (tenant_id, organization_id);


--
-- Name: messages_thread_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_thread_idx ON public.messages USING btree (thread_id);


--
-- Name: messages_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_type_idx ON public.messages USING btree (type, tenant_id);


--
-- Name: module_configs_module_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX module_configs_module_idx ON public.module_configs USING btree (module_id);


--
-- Name: notifications_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_expires_idx ON public.notifications USING btree (expires_at) WHERE ((expires_at IS NOT NULL) AND (status <> ALL (ARRAY['actioned'::text, 'dismissed'::text])));


--
-- Name: notifications_group_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_group_idx ON public.notifications USING btree (group_key, recipient_user_id) WHERE (group_key IS NOT NULL);


--
-- Name: notifications_recipient_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_recipient_status_idx ON public.notifications USING btree (recipient_user_id, status, created_at DESC);


--
-- Name: notifications_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_source_idx ON public.notifications USING btree (source_entity_type, source_entity_id) WHERE (source_entity_id IS NOT NULL);


--
-- Name: notifications_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_tenant_idx ON public.notifications USING btree (tenant_id, organization_id);


--
-- Name: open_times_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX open_times_contact_idx ON public.contact_open_times USING btree (contact_id);


--
-- Name: organizations_noli_org_id_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX organizations_noli_org_id_uniq ON public.organizations USING btree (noli_org_id);


--
-- Name: payment_records_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_records_org_idx ON public.payment_records USING btree (organization_id, created_at);


--
-- Name: payment_records_org_session_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX payment_records_org_session_uniq ON public.payment_records USING btree (organization_id, stripe_checkout_session_id) WHERE (stripe_checkout_session_id IS NOT NULL);


--
-- Name: payouts_affiliate_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payouts_affiliate_idx ON public.affiliate_payouts USING btree (affiliate_id, created_at DESC);


--
-- Name: planner_availability_rule_sets_tenant_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX planner_availability_rule_sets_tenant_org_idx ON public.planner_availability_rule_sets USING btree (tenant_id, organization_id);


--
-- Name: planner_availability_rules_subject_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX planner_availability_rules_subject_idx ON public.planner_availability_rules USING btree (subject_type, subject_id, tenant_id, organization_id);


--
-- Name: planner_availability_rules_tenant_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX planner_availability_rules_tenant_org_idx ON public.planner_availability_rules USING btree (tenant_id, organization_id);


--
-- Name: pref_cat_org_slug_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pref_cat_org_slug_idx ON public.email_preference_categories USING btree (organization_id, slug);


--
-- Name: progress_jobs_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX progress_jobs_parent_idx ON public.progress_jobs USING btree (parent_job_id);


--
-- Name: progress_jobs_status_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX progress_jobs_status_tenant_idx ON public.progress_jobs USING btree (status, tenant_id);


--
-- Name: progress_jobs_type_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX progress_jobs_type_tenant_idx ON public.progress_jobs USING btree (job_type, tenant_id);


--
-- Name: referrals_affiliate_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX referrals_affiliate_idx ON public.affiliate_referrals USING btree (affiliate_id, referred_at DESC);


--
-- Name: reminders_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reminders_due_idx ON public.reminders USING btree (remind_at, sent) WHERE (sent = false);


--
-- Name: reminders_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reminders_org_idx ON public.reminders USING btree (organization_id, user_id);


--
-- Name: response_templates_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX response_templates_org_idx ON public.response_templates USING btree (organization_id, category);


--
-- Name: review_requests_org_sent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX review_requests_org_sent_idx ON public.review_requests USING btree (organization_id, sent_at DESC);


--
-- Name: scheduled_jobs_next_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scheduled_jobs_next_run_idx ON public.scheduled_jobs USING btree (next_run_at);


--
-- Name: scheduled_jobs_org_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scheduled_jobs_org_tenant_idx ON public.scheduled_jobs USING btree (organization_id, tenant_id);


--
-- Name: scheduled_jobs_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scheduled_jobs_scope_idx ON public.scheduled_jobs USING btree (scope_type, is_enabled);


--
-- Name: search_tokens_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX search_tokens_entity_idx ON public.search_tokens USING btree (entity_type, entity_id);


--
-- Name: search_tokens_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX search_tokens_lookup_idx ON public.search_tokens USING btree (entity_type, field, token_hash, tenant_id, organization_id);


--
-- Name: sequence_steps_seq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sequence_steps_seq_idx ON public.sequence_steps USING btree (sequence_id, step_order);


--
-- Name: sequences_org_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sequences_org_status_idx ON public.sequences USING btree (organization_id, status);


--
-- Name: sms_messages_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sms_messages_contact_idx ON public.sms_messages USING btree (contact_id, created_at);


--
-- Name: staff_leave_requests_member_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_leave_requests_member_idx ON public.staff_leave_requests USING btree (member_id);


--
-- Name: staff_leave_requests_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_leave_requests_status_idx ON public.staff_leave_requests USING btree (status, tenant_id, organization_id);


--
-- Name: staff_leave_requests_tenant_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_leave_requests_tenant_org_idx ON public.staff_leave_requests USING btree (tenant_id, organization_id);


--
-- Name: staff_team_member_activities_member_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_team_member_activities_member_idx ON public.staff_team_member_activities USING btree (member_id);


--
-- Name: staff_team_member_activities_member_occurred_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_team_member_activities_member_occurred_created_idx ON public.staff_team_member_activities USING btree (member_id, occurred_at, created_at);


--
-- Name: staff_team_member_activities_tenant_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_team_member_activities_tenant_org_idx ON public.staff_team_member_activities USING btree (tenant_id, organization_id);


--
-- Name: staff_team_member_addresses_member_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_team_member_addresses_member_idx ON public.staff_team_member_addresses USING btree (member_id);


--
-- Name: staff_team_member_addresses_tenant_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_team_member_addresses_tenant_org_idx ON public.staff_team_member_addresses USING btree (tenant_id, organization_id);


--
-- Name: staff_team_member_comments_member_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_team_member_comments_member_idx ON public.staff_team_member_comments USING btree (member_id);


--
-- Name: staff_team_member_comments_tenant_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_team_member_comments_tenant_org_idx ON public.staff_team_member_comments USING btree (tenant_id, organization_id);


--
-- Name: staff_team_member_job_histories_member_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_team_member_job_histories_member_idx ON public.staff_team_member_job_histories USING btree (member_id);


--
-- Name: staff_team_member_job_histories_member_start_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_team_member_job_histories_member_start_idx ON public.staff_team_member_job_histories USING btree (member_id, start_date);


--
-- Name: staff_team_member_job_histories_tenant_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_team_member_job_histories_tenant_org_idx ON public.staff_team_member_job_histories USING btree (tenant_id, organization_id);


--
-- Name: staff_team_members_tenant_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_team_members_tenant_org_idx ON public.staff_team_members USING btree (tenant_id, organization_id);


--
-- Name: staff_team_roles_tenant_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_team_roles_tenant_org_idx ON public.staff_team_roles USING btree (tenant_id, organization_id);


--
-- Name: staff_teams_tenant_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_teams_tenant_org_idx ON public.staff_teams USING btree (tenant_id, organization_id);


--
-- Name: step_exec_scheduled_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX step_exec_scheduled_idx ON public.sequence_step_executions USING btree (status, scheduled_for) WHERE (status = 'scheduled'::text);


--
-- Name: step_instances_step_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX step_instances_step_id_idx ON public.step_instances USING btree (step_id, status);


--
-- Name: step_instances_tenant_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX step_instances_tenant_org_idx ON public.step_instances USING btree (tenant_id, organization_id);


--
-- Name: step_instances_workflow_instance_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX step_instances_workflow_instance_idx ON public.step_instances USING btree (workflow_instance_id, status);


--
-- Name: stripe_conn_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX stripe_conn_org_idx ON public.stripe_connections USING btree (organization_id);


--
-- Name: student_sessions_token_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX student_sessions_token_idx ON public.course_student_sessions USING btree (session_token);


--
-- Name: survey_responses_survey_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX survey_responses_survey_idx ON public.survey_responses USING btree (survey_id, created_at DESC);


--
-- Name: surveys_org_slug_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX surveys_org_slug_idx ON public.surveys USING btree (organization_id, slug);


--
-- Name: task_templates_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX task_templates_org_idx ON public.task_templates USING btree (organization_id);


--
-- Name: tasks_org_done_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_org_done_idx ON public.tasks USING btree (organization_id, is_done, due_date);


--
-- Name: team_invites_org_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_invites_org_status_idx ON public.team_invites USING btree (organization_id, status);


--
-- Name: team_invites_token_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX team_invites_token_unique ON public.team_invites USING btree (token);


--
-- Name: twilio_conn_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX twilio_conn_org_idx ON public.twilio_connections USING btree (organization_id);


--
-- Name: upgrade_action_runs_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX upgrade_action_runs_scope_idx ON public.upgrade_action_runs USING btree (organization_id, tenant_id);


--
-- Name: user_tasks_status_assigned_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_tasks_status_assigned_idx ON public.user_tasks USING btree (status, assigned_to);


--
-- Name: user_tasks_status_due_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_tasks_status_due_date_idx ON public.user_tasks USING btree (status, due_date);


--
-- Name: user_tasks_tenant_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_tasks_tenant_org_idx ON public.user_tasks USING btree (tenant_id, organization_id);


--
-- Name: user_tasks_workflow_instance_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_tasks_workflow_instance_idx ON public.user_tasks USING btree (workflow_instance_id);


--
-- Name: users_clerk_user_id_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_clerk_user_id_unique ON public.users USING btree (clerk_user_id) WHERE (clerk_user_id IS NOT NULL);


--
-- Name: users_email_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_email_hash_idx ON public.users USING btree (email_hash);


--
-- Name: users_google_sub_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_google_sub_unique ON public.users USING btree (google_sub) WHERE (google_sub IS NOT NULL);


--
-- Name: vector_search_embedding_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vector_search_embedding_idx ON public.vector_search USING ivfflat (embedding public.vector_cosine_ops) WITH (lists='100');


--
-- Name: vector_search_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vector_search_lookup ON public.vector_search USING btree (tenant_id, organization_id, entity_id);


--
-- Name: vector_search_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX vector_search_uniq ON public.vector_search USING btree (driver_id, entity_id, record_id, tenant_id);


--
-- Name: webhook_deliveries_sub_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX webhook_deliveries_sub_idx ON public.webhook_deliveries USING btree (subscription_id, created_at DESC);


--
-- Name: webhook_subs_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX webhook_subs_org_idx ON public.webhook_subscriptions USING btree (organization_id, event);


--
-- Name: workflow_definitions_enabled_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_definitions_enabled_idx ON public.workflow_definitions USING btree (enabled);


--
-- Name: workflow_definitions_tenant_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_definitions_tenant_org_idx ON public.workflow_definitions USING btree (tenant_id, organization_id);


--
-- Name: workflow_definitions_workflow_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_definitions_workflow_id_idx ON public.workflow_definitions USING btree (workflow_id);


--
-- Name: workflow_event_triggers_definition_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_event_triggers_definition_idx ON public.workflow_event_triggers USING btree (workflow_definition_id);


--
-- Name: workflow_event_triggers_enabled_priority_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_event_triggers_enabled_priority_idx ON public.workflow_event_triggers USING btree (enabled, priority);


--
-- Name: workflow_event_triggers_event_pattern_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_event_triggers_event_pattern_idx ON public.workflow_event_triggers USING btree (event_pattern, enabled);


--
-- Name: workflow_event_triggers_tenant_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_event_triggers_tenant_org_idx ON public.workflow_event_triggers USING btree (tenant_id, organization_id);


--
-- Name: workflow_events_event_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_events_event_type_idx ON public.workflow_events USING btree (event_type, occurred_at);


--
-- Name: workflow_events_instance_occurred_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_events_instance_occurred_idx ON public.workflow_events USING btree (workflow_instance_id, occurred_at);


--
-- Name: workflow_events_tenant_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_events_tenant_org_idx ON public.workflow_events USING btree (tenant_id, organization_id);


--
-- Name: workflow_instances_correlation_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_instances_correlation_key_idx ON public.workflow_instances USING btree (correlation_key);


--
-- Name: workflow_instances_current_step_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_instances_current_step_idx ON public.workflow_instances USING btree (current_step_id, status);


--
-- Name: workflow_instances_definition_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_instances_definition_status_idx ON public.workflow_instances USING btree (definition_id, status);


--
-- Name: workflow_instances_status_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_instances_status_tenant_idx ON public.workflow_instances USING btree (status, tenant_id);


--
-- Name: workflow_instances_tenant_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_instances_tenant_org_idx ON public.workflow_instances USING btree (tenant_id, organization_id);


--
-- Name: affiliate_payouts affiliate_payouts_affiliate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_payouts
    ADD CONSTRAINT affiliate_payouts_affiliate_id_fkey FOREIGN KEY (affiliate_id) REFERENCES public.affiliates(id);


--
-- Name: affiliate_referrals affiliate_referrals_affiliate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_referrals
    ADD CONSTRAINT affiliate_referrals_affiliate_id_fkey FOREIGN KEY (affiliate_id) REFERENCES public.affiliates(id);


--
-- Name: affiliates affiliates_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliates
    ADD CONSTRAINT affiliates_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.affiliate_campaigns(id);


--
-- Name: automation_rule_logs automation_rule_logs_rule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_rule_logs
    ADD CONSTRAINT automation_rule_logs_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES public.automation_rules(id);


--
-- Name: bookings bookings_booking_page_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_booking_page_id_fkey FOREIGN KEY (booking_page_id) REFERENCES public.booking_pages(id);


--
-- Name: bookings bookings_recurrence_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_recurrence_parent_id_fkey FOREIGN KEY (recurrence_parent_id) REFERENCES public.bookings(id) ON DELETE CASCADE;


--
-- Name: chat_conversations chat_conversations_widget_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_conversations
    ADD CONSTRAINT chat_conversations_widget_id_fkey FOREIGN KEY (widget_id) REFERENCES public.chat_widgets(id);


--
-- Name: chat_messages chat_messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.chat_conversations(id);


--
-- Name: course_enrollments course_enrollments_course_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.course_enrollments
    ADD CONSTRAINT course_enrollments_course_id_fkey FOREIGN KEY (course_id) REFERENCES public.courses(id);


--
-- Name: course_lessons course_lessons_module_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.course_lessons
    ADD CONSTRAINT course_lessons_module_id_fkey FOREIGN KEY (module_id) REFERENCES public.course_modules(id);


--
-- Name: course_modules course_modules_course_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.course_modules
    ADD CONSTRAINT course_modules_course_id_fkey FOREIGN KEY (course_id) REFERENCES public.courses(id);


--
-- Name: customer_activities customer_activities_deal_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_activities
    ADD CONSTRAINT customer_activities_deal_id_foreign FOREIGN KEY (deal_id) REFERENCES public.customer_deals(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: customer_activities customer_activities_entity_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_activities
    ADD CONSTRAINT customer_activities_entity_id_foreign FOREIGN KEY (entity_id) REFERENCES public.customer_entities(id) ON UPDATE CASCADE;


--
-- Name: customer_addresses customer_addresses_entity_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_addresses
    ADD CONSTRAINT customer_addresses_entity_id_foreign FOREIGN KEY (entity_id) REFERENCES public.customer_entities(id) ON UPDATE CASCADE;


--
-- Name: customer_comments customer_comments_deal_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_comments
    ADD CONSTRAINT customer_comments_deal_id_foreign FOREIGN KEY (deal_id) REFERENCES public.customer_deals(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: customer_comments customer_comments_entity_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_comments
    ADD CONSTRAINT customer_comments_entity_id_foreign FOREIGN KEY (entity_id) REFERENCES public.customer_entities(id) ON UPDATE CASCADE;


--
-- Name: customer_companies customer_companies_entity_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_companies
    ADD CONSTRAINT customer_companies_entity_id_foreign FOREIGN KEY (entity_id) REFERENCES public.customer_entities(id) ON UPDATE CASCADE;


--
-- Name: customer_deal_companies customer_deal_companies_company_entity_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_deal_companies
    ADD CONSTRAINT customer_deal_companies_company_entity_id_foreign FOREIGN KEY (company_entity_id) REFERENCES public.customer_entities(id) ON UPDATE CASCADE;


--
-- Name: customer_deal_companies customer_deal_companies_deal_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_deal_companies
    ADD CONSTRAINT customer_deal_companies_deal_id_foreign FOREIGN KEY (deal_id) REFERENCES public.customer_deals(id) ON UPDATE CASCADE;


--
-- Name: customer_deal_people customer_deal_people_deal_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_deal_people
    ADD CONSTRAINT customer_deal_people_deal_id_foreign FOREIGN KEY (deal_id) REFERENCES public.customer_deals(id) ON UPDATE CASCADE;


--
-- Name: customer_deal_people customer_deal_people_person_entity_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_deal_people
    ADD CONSTRAINT customer_deal_people_person_entity_id_foreign FOREIGN KEY (person_entity_id) REFERENCES public.customer_entities(id) ON UPDATE CASCADE;


--
-- Name: customer_people customer_people_company_entity_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_people
    ADD CONSTRAINT customer_people_company_entity_id_foreign FOREIGN KEY (company_entity_id) REFERENCES public.customer_entities(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: customer_people customer_people_entity_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_people
    ADD CONSTRAINT customer_people_entity_id_foreign FOREIGN KEY (entity_id) REFERENCES public.customer_entities(id) ON UPDATE CASCADE;


--
-- Name: customer_role_acls customer_role_acls_role_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_role_acls
    ADD CONSTRAINT customer_role_acls_role_id_foreign FOREIGN KEY (role_id) REFERENCES public.customer_roles(id) ON UPDATE CASCADE;


--
-- Name: customer_tag_assignments customer_tag_assignments_entity_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_tag_assignments
    ADD CONSTRAINT customer_tag_assignments_entity_id_foreign FOREIGN KEY (entity_id) REFERENCES public.customer_entities(id) ON UPDATE CASCADE;


--
-- Name: customer_tag_assignments customer_tag_assignments_tag_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_tag_assignments
    ADD CONSTRAINT customer_tag_assignments_tag_id_foreign FOREIGN KEY (tag_id) REFERENCES public.customer_tags(id) ON UPDATE CASCADE;


--
-- Name: customer_todo_links customer_todo_links_entity_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_todo_links
    ADD CONSTRAINT customer_todo_links_entity_id_foreign FOREIGN KEY (entity_id) REFERENCES public.customer_entities(id) ON UPDATE CASCADE;


--
-- Name: customer_user_acls customer_user_acls_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_user_acls
    ADD CONSTRAINT customer_user_acls_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.customer_users(id) ON UPDATE CASCADE;


--
-- Name: customer_user_email_verifications customer_user_email_verifications_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_user_email_verifications
    ADD CONSTRAINT customer_user_email_verifications_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.customer_users(id) ON UPDATE CASCADE;


--
-- Name: customer_user_password_resets customer_user_password_resets_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_user_password_resets
    ADD CONSTRAINT customer_user_password_resets_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.customer_users(id) ON UPDATE CASCADE;


--
-- Name: customer_user_roles customer_user_roles_role_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_user_roles
    ADD CONSTRAINT customer_user_roles_role_id_foreign FOREIGN KEY (role_id) REFERENCES public.customer_roles(id) ON UPDATE CASCADE;


--
-- Name: customer_user_roles customer_user_roles_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_user_roles
    ADD CONSTRAINT customer_user_roles_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.customer_users(id) ON UPDATE CASCADE;


--
-- Name: customer_user_sessions customer_user_sessions_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_user_sessions
    ADD CONSTRAINT customer_user_sessions_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.customer_users(id) ON UPDATE CASCADE;


--
-- Name: dictionary_entries dictionary_entries_dictionary_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dictionary_entries
    ADD CONSTRAINT dictionary_entries_dictionary_id_foreign FOREIGN KEY (dictionary_id) REFERENCES public.dictionaries(id) ON UPDATE CASCADE;


--
-- Name: email_list_members email_list_members_list_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_list_members
    ADD CONSTRAINT email_list_members_list_id_fkey FOREIGN KEY (list_id) REFERENCES public.email_lists(id) ON DELETE CASCADE;


--
-- Name: feature_toggle_audit_logs feature_toggle_audit_logs_toggle_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_toggle_audit_logs
    ADD CONSTRAINT feature_toggle_audit_logs_toggle_id_foreign FOREIGN KEY (toggle_id) REFERENCES public.feature_toggles(id) ON UPDATE CASCADE;


--
-- Name: feature_toggle_overrides feature_toggle_overrides_toggle_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_toggle_overrides
    ADD CONSTRAINT feature_toggle_overrides_toggle_id_foreign FOREIGN KEY (toggle_id) REFERENCES public.feature_toggles(id) ON UPDATE CASCADE;


--
-- Name: funnel_orders funnel_orders_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.funnel_orders
    ADD CONSTRAINT funnel_orders_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.funnel_sessions(id);


--
-- Name: funnel_sessions funnel_sessions_funnel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.funnel_sessions
    ADD CONSTRAINT funnel_sessions_funnel_id_fkey FOREIGN KEY (funnel_id) REFERENCES public.funnels(id) ON DELETE CASCADE;


--
-- Name: funnel_steps funnel_steps_funnel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.funnel_steps
    ADD CONSTRAINT funnel_steps_funnel_id_fkey FOREIGN KEY (funnel_id) REFERENCES public.funnels(id) ON DELETE CASCADE;


--
-- Name: gtm_auto_refill_cycles gtm_auto_refill_cycles_campaign_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_auto_refill_cycles
    ADD CONSTRAINT gtm_auto_refill_cycles_campaign_id_foreign FOREIGN KEY (campaign_id) REFERENCES public.gtm_campaigns(id) ON UPDATE CASCADE;


--
-- Name: gtm_auto_refill_cycles gtm_auto_refill_cycles_campaign_version_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_auto_refill_cycles
    ADD CONSTRAINT gtm_auto_refill_cycles_campaign_version_id_foreign FOREIGN KEY (campaign_version_id) REFERENCES public.gtm_campaign_versions(id) ON UPDATE CASCADE;


--
-- Name: gtm_auto_refill_cycles gtm_auto_refill_cycles_play_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_auto_refill_cycles
    ADD CONSTRAINT gtm_auto_refill_cycles_play_id_foreign FOREIGN KEY (play_id) REFERENCES public.gtm_plays(id) ON UPDATE CASCADE;


--
-- Name: gtm_auto_refill_cycles gtm_auto_refill_cycles_policy_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_auto_refill_cycles
    ADD CONSTRAINT gtm_auto_refill_cycles_policy_id_foreign FOREIGN KEY (policy_id) REFERENCES public.gtm_auto_refill_policies(id) ON UPDATE CASCADE;


--
-- Name: gtm_auto_refill_cycles gtm_auto_refill_cycles_research_run_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_auto_refill_cycles
    ADD CONSTRAINT gtm_auto_refill_cycles_research_run_id_foreign FOREIGN KEY (research_run_id) REFERENCES public.gtm_research_runs(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: gtm_auto_refill_policies gtm_auto_refill_policies_campaign_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_auto_refill_policies
    ADD CONSTRAINT gtm_auto_refill_policies_campaign_id_foreign FOREIGN KEY (campaign_id) REFERENCES public.gtm_campaigns(id) ON UPDATE CASCADE;


--
-- Name: gtm_auto_refill_policies gtm_auto_refill_policies_campaign_version_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_auto_refill_policies
    ADD CONSTRAINT gtm_auto_refill_policies_campaign_version_id_foreign FOREIGN KEY (campaign_version_id) REFERENCES public.gtm_campaign_versions(id) ON UPDATE CASCADE;


--
-- Name: gtm_auto_refill_policies gtm_auto_refill_policies_play_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_auto_refill_policies
    ADD CONSTRAINT gtm_auto_refill_policies_play_id_foreign FOREIGN KEY (play_id) REFERENCES public.gtm_plays(id) ON UPDATE CASCADE;


--
-- Name: gtm_auto_refill_policies gtm_auto_refill_policies_workspace_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_auto_refill_policies
    ADD CONSTRAINT gtm_auto_refill_policies_workspace_id_foreign FOREIGN KEY (workspace_id) REFERENCES public.gtm_workspaces(id) ON UPDATE CASCADE;


--
-- Name: gtm_campaign_versions gtm_campaign_versions_campaign_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_campaign_versions
    ADD CONSTRAINT gtm_campaign_versions_campaign_id_foreign FOREIGN KEY (campaign_id) REFERENCES public.gtm_campaigns(id) ON UPDATE CASCADE;


--
-- Name: gtm_campaigns gtm_campaigns_current_version_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_campaigns
    ADD CONSTRAINT gtm_campaigns_current_version_id_foreign FOREIGN KEY (current_version_id) REFERENCES public.gtm_campaign_versions(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: gtm_campaigns gtm_campaigns_play_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_campaigns
    ADD CONSTRAINT gtm_campaigns_play_id_foreign FOREIGN KEY (play_id) REFERENCES public.gtm_plays(id) ON UPDATE CASCADE;


--
-- Name: gtm_campaigns gtm_campaigns_workspace_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_campaigns
    ADD CONSTRAINT gtm_campaigns_workspace_id_foreign FOREIGN KEY (workspace_id) REFERENCES public.gtm_workspaces(id) ON UPDATE CASCADE;


--
-- Name: gtm_candidate_matches gtm_candidate_matches_candidate_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_candidate_matches
    ADD CONSTRAINT gtm_candidate_matches_candidate_id_foreign FOREIGN KEY (candidate_id) REFERENCES public.gtm_candidates(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: gtm_candidate_matches gtm_candidate_matches_play_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_candidate_matches
    ADD CONSTRAINT gtm_candidate_matches_play_id_foreign FOREIGN KEY (play_id) REFERENCES public.gtm_plays(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: gtm_candidate_matches gtm_candidate_matches_provider_operation_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_candidate_matches
    ADD CONSTRAINT gtm_candidate_matches_provider_operation_id_foreign FOREIGN KEY (provider_operation_id) REFERENCES public.gtm_provider_operations(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: gtm_candidate_matches gtm_candidate_matches_research_run_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_candidate_matches
    ADD CONSTRAINT gtm_candidate_matches_research_run_id_foreign FOREIGN KEY (research_run_id) REFERENCES public.gtm_research_runs(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: gtm_candidate_matches gtm_candidate_matches_workspace_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_candidate_matches
    ADD CONSTRAINT gtm_candidate_matches_workspace_id_foreign FOREIGN KEY (workspace_id) REFERENCES public.gtm_workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: gtm_candidate_relations gtm_candidate_relations_child_candidate_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_candidate_relations
    ADD CONSTRAINT gtm_candidate_relations_child_candidate_id_foreign FOREIGN KEY (child_candidate_id) REFERENCES public.gtm_candidates(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: gtm_candidate_relations gtm_candidate_relations_parent_candidate_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_candidate_relations
    ADD CONSTRAINT gtm_candidate_relations_parent_candidate_id_foreign FOREIGN KEY (parent_candidate_id) REFERENCES public.gtm_candidates(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: gtm_candidate_relations gtm_candidate_relations_parent_match_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_candidate_relations
    ADD CONSTRAINT gtm_candidate_relations_parent_match_id_foreign FOREIGN KEY (parent_match_id) REFERENCES public.gtm_candidate_matches(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: gtm_candidate_relations gtm_candidate_relations_play_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_candidate_relations
    ADD CONSTRAINT gtm_candidate_relations_play_id_foreign FOREIGN KEY (play_id) REFERENCES public.gtm_plays(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: gtm_candidate_relations gtm_candidate_relations_provider_operation_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_candidate_relations
    ADD CONSTRAINT gtm_candidate_relations_provider_operation_id_foreign FOREIGN KEY (provider_operation_id) REFERENCES public.gtm_provider_operations(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: gtm_candidate_relations gtm_candidate_relations_research_run_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_candidate_relations
    ADD CONSTRAINT gtm_candidate_relations_research_run_id_foreign FOREIGN KEY (research_run_id) REFERENCES public.gtm_research_runs(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: gtm_candidate_relations gtm_candidate_relations_workspace_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_candidate_relations
    ADD CONSTRAINT gtm_candidate_relations_workspace_id_foreign FOREIGN KEY (workspace_id) REFERENCES public.gtm_workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: gtm_candidates gtm_candidates_research_run_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_candidates
    ADD CONSTRAINT gtm_candidates_research_run_id_foreign FOREIGN KEY (research_run_id) REFERENCES public.gtm_research_runs(id) ON UPDATE CASCADE;


--
-- Name: gtm_candidates gtm_candidates_workspace_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_candidates
    ADD CONSTRAINT gtm_candidates_workspace_id_foreign FOREIGN KEY (workspace_id) REFERENCES public.gtm_workspaces(id) ON UPDATE CASCADE;


--
-- Name: gtm_chat_messages gtm_chat_messages_thread_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_chat_messages
    ADD CONSTRAINT gtm_chat_messages_thread_id_foreign FOREIGN KEY (thread_id) REFERENCES public.gtm_chat_threads(id) ON UPDATE CASCADE;


--
-- Name: gtm_chat_threads gtm_chat_threads_workspace_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_chat_threads
    ADD CONSTRAINT gtm_chat_threads_workspace_id_foreign FOREIGN KEY (workspace_id) REFERENCES public.gtm_workspaces(id) ON UPDATE CASCADE;


--
-- Name: gtm_contact_points gtm_contact_points_candidate_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_contact_points
    ADD CONSTRAINT gtm_contact_points_candidate_id_foreign FOREIGN KEY (candidate_id) REFERENCES public.gtm_candidates(id) ON UPDATE CASCADE;


--
-- Name: gtm_contact_points gtm_contact_points_provider_operation_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_contact_points
    ADD CONSTRAINT gtm_contact_points_provider_operation_id_foreign FOREIGN KEY (provider_operation_id) REFERENCES public.gtm_provider_operations(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: gtm_dsr_operations gtm_dsr_operations_deletion_request_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_dsr_operations
    ADD CONSTRAINT gtm_dsr_operations_deletion_request_id_foreign FOREIGN KEY (deletion_request_id) REFERENCES public.gtm_deletion_requests(id) ON UPDATE CASCADE;


--
-- Name: gtm_enrollments gtm_enrollments_campaign_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_enrollments
    ADD CONSTRAINT gtm_enrollments_campaign_id_foreign FOREIGN KEY (campaign_id) REFERENCES public.gtm_campaigns(id) ON UPDATE CASCADE;


--
-- Name: gtm_enrollments gtm_enrollments_campaign_version_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_enrollments
    ADD CONSTRAINT gtm_enrollments_campaign_version_id_foreign FOREIGN KEY (campaign_version_id) REFERENCES public.gtm_campaign_versions(id) ON UPDATE CASCADE;


--
-- Name: gtm_enrollments gtm_enrollments_candidate_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_enrollments
    ADD CONSTRAINT gtm_enrollments_candidate_id_foreign FOREIGN KEY (candidate_id) REFERENCES public.gtm_candidates(id) ON UPDATE CASCADE;


--
-- Name: gtm_evidence gtm_evidence_candidate_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_evidence
    ADD CONSTRAINT gtm_evidence_candidate_id_foreign FOREIGN KEY (candidate_id) REFERENCES public.gtm_candidates(id) ON UPDATE CASCADE;


--
-- Name: gtm_evidence gtm_evidence_research_run_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_evidence
    ADD CONSTRAINT gtm_evidence_research_run_id_foreign FOREIGN KEY (research_run_id) REFERENCES public.gtm_research_runs(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: gtm_icp_versions gtm_icp_versions_workspace_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_icp_versions
    ADD CONSTRAINT gtm_icp_versions_workspace_id_foreign FOREIGN KEY (workspace_id) REFERENCES public.gtm_workspaces(id) ON UPDATE CASCADE;


--
-- Name: gtm_inbound_events gtm_inbound_events_enrollment_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_inbound_events
    ADD CONSTRAINT gtm_inbound_events_enrollment_id_foreign FOREIGN KEY (enrollment_id) REFERENCES public.gtm_enrollments(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: gtm_inbound_events gtm_inbound_events_send_attempt_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_inbound_events
    ADD CONSTRAINT gtm_inbound_events_send_attempt_id_foreign FOREIGN KEY (send_attempt_id) REFERENCES public.gtm_send_attempts(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: gtm_manual_outreach_drafts gtm_manual_outreach_drafts_candidate_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_manual_outreach_drafts
    ADD CONSTRAINT gtm_manual_outreach_drafts_candidate_id_foreign FOREIGN KEY (candidate_id) REFERENCES public.gtm_candidates(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: gtm_manual_outreach_drafts gtm_manual_outreach_drafts_match_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_manual_outreach_drafts
    ADD CONSTRAINT gtm_manual_outreach_drafts_match_id_foreign FOREIGN KEY (match_id) REFERENCES public.gtm_candidate_matches(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: gtm_manual_outreach_drafts gtm_manual_outreach_drafts_play_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_manual_outreach_drafts
    ADD CONSTRAINT gtm_manual_outreach_drafts_play_id_foreign FOREIGN KEY (play_id) REFERENCES public.gtm_plays(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: gtm_manual_outreach_drafts gtm_manual_outreach_drafts_workspace_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_manual_outreach_drafts
    ADD CONSTRAINT gtm_manual_outreach_drafts_workspace_id_foreign FOREIGN KEY (workspace_id) REFERENCES public.gtm_workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: gtm_plays gtm_plays_workspace_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_plays
    ADD CONSTRAINT gtm_plays_workspace_id_foreign FOREIGN KEY (workspace_id) REFERENCES public.gtm_workspaces(id) ON UPDATE CASCADE;


--
-- Name: gtm_provider_operations gtm_provider_operations_candidate_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_provider_operations
    ADD CONSTRAINT gtm_provider_operations_candidate_id_foreign FOREIGN KEY (candidate_id) REFERENCES public.gtm_candidates(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: gtm_provider_operations gtm_provider_operations_research_run_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_provider_operations
    ADD CONSTRAINT gtm_provider_operations_research_run_id_foreign FOREIGN KEY (research_run_id) REFERENCES public.gtm_research_runs(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: gtm_provider_reconciliation_actions gtm_provider_reconciliation_actions_provider_ope_7d44d_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_provider_reconciliation_actions
    ADD CONSTRAINT gtm_provider_reconciliation_actions_provider_ope_7d44d_foreign FOREIGN KEY (provider_operation_id) REFERENCES public.gtm_provider_operations(id) ON UPDATE CASCADE;


--
-- Name: gtm_rendered_messages gtm_rendered_messages_campaign_version_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_rendered_messages
    ADD CONSTRAINT gtm_rendered_messages_campaign_version_id_foreign FOREIGN KEY (campaign_version_id) REFERENCES public.gtm_campaign_versions(id) ON UPDATE CASCADE;


--
-- Name: gtm_rendered_messages gtm_rendered_messages_enrollment_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_rendered_messages
    ADD CONSTRAINT gtm_rendered_messages_enrollment_id_foreign FOREIGN KEY (enrollment_id) REFERENCES public.gtm_enrollments(id) ON UPDATE CASCADE;


--
-- Name: gtm_rendered_messages gtm_rendered_messages_step_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_rendered_messages
    ADD CONSTRAINT gtm_rendered_messages_step_id_foreign FOREIGN KEY (step_id) REFERENCES public.gtm_steps(id) ON UPDATE CASCADE;


--
-- Name: gtm_replies gtm_replies_enrollment_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_replies
    ADD CONSTRAINT gtm_replies_enrollment_id_foreign FOREIGN KEY (enrollment_id) REFERENCES public.gtm_enrollments(id) ON UPDATE CASCADE;


--
-- Name: gtm_replies gtm_replies_send_attempt_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_replies
    ADD CONSTRAINT gtm_replies_send_attempt_id_foreign FOREIGN KEY (send_attempt_id) REFERENCES public.gtm_send_attempts(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: gtm_replies gtm_replies_step_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_replies
    ADD CONSTRAINT gtm_replies_step_id_foreign FOREIGN KEY (step_id) REFERENCES public.gtm_steps(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: gtm_research_runs gtm_research_runs_play_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_research_runs
    ADD CONSTRAINT gtm_research_runs_play_id_foreign FOREIGN KEY (play_id) REFERENCES public.gtm_plays(id) ON UPDATE CASCADE;


--
-- Name: gtm_research_runs gtm_research_runs_workspace_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_research_runs
    ADD CONSTRAINT gtm_research_runs_workspace_id_foreign FOREIGN KEY (workspace_id) REFERENCES public.gtm_workspaces(id) ON UPDATE CASCADE;


--
-- Name: gtm_send_attempts gtm_send_attempts_campaign_version_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_send_attempts
    ADD CONSTRAINT gtm_send_attempts_campaign_version_id_foreign FOREIGN KEY (campaign_version_id) REFERENCES public.gtm_campaign_versions(id) ON UPDATE CASCADE;


--
-- Name: gtm_send_attempts gtm_send_attempts_enrollment_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_send_attempts
    ADD CONSTRAINT gtm_send_attempts_enrollment_id_foreign FOREIGN KEY (enrollment_id) REFERENCES public.gtm_enrollments(id) ON UPDATE CASCADE;


--
-- Name: gtm_send_attempts gtm_send_attempts_rendered_message_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_send_attempts
    ADD CONSTRAINT gtm_send_attempts_rendered_message_id_foreign FOREIGN KEY (rendered_message_id) REFERENCES public.gtm_rendered_messages(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: gtm_send_attempts gtm_send_attempts_step_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_send_attempts
    ADD CONSTRAINT gtm_send_attempts_step_id_foreign FOREIGN KEY (step_id) REFERENCES public.gtm_steps(id) ON UPDATE CASCADE;


--
-- Name: gtm_steps gtm_steps_campaign_version_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_steps
    ADD CONSTRAINT gtm_steps_campaign_version_id_foreign FOREIGN KEY (campaign_version_id) REFERENCES public.gtm_campaign_versions(id) ON UPDATE CASCADE;


--
-- Name: gtm_steps gtm_steps_depends_on_step_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_steps
    ADD CONSTRAINT gtm_steps_depends_on_step_id_foreign FOREIGN KEY (depends_on_step_id) REFERENCES public.gtm_steps(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: gtm_voice_versions gtm_voice_versions_workspace_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gtm_voice_versions
    ADD CONSTRAINT gtm_voice_versions_workspace_id_foreign FOREIGN KEY (workspace_id) REFERENCES public.gtm_workspaces(id) ON UPDATE CASCADE;


--
-- Name: inbox_notes inbox_notes_inbox_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbox_notes
    ADD CONSTRAINT inbox_notes_inbox_conversation_id_fkey FOREIGN KEY (inbox_conversation_id) REFERENCES public.inbox_conversations(id) ON DELETE CASCADE;


--
-- Name: landing_page_forms landing_page_forms_landing_page_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.landing_page_forms
    ADD CONSTRAINT landing_page_forms_landing_page_id_fkey FOREIGN KEY (landing_page_id) REFERENCES public.landing_pages(id);


--
-- Name: lesson_progress lesson_progress_enrollment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lesson_progress
    ADD CONSTRAINT lesson_progress_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES public.course_enrollments(id);


--
-- Name: lesson_progress lesson_progress_lesson_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lesson_progress
    ADD CONSTRAINT lesson_progress_lesson_id_fkey FOREIGN KEY (lesson_id) REFERENCES public.course_lessons(id);


--
-- Name: organizations organizations_tenant_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_tenant_id_foreign FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON UPDATE CASCADE;


--
-- Name: password_resets password_resets_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_resets
    ADD CONSTRAINT password_resets_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE;


--
-- Name: payment_links payment_links_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_links
    ADD CONSTRAINT payment_links_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: role_acls role_acls_role_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_acls
    ADD CONSTRAINT role_acls_role_id_foreign FOREIGN KEY (role_id) REFERENCES public.roles(id) ON UPDATE CASCADE;


--
-- Name: role_sidebar_preferences role_sidebar_preferences_role_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_sidebar_preferences
    ADD CONSTRAINT role_sidebar_preferences_role_id_foreign FOREIGN KEY (role_id) REFERENCES public.roles(id) ON UPDATE CASCADE;


--
-- Name: sequence_enrollments sequence_enrollments_sequence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequence_enrollments
    ADD CONSTRAINT sequence_enrollments_sequence_id_fkey FOREIGN KEY (sequence_id) REFERENCES public.sequences(id);


--
-- Name: sequence_step_executions sequence_step_executions_enrollment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequence_step_executions
    ADD CONSTRAINT sequence_step_executions_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES public.sequence_enrollments(id);


--
-- Name: sequence_step_executions sequence_step_executions_step_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequence_step_executions
    ADD CONSTRAINT sequence_step_executions_step_id_fkey FOREIGN KEY (step_id) REFERENCES public.sequence_steps(id);


--
-- Name: sequence_steps sequence_steps_sequence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequence_steps
    ADD CONSTRAINT sequence_steps_sequence_id_fkey FOREIGN KEY (sequence_id) REFERENCES public.sequences(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE;


--
-- Name: staff_leave_requests staff_leave_requests_member_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_leave_requests
    ADD CONSTRAINT staff_leave_requests_member_id_foreign FOREIGN KEY (member_id) REFERENCES public.staff_team_members(id) ON UPDATE CASCADE;


--
-- Name: staff_team_member_activities staff_team_member_activities_member_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_team_member_activities
    ADD CONSTRAINT staff_team_member_activities_member_id_foreign FOREIGN KEY (member_id) REFERENCES public.staff_team_members(id) ON UPDATE CASCADE;


--
-- Name: staff_team_member_addresses staff_team_member_addresses_member_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_team_member_addresses
    ADD CONSTRAINT staff_team_member_addresses_member_id_foreign FOREIGN KEY (member_id) REFERENCES public.staff_team_members(id) ON UPDATE CASCADE;


--
-- Name: staff_team_member_comments staff_team_member_comments_member_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_team_member_comments
    ADD CONSTRAINT staff_team_member_comments_member_id_foreign FOREIGN KEY (member_id) REFERENCES public.staff_team_members(id) ON UPDATE CASCADE;


--
-- Name: staff_team_member_job_histories staff_team_member_job_histories_member_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_team_member_job_histories
    ADD CONSTRAINT staff_team_member_job_histories_member_id_foreign FOREIGN KEY (member_id) REFERENCES public.staff_team_members(id) ON UPDATE CASCADE;


--
-- Name: survey_responses survey_responses_survey_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.survey_responses
    ADD CONSTRAINT survey_responses_survey_id_fkey FOREIGN KEY (survey_id) REFERENCES public.surveys(id);


--
-- Name: user_acls user_acls_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_acls
    ADD CONSTRAINT user_acls_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE;


--
-- Name: user_roles user_roles_role_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_role_id_foreign FOREIGN KEY (role_id) REFERENCES public.roles(id) ON UPDATE CASCADE;


--
-- Name: user_roles user_roles_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE;


--
-- Name: user_sidebar_preferences user_sidebar_preferences_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sidebar_preferences
    ADD CONSTRAINT user_sidebar_preferences_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE;


--
-- Name: webhook_deliveries webhook_deliveries_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.webhook_subscriptions(id);


--
-- PostgreSQL database dump complete
--

\unrestrict 9xC1hC60rOQnfTqiRSbUZBR6V0nf7FRM7rBHpg5AX6Zn2DdVt4bg7mSQeLm4edM

