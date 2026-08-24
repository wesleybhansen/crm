import {
  GtmCampaign,
  GtmEnrollment,
  GtmReply,
  GtmSendAttempt,
  GtmStep,
} from '../../data/entities'

export const GTM_CAMPAIGN_ANALYTICS_LIMIT = 50

const ATTEMPT_STATES = [
  'planned',
  'rendered',
  'reviewed',
  'approved',
  'paused',
  'claimed',
  'provider_started',
  'accepted',
  'failed',
  'ambiguous',
  'delivered',
  'bounced',
  'complained',
  'replied',
] as const

const REPLY_CLASSIFICATIONS = [
  'interested',
  'neutral_question',
  'not_now',
  'referral',
  'unsubscribe',
  'wrong_person',
  'negative',
] as const

type AttemptState = typeof ATTEMPT_STATES[number]
type ReplyClassification = typeof REPLY_CLASSIFICATIONS[number]

type AnalyticsCtx = {
  organizationId: string
  tenantId: string
}

export interface CampaignAnalyticsEm {
  find<T extends object>(
    entityClass: new () => T,
    where: Record<string, unknown>,
    options?: { orderBy?: Record<string, 'asc' | 'desc'>; limit?: number },
  ): Promise<T[]>
}

type AttemptCounts = Record<AttemptState | 'other', number>
type ReplyCounts = Record<ReplyClassification | 'unclassified', number>

export type CampaignAnalyticsRow = {
  campaign_id: string
  campaign_name: string
  campaign_status: string
  current_version_id: string | null
  created_at: Date
  recipient_enrollments: number
  active_enrollments: number
  stopped_enrollments: number
  completed_enrollments: number
  provider_accepted_recipients: number
  confirmed_delivered_recipients: number
  bounced_recipients: number
  complained_recipients: number
  human_reply_recipients: number
  positive_reply_recipients: number
  unclassified_human_reply_recipients: number
  send_attempts: number
  attempts_by_state: AttemptCounts
  human_reply_events: number
  reply_events_by_classification: ReplyCounts
}

export type CampaignAnalyticsResult = {
  campaigns: CampaignAnalyticsRow[]
  totals: Omit<
    CampaignAnalyticsRow,
    'campaign_id' | 'campaign_name' | 'campaign_status' | 'current_version_id' | 'created_at'
      | 'attempts_by_state' | 'reply_events_by_classification'
  > & {
    campaigns: number
    attempts_by_state: AttemptCounts
    reply_events_by_classification: ReplyCounts
  }
  campaign_limit: number
  truncated: boolean
  scope: 'current_campaign_versions'
}

function zeroAttemptCounts(): AttemptCounts {
  return Object.fromEntries([
    ...ATTEMPT_STATES.map((state) => [state, 0]),
    ['other', 0],
  ]) as AttemptCounts
}

function zeroReplyCounts(): ReplyCounts {
  return Object.fromEntries([
    ...REPLY_CLASSIFICATIONS.map((classification) => [classification, 0]),
    ['unclassified', 0],
  ]) as ReplyCounts
}

function incrementAttemptState(counts: AttemptCounts, state: string): void {
  if ((ATTEMPT_STATES as readonly string[]).includes(state)) {
    counts[state as AttemptState] += 1
    return
  }
  counts.other += 1
}

function replyClassification(value: string | null | undefined): ReplyClassification | 'unclassified' {
  return value && (REPLY_CLASSIFICATIONS as readonly string[]).includes(value)
    ? value as ReplyClassification
    : 'unclassified'
}

function isHumanReply(reply: GtmReply): boolean {
  return reply.direction === 'inbound'
    && (reply.eventKind === 'human_reply' || reply.eventKind === 'social_reply')
}

function isProviderAccepted(attempt: GtmSendAttempt): boolean {
  return attempt.acceptedAt != null
    || ['accepted', 'delivered', 'bounced', 'complained', 'replied'].includes(attempt.state)
}

function campaignRow(
  campaign: GtmCampaign,
  enrollments: GtmEnrollment[],
  attempts: GtmSendAttempt[],
  replies: GtmReply[],
): CampaignAnalyticsRow {
  const attemptsByState = zeroAttemptCounts()
  const replyEventsByClassification = zeroReplyCounts()
  const providerAccepted = new Set<string>()
  const delivered = new Set<string>()
  const bounced = new Set<string>()
  const complained = new Set<string>()
  const humanReply = new Set<string>()
  const positiveReply = new Set<string>()
  const unclassifiedReply = new Set<string>()

  for (const attempt of attempts) {
    incrementAttemptState(attemptsByState, attempt.state)
    if (isProviderAccepted(attempt)) providerAccepted.add(attempt.enrollmentId)
    if (attempt.deliveredAt != null || attempt.state === 'delivered') delivered.add(attempt.enrollmentId)
    if (attempt.bouncedAt != null || attempt.state === 'bounced') bounced.add(attempt.enrollmentId)
    if (attempt.complainedAt != null || attempt.state === 'complained') complained.add(attempt.enrollmentId)
  }

  let humanReplyEvents = 0
  for (const reply of replies) {
    if (!isHumanReply(reply)) continue
    humanReplyEvents += 1
    humanReply.add(reply.enrollmentId)
    const classification = replyClassification(reply.classification)
    replyEventsByClassification[classification] += 1
    if (classification === 'interested' || classification === 'referral') {
      positiveReply.add(reply.enrollmentId)
    }
    if (classification === 'unclassified') unclassifiedReply.add(reply.enrollmentId)
  }

  return {
    campaign_id: campaign.id,
    campaign_name: campaign.name,
    campaign_status: campaign.status,
    current_version_id: campaign.currentVersionId ?? null,
    created_at: campaign.createdAt,
    recipient_enrollments: enrollments.length,
    active_enrollments: enrollments.filter((row) => row.status === 'active').length,
    stopped_enrollments: enrollments.filter((row) => row.status === 'stopped').length,
    completed_enrollments: enrollments.filter((row) => row.status === 'completed').length,
    provider_accepted_recipients: providerAccepted.size,
    confirmed_delivered_recipients: delivered.size,
    bounced_recipients: bounced.size,
    complained_recipients: complained.size,
    human_reply_recipients: humanReply.size,
    positive_reply_recipients: positiveReply.size,
    unclassified_human_reply_recipients: unclassifiedReply.size,
    send_attempts: attempts.length,
    attempts_by_state: attemptsByState,
    human_reply_events: humanReplyEvents,
    reply_events_by_classification: replyEventsByClassification,
  }
}

export async function getCampaignAnalytics(
  em: CampaignAnalyticsEm,
  ctx: AnalyticsCtx,
  workspaceId: string,
): Promise<CampaignAnalyticsResult> {
  const scope = {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  }
  const campaignPage = await em.find(
    GtmCampaign,
    { ...scope, workspaceId },
    { orderBy: { createdAt: 'desc' }, limit: GTM_CAMPAIGN_ANALYTICS_LIMIT + 1 },
  )
  const truncated = campaignPage.length > GTM_CAMPAIGN_ANALYTICS_LIMIT
  const campaigns = campaignPage.slice(0, GTM_CAMPAIGN_ANALYTICS_LIMIT)
  const campaignIds = campaigns.map((campaign) => campaign.id)

  const enrollments = campaignIds.length === 0
    ? []
    : await em.find(GtmEnrollment, { ...scope, campaignId: { $in: campaignIds } })
  const campaignById = new Map(campaigns.map((campaign) => [campaign.id, campaign]))
  const currentEnrollments = enrollments.filter((enrollment) => {
    const campaign = campaignById.get(enrollment.campaignId)
    return campaign?.currentVersionId != null
      && enrollment.campaignVersionId === campaign.currentVersionId
  })
  const enrollmentIds = currentEnrollments.map((enrollment) => enrollment.id)
  const currentVersionIds = campaigns
    .map((campaign) => campaign.currentVersionId)
    .filter((id): id is string => id != null)

  const [attempts, replies, steps] = enrollmentIds.length === 0
    ? [[], [], []]
    : await Promise.all([
        em.find(GtmSendAttempt, {
          ...scope,
          enrollmentId: { $in: enrollmentIds },
          campaignVersionId: { $in: currentVersionIds },
        }),
        em.find(GtmReply, { ...scope, enrollmentId: { $in: enrollmentIds } }),
        em.find(GtmStep, { ...scope, campaignVersionId: { $in: currentVersionIds } }),
      ])
  const currentAttemptIds = new Set(attempts.map((attempt) => attempt.id))
  const currentStepIds = new Set(steps.map((step) => step.id))
  const currentReplies = replies.filter((reply) => (
    reply.eventKind === 'human_reply'
      ? reply.sendAttemptId != null && currentAttemptIds.has(reply.sendAttemptId)
      : reply.eventKind === 'social_reply'
        ? reply.stepId != null && currentStepIds.has(reply.stepId)
        : false
  ))

  const rows = campaigns.map((campaign) => {
    const campaignEnrollments = currentEnrollments.filter((row) => row.campaignId === campaign.id)
    const ids = new Set(campaignEnrollments.map((row) => row.id))
    return campaignRow(
      campaign,
      campaignEnrollments,
      attempts.filter((row) => ids.has(row.enrollmentId) && row.campaignVersionId === campaign.currentVersionId),
      currentReplies.filter((row) => ids.has(row.enrollmentId)),
    )
  })

  const attemptsByState = zeroAttemptCounts()
  const replyEventsByClassification = zeroReplyCounts()
  const totals = {
    campaigns: rows.length,
    recipient_enrollments: 0,
    active_enrollments: 0,
    stopped_enrollments: 0,
    completed_enrollments: 0,
    provider_accepted_recipients: 0,
    confirmed_delivered_recipients: 0,
    bounced_recipients: 0,
    complained_recipients: 0,
    human_reply_recipients: 0,
    positive_reply_recipients: 0,
    unclassified_human_reply_recipients: 0,
    send_attempts: 0,
    attempts_by_state: attemptsByState,
    human_reply_events: 0,
    reply_events_by_classification: replyEventsByClassification,
  }

  for (const row of rows) {
    totals.recipient_enrollments += row.recipient_enrollments
    totals.active_enrollments += row.active_enrollments
    totals.stopped_enrollments += row.stopped_enrollments
    totals.completed_enrollments += row.completed_enrollments
    totals.provider_accepted_recipients += row.provider_accepted_recipients
    totals.confirmed_delivered_recipients += row.confirmed_delivered_recipients
    totals.bounced_recipients += row.bounced_recipients
    totals.complained_recipients += row.complained_recipients
    totals.human_reply_recipients += row.human_reply_recipients
    totals.positive_reply_recipients += row.positive_reply_recipients
    totals.unclassified_human_reply_recipients += row.unclassified_human_reply_recipients
    totals.send_attempts += row.send_attempts
    totals.human_reply_events += row.human_reply_events
    for (const key of [...ATTEMPT_STATES, 'other'] as const) {
      totals.attempts_by_state[key] += row.attempts_by_state[key]
    }
    for (const key of [...REPLY_CLASSIFICATIONS, 'unclassified'] as const) {
      totals.reply_events_by_classification[key] += row.reply_events_by_classification[key]
    }
  }

  return {
    campaigns: rows,
    totals,
    campaign_limit: GTM_CAMPAIGN_ANALYTICS_LIMIT,
    truncated,
    scope: 'current_campaign_versions',
  }
}
