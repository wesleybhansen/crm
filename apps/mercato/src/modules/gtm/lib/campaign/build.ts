import crypto from 'crypto'
import { computeExecutionEligibility, type EligibilityResult } from '../eligibility'
import { GtmAuditEvent, GtmCampaign, GtmPlay } from '../../data/entities'

/*
 * Campaign drafting (SPEC-066 sections 4, 7, 14 Tranche 5).
 *
 * A campaign starts life as a DRAFT: a mutable jsonb working set on the
 * gtm_campaigns row itself (channel_mix carries the planned step specs, the
 * message template, and manual exclusion overrides; settings carries the
 * daily cap, send window, and jitter). Durable GtmStep / GtmEnrollment /
 * GtmRenderedMessage rows are NOT written at draft time: per the entity
 * model every one of those rows hangs off a gtm_campaign_versions row, and
 * versions exist only at approval (lib/campaign/approve.ts). Until then the
 * draft is recomputable and cheap to edit.
 *
 * Ladder boundary (section 7, boundary 4 first half): a campaign can only be
 * ATTACHED to an executable play. Eligibility is recomputed here from the
 * play row's current market/geography state; the stored
 * execution_eligibility column and any caller claim are never trusted.
 */

// Minimal structural slice of MikroORM's EntityManager used by the campaign
// libraries, so tests can drive them with the in-memory FakeEm and routes
// pass the real em.
export interface CampaignEm {
  transactional<T>(cb: (tem: CampaignEm) => Promise<T>): Promise<T>
  create<T extends object>(entityClass: new () => T, data: object): T
  persist(entity: object): unknown
  flush(): Promise<void>
  find<T extends object>(
    entityClass: new () => T,
    where: Record<string, unknown>,
    options?: { orderBy?: Record<string, 'asc' | 'desc'>; limit?: number },
  ): Promise<T[]>
  findOne<T extends object>(entityClass: new () => T, where: Record<string, unknown>): Promise<T | null>
}

// Identity resolved server-side at the route boundary (SPEC-066 section 5).
export type GtmCtx = {
  organizationId: string
  tenantId: string
  userId: string
  requestId?: string | null
}

export class GtmCampaignError extends Error {
  constructor(
    public code:
      | 'play_not_found'
      | 'play_not_executable'
      | 'campaign_not_found'
      | 'candidate_not_found'
      | 'workspace_not_found'
      | 'postal_address_required'
      | 'sender_changed'
      | 'message_review_required'
      | 'stale_draft'
      | 'daily_cap_exceeds_ceiling'
      | 'invalid_settings'
      | 'invalid_channel_mix'
      | 'no_recipients'
      // a launched campaign cannot be re-approved; invalidate it first
      | 'campaign_not_editable',
    message: string,
  ) {
    super(message)
    this.name = 'GtmCampaignError'
  }
}

// ---------------------------------------------------------------------------
// Settings: daily cap, send window, jitter (SPEC-066 section 4 gtm_campaigns)
// ---------------------------------------------------------------------------

export const DEFAULT_DAILY_CAP = 25
// Hard ceiling per mailbox per day; anything above is rejected, never clamped
// silently (the user asked for a volume we refuse to send).
export const DAILY_CAP_CEILING = 50
export const DEFAULT_JITTER_MINUTES = 10
export const DEFAULT_SEND_WINDOW = {
  start_hour: 9,
  end_hour: 17,
  timezone: 'America/New_York',
} as const

export type SendWindow = { start_hour: number; end_hour: number; timezone: string }

export function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0))
    return true
  } catch {
    return false
  }
}

export type CampaignSettings = {
  daily_cap: number
  send_window: SendWindow
  jitter_minutes: number
  // -> email_connections.id, carried into the approval snapshot as the
  // frozen sender; the send machine itself is Tranche 6
  mailbox_connection_id: string | null
  // explicit override for duplicate-across-campaigns protection (section 8)
  duplicate_override: boolean
}

export type CampaignSettingsInput = Partial<{
  daily_cap: number
  send_window: Partial<SendWindow>
  jitter_minutes: number
  mailbox_connection_id: string | null
  duplicate_override: boolean
}>

export function normalizeSettings(input?: CampaignSettingsInput | null): CampaignSettings {
  const raw = input ?? {}
  const dailyCap = raw.daily_cap ?? DEFAULT_DAILY_CAP
  if (!Number.isInteger(dailyCap) || dailyCap < 1) {
    throw new GtmCampaignError('invalid_settings', 'daily_cap must be a positive integer')
  }
  if (dailyCap > DAILY_CAP_CEILING) {
    throw new GtmCampaignError(
      'daily_cap_exceeds_ceiling',
      `daily_cap ${dailyCap} exceeds the hard ceiling of ${DAILY_CAP_CEILING} sends per mailbox per day`,
    )
  }
  const window: SendWindow = {
    start_hour: raw.send_window?.start_hour ?? DEFAULT_SEND_WINDOW.start_hour,
    end_hour: raw.send_window?.end_hour ?? DEFAULT_SEND_WINDOW.end_hour,
    timezone: (raw.send_window?.timezone ?? DEFAULT_SEND_WINDOW.timezone).trim(),
  }
  if (
    !Number.isInteger(window.start_hour) ||
    !Number.isInteger(window.end_hour) ||
    window.start_hour < 0 ||
    window.start_hour > 23 ||
    window.end_hour < 1 ||
    window.end_hour > 24 ||
    window.end_hour <= window.start_hour ||
    !window.timezone ||
    !isValidTimeZone(window.timezone)
  ) {
    throw new GtmCampaignError('invalid_settings', 'send_window must satisfy 0 <= start_hour < end_hour <= 24 with a timezone')
  }
  const jitter = raw.jitter_minutes ?? DEFAULT_JITTER_MINUTES
  if (!Number.isInteger(jitter) || jitter < 0 || jitter > 120) {
    throw new GtmCampaignError('invalid_settings', 'jitter_minutes must be an integer between 0 and 120')
  }
  return {
    daily_cap: dailyCap,
    send_window: window,
    jitter_minutes: jitter,
    mailbox_connection_id: raw.mailbox_connection_id ?? null,
    duplicate_override: raw.duplicate_override === true,
  }
}

// ---------------------------------------------------------------------------
// Step plan (build plan defaults: up to three email steps over roughly ten
// business days; mixed channel = automated email + manual LinkedIn/X tasks)
// ---------------------------------------------------------------------------

export type ChannelMixInput = {
  // number of automated email steps, 1..3, default 3
  emails?: number
  // add a manual LinkedIn connection request plus a connect-gated follow-up
  linkedin?: boolean
  // add a manual X DM task
  x?: boolean
}

export type StepSpec = {
  // stable key within the draft; resolved to a GtmStep row id at approval
  key: string
  order: number
  channel: 'email' | 'linkedin' | 'x'
  mode: 'automated_email' | 'manual_social'
  delay_days: number
  depends_on_key: string | null
  dependency_kind: 'none' | 'linkedin_connection_accepted'
  social_action: 'connection_request' | 'followup' | 'dm' | null
}

// Business-day-ish spacing for up to three emails: day 0, day 3, day 7.
const EMAIL_DELAY_DAYS = [0, 3, 7]

export function buildSteps(channelMix?: ChannelMixInput | null): StepSpec[] {
  const mix = channelMix ?? {}
  const emails = mix.emails ?? 3
  if (!Number.isInteger(emails) || emails < 1 || emails > 3) {
    throw new GtmCampaignError('invalid_channel_mix', 'emails must be an integer between 1 and 3')
  }
  const steps: StepSpec[] = []
  let order = 1
  for (let i = 0; i < emails; i += 1) {
    steps.push({
      key: `email_${i + 1}`,
      order: order++,
      channel: 'email',
      mode: 'automated_email',
      delay_days: EMAIL_DELAY_DAYS[i],
      depends_on_key: null,
      dependency_kind: 'none',
      social_action: null,
    })
  }
  if (mix.linkedin === true) {
    // Connect-first (SPEC-066 section 10): the follow-up DM stays locked
    // until the user records the connection request as accepted.
    steps.push({
      key: 'linkedin_connect',
      order: order++,
      channel: 'linkedin',
      mode: 'manual_social',
      delay_days: 1,
      depends_on_key: null,
      dependency_kind: 'none',
      social_action: 'connection_request',
    })
    steps.push({
      key: 'linkedin_followup',
      order: order++,
      channel: 'linkedin',
      mode: 'manual_social',
      delay_days: 5,
      depends_on_key: 'linkedin_connect',
      dependency_kind: 'linkedin_connection_accepted',
      social_action: 'followup',
    })
  }
  if (mix.x === true) {
    steps.push({
      key: 'x_dm',
      order: order++,
      channel: 'x',
      mode: 'manual_social',
      delay_days: 2,
      depends_on_key: null,
      dependency_kind: 'none',
      social_action: 'dm',
    })
  }
  return steps
}

// ---------------------------------------------------------------------------
// Draft template + draft jsonb shape stored on gtm_campaigns.channel_mix
// ---------------------------------------------------------------------------

export type CampaignTemplate = { subject: string; body: string }

export const MIN_EMAIL_BODY_WORDS = 12
export const MAX_EMAIL_BODY_WORDS = 130

// Merge fields are grounded only: identity fields plus evidence/play facts.
// A missing field renders an honest review token, never an invented value
// (lib/campaign/render.ts).
export const DEFAULT_TEMPLATE: CampaignTemplate = {
  subject: 'Quick question for {{company}}',
  body:
    'Hi {{first_name}},\n\n' +
    'I noticed {{signal}}.\n\n' +
    '{{why_now}}\n\n' +
    'Worth a quick look? Happy to share how teams like {{company}} use it.',
}

export function templateForEmailStep(
  template: CampaignTemplate,
  step: Pick<StepSpec, 'key' | 'order'>,
): CampaignTemplate {
  if (step.order <= 1 || step.key === 'email_1') return template
  if (step.order === 2 || step.key === 'email_2') {
    return {
      subject: 'A different angle for {{company}}',
      body:
        'Hi {{first_name}},\n\n' +
        'One different angle from my first note: {{why_now}}\n\n' +
        'The specific signal I had in mind was {{signal}}. Would a short example for {{company}} be useful?',
    }
  }
  return {
    subject: 'Close the loop, {{first_name}}?',
    body:
      'Hi {{first_name}},\n\n' +
      'I will close the loop after this note. {{signal}}\n\n' +
      'If {{why_now}} is relevant at {{company}}, I can send a concise outline. If it is not a priority, no reply is needed.',
  }
}

export type CampaignDraftMix = {
  channels: { emails: number; linkedin: boolean; x: boolean }
  steps: StepSpec[]
  template: CampaignTemplate
  // candidate ids manually excluded from the recipient list
  manual_exclusions: string[]
}

export function parseDraftMix(campaign: GtmCampaign): CampaignDraftMix {
  const raw = (campaign.channelMix ?? {}) as Record<string, unknown>
  const channels = (raw.channels ?? {}) as Record<string, unknown>
  const template = (raw.template ?? {}) as Record<string, unknown>
  return {
    channels: {
      emails: typeof channels.emails === 'number' ? (channels.emails as number) : 3,
      linkedin: channels.linkedin === true,
      x: channels.x === true,
    },
    steps: Array.isArray(raw.steps) ? (raw.steps as StepSpec[]) : [],
    template: {
      subject: typeof template.subject === 'string' ? (template.subject as string) : DEFAULT_TEMPLATE.subject,
      body: typeof template.body === 'string' ? (template.body as string) : DEFAULT_TEMPLATE.body,
    },
    manual_exclusions: Array.isArray(raw.manual_exclusions)
      ? (raw.manual_exclusions as unknown[]).filter((id): id is string => typeof id === 'string')
      : [],
  }
}

export function parseSettings(campaign: GtmCampaign): CampaignSettings {
  return normalizeSettings((campaign.settings ?? {}) as CampaignSettingsInput)
}

// ---------------------------------------------------------------------------
// Stored per-recipient AI drafts (channel_mix.ai_drafts[candidateId]).
//
// When a recipient has been re-drafted with AI (lib/campaign/ai-draft.ts) the
// resulting copy is stored on the draft jsonb keyed by candidate id. body_text
// is the canonical source; render.ts rebuilds the html + compliance footer and
// the frozen content hash from it, exactly like a template body, so an AI
// draft freezes into an approved version identically to a template render.
// provenance is kept loose here (author + model + version refs) to avoid a
// type cycle with ai-draft.ts.
// ---------------------------------------------------------------------------

export type StoredAiDraft = {
  subject: string
  body_text: string
  provenance: Record<string, unknown> | null
  step_key?: string
  step_order?: number
}

export type StoredAiDraftSequence = StoredAiDraft & {
  steps?: Record<string, StoredAiDraft>
}

export function parseStoredAiDrafts(
  campaign: GtmCampaign,
): Record<string, Record<string, StoredAiDraft>> {
  const raw = (campaign.channelMix ?? {}) as Record<string, unknown>
  const drafts = raw.ai_drafts
  if (!drafts || typeof drafts !== 'object' || Array.isArray(drafts)) return {}
  const out: Record<string, Record<string, StoredAiDraft>> = {}
  for (const [candidateId, value] of Object.entries(drafts as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const record = value as Record<string, unknown>
    const subject = typeof record.subject === 'string' ? record.subject : ''
    const bodyText = typeof record.body_text === 'string' ? record.body_text : ''
    if (!subject || !bodyText) continue
    const first: StoredAiDraft = {
      subject,
      body_text: bodyText,
      provenance: (record.provenance ?? null) as Record<string, unknown> | null,
      step_key: typeof record.step_key === 'string' ? record.step_key : 'email_1',
      step_order: typeof record.step_order === 'number' ? record.step_order : 1,
    }
    const sequence: Record<string, StoredAiDraft> = { [first.step_key ?? 'email_1']: first }
    const steps = record.steps
    if (steps && typeof steps === 'object' && !Array.isArray(steps)) {
      for (const [stepKey, stepValue] of Object.entries(steps as Record<string, unknown>)) {
        if (!stepValue || typeof stepValue !== 'object') continue
        const stepRecord = stepValue as Record<string, unknown>
        if (typeof stepRecord.subject !== 'string' || typeof stepRecord.body_text !== 'string') continue
        if (!stepRecord.subject || !stepRecord.body_text) continue
        sequence[stepKey] = {
          subject: stepRecord.subject,
          body_text: stepRecord.body_text,
          provenance: (stepRecord.provenance ?? null) as Record<string, unknown> | null,
          step_key: stepKey,
          step_order: typeof stepRecord.step_order === 'number' ? stepRecord.step_order : undefined,
        }
      }
    }
    out[candidateId] = sequence
  }
  return out
}

// ---------------------------------------------------------------------------
// AMS asset references (blog-ops gtm-asset-handoff-contract-2026-07-23,
// SPEC-066 section 13). GTM stores REFERENCES only: AMS stays the asset
// system of record. References live in channel_mix.asset_refs on the draft
// and freeze into the approval snapshot (lib/campaign/approve.ts includes
// them in the canonical draft object).
// ---------------------------------------------------------------------------

export type AssetRef = {
  id: string
  kind: string
  title: string
  publishedUrl: string
  // Resolved URL frozen at attach time; the approval snapshot preserves it so
  // a later unpublish in AMS never mutates an approved version (contract
  // item 4).
  frozen_url: string | null
}

export function parseAssetRefs(campaign: GtmCampaign): AssetRef[] {
  const raw = (campaign.channelMix ?? {}) as Record<string, unknown>
  if (!Array.isArray(raw.asset_refs)) return []
  const out: AssetRef[] = []
  for (const entry of raw.asset_refs) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    if (typeof record.id !== 'string' || !record.id) continue
    out.push({
      id: record.id,
      kind: typeof record.kind === 'string' ? record.kind : 'unknown',
      title: typeof record.title === 'string' ? record.title : '',
      publishedUrl: typeof record.publishedUrl === 'string' ? record.publishedUrl : '',
      frozen_url: typeof record.frozen_url === 'string' ? record.frozen_url : null,
    })
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

// ---------------------------------------------------------------------------
// createCampaign
// ---------------------------------------------------------------------------

export type CreateCampaignInput = {
  workspaceId: string
  playId: string
  name: string
  channelMix?: ChannelMixInput | null
  settings?: CampaignSettingsInput | null
}

export type CreateCampaignResult = {
  campaign: GtmCampaign
  play: GtmPlay
  eligibility: EligibilityResult
  steps: StepSpec[]
  settings: CampaignSettings
}

export async function createCampaign(
  em: CampaignEm,
  ctx: GtmCtx,
  input: CreateCampaignInput,
): Promise<CreateCampaignResult> {
  const play = await em.findOne(GtmPlay, {
    id: input.playId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!play || play.workspaceId !== input.workspaceId) {
    throw new GtmCampaignError('play_not_found', 'Play not found in this workspace')
  }

  // Section 7 ladder, boundary 4 (campaign attach): recomputed from the play
  // row's current state; a strategy_only play can never carry a campaign.
  const eligibility = computeExecutionEligibility({
    market_type: play.marketType ?? null,
    geography: play.geography ?? null,
  })
  if (eligibility.execution_eligibility !== 'executable') {
    throw new GtmCampaignError('play_not_executable', eligibility.eligibility_reason)
  }

  const steps = buildSteps(input.channelMix)
  const settings = normalizeSettings(input.settings)
  const name = input.name.trim()
  if (!name) {
    throw new GtmCampaignError('invalid_settings', 'name is required')
  }

  const campaign = await em.transactional(async (tem) => {
    const row = tem.create(GtmCampaign, {
      // app-side id so the audit event can reference the campaign pre-flush
      id: crypto.randomUUID(),
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      workspaceId: input.workspaceId,
      playId: play.id,
      name,
      status: 'draft',
      currentVersionId: null,
      channelMix: {
        channels: {
          emails: input.channelMix?.emails ?? 3,
          linkedin: input.channelMix?.linkedin === true,
          x: input.channelMix?.x === true,
        },
        steps,
        template: DEFAULT_TEMPLATE,
        manual_exclusions: [],
      },
      settings,
    })
    tem.persist(row)
    const audit = tem.create(GtmAuditEvent, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      actor: 'user_id',
      actorUserId: ctx.userId,
      action: 'gtm.campaign.created',
      objectType: 'gtm_campaign',
      objectId: row.id,
      requestId: ctx.requestId ?? null,
      metadata: {
        play_id: play.id,
        workspace_id: input.workspaceId,
        step_count: steps.length,
        daily_cap: settings.daily_cap,
      },
    })
    tem.persist(audit)
    await tem.flush()
    return row
  })

  return { campaign, play, eligibility, steps, settings }
}
