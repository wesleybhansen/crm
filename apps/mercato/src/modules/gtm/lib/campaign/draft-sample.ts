import {
  GtmCampaign,
  GtmCampaignVersion,
  GtmCandidate,
  GtmEnrollment,
  GtmEvidence,
  GtmPlay,
  GtmRenderedMessage,
  GtmStep,
} from '../../data/entities'
import { GtmCampaignError, type CampaignEm, type GtmCtx, type StepSpec } from './build'
import { computeDraftState, loadCampaign } from './approve'
import { sanitizeMergeValue } from './render'

/*
 * One example recipient's rendered sequence for the hub's campaign review
 * screen (internal campaigns op 'draft-sample'). Read-only.
 *
 * Which copy is sampled:
 * - An approved campaign (current_version_id set) samples the FROZEN rows:
 *   GtmStep + GtmEnrollment + GtmRenderedMessage of the current version, so
 *   the sample is exactly what will be sent.
 * - A campaign still in draft has no enrollments yet, so the sample falls
 *   back to computeDraftState() (the same read-only render the 'draft-state'
 *   op returns) and reports version_id / enrollment_id as null. Passing an
 *   enrollmentId against a draft is an opaque 404: no such row exists.
 *
 * Merge-field spans. The renderer (lib/campaign/render.ts) substitutes
 * {{first_name}} / {{company}} / {{signal}} / {{why_now}} in a single regex
 * pass and records no positions, and frozen rows, AI drafts, and manual
 * overrides carry no template to re-render with sentinel markers. Spans are
 * therefore located by value: the merge values are rebuilt with the
 * renderer's own sanitizeMergeValue() rules (first token of a person's name,
 * company or the company's own name, top-confidence evidence claim, the
 * play's why_now) and each value is searched in the rendered text, longest
 * value first, on word boundaries, without overlap. A value that also
 * appears verbatim in the fixed template copy is highlighted as well, which
 * is acceptable for a preview highlight; values shorter than two characters
 * are never marked.
 */

export const MERGE_SPAN_FIELDS = ['first_name', 'company', 'signal', 'why_now'] as const
export type MergeSpanField = (typeof MERGE_SPAN_FIELDS)[number]
export type MergeValues = Record<MergeSpanField, string>

export type MergeSpan = { start: number; end: number; field: MergeSpanField }

export type DraftSampleStep = {
  step_index: number
  step_key: string | null
  channel: string
  mode: string
  wait_rule: string
  subject: string | null
  body: string | null
  spans: MergeSpan[]
  subject_spans: MergeSpan[]
}

export type CampaignDraftSample = {
  campaign_id: string
  version_id: string | null
  enrollment_id: string | null
  candidate_id: string
  source: 'approved_version' | 'draft'
  recipient: { name: string | null; company: string | null; title: string | null }
  steps: DraftSampleStep[]
}

const MIN_SPAN_VALUE_LENGTH = 2
const WORD_CHAR = /[\p{L}\p{N}]/u

function boundaryOk(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text[start - 1] : ''
  const after = end < text.length ? text[end] : ''
  return !(before && WORD_CHAR.test(before)) && !(after && WORD_CHAR.test(after))
}

export function computeMergeSpans(text: string | null | undefined, values: MergeValues): MergeSpan[] {
  if (!text) return []
  const candidates = MERGE_SPAN_FIELDS
    .map((field) => ({ field, value: values[field] ?? '' }))
    .filter((entry) => entry.value.length >= MIN_SPAN_VALUE_LENGTH)
    // Longest first so "Synthetic Co" wins over a first name "Synthetic"
    // that sits inside it; ties keep the field order above.
    .sort((a, b) => b.value.length - a.value.length)
  const spans: MergeSpan[] = []
  const overlaps = (start: number, end: number) =>
    spans.some((span) => start < span.end && end > span.start)
  for (const { field, value } of candidates) {
    let from = 0
    while (from <= text.length - value.length) {
      const start = text.indexOf(value, from)
      if (start === -1) break
      const end = start + value.length
      if (boundaryOk(text, start, end) && !overlaps(start, end)) spans.push({ start, end, field })
      from = start + 1
    }
  }
  return spans.sort((a, b) => a.start - b.start || a.end - b.end)
}

// Plain-English wait rule for one step in its ordered sequence. An enrollment
// stops on the first reply (execution stop reasons email_reply /
// social_reply), so every step after the first is conditional on silence.
export function describeWaitRule(
  step: { order: number; delay_days: number; dependency_kind: string },
  isFirst: boolean,
): string {
  const days = Math.max(0, Math.round(step.delay_days || 0))
  if (isFirst && days === 0) return 'At launch'
  const base = days === 0 ? 'Same day' : `${days} day${days === 1 ? '' : 's'}`
  if (step.dependency_kind === 'linkedin_connection_accepted') {
    return `${base}, after the connection request is accepted`
  }
  return `${base}, if no reply`
}

// Mirrors renderMessages() in lib/campaign/render.ts so the located values
// are byte-for-byte what the renderer inserted.
export async function mergeValuesForCandidate(
  em: CampaignEm,
  ctx: GtmCtx,
  playId: string,
  candidate: GtmCandidate | null,
): Promise<MergeValues> {
  const play = await em.findOne(GtmPlay, {
    id: playId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  const whyNow = sanitizeMergeValue(play?.whyNow ?? null)
  if (!candidate) return { first_name: '', company: '', signal: '', why_now: whyNow }

  const evidence = await em.find(GtmEvidence, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    candidateId: candidate.id,
    deletedAt: null,
  })
  let top: { claim: string; confidence: number } | null = null
  for (const row of evidence) {
    const confidence = Number(row.confidence ?? 0)
    if (!top || confidence > top.confidence) top = { claim: row.claim, confidence }
  }
  const identity = (candidate.identity ?? {}) as Record<string, unknown>
  const name = sanitizeMergeValue(identity.name)
  return {
    first_name: candidate.entityKind === 'person' ? name.split(' ')[0] || '' : '',
    company: sanitizeMergeValue(identity.company) || (candidate.entityKind === 'company' ? name : ''),
    signal: sanitizeMergeValue(top?.claim ?? null),
    why_now: whyNow,
  }
}

function recipientShape(candidate: GtmCandidate | null): CampaignDraftSample['recipient'] {
  const identity = (candidate?.identity ?? {}) as Record<string, unknown>
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)
  return { name: text(identity.name), company: text(identity.company), title: text(identity.title) }
}

function stepShape(
  index: number,
  step: { key: string | null; order: number; channel: string; mode: string; delay_days: number; dependency_kind: string },
  message: { subject: string | null; body: string | null } | null,
  values: MergeValues,
): DraftSampleStep {
  return {
    step_index: index,
    step_key: step.key,
    channel: step.channel,
    mode: step.mode,
    wait_rule: describeWaitRule(step, index === 0),
    subject: message?.subject ?? null,
    body: message?.body ?? null,
    spans: computeMergeSpans(message?.body, values),
    subject_spans: computeMergeSpans(message?.subject, values),
  }
}

export type DraftSampleInput = { campaignId: string; enrollmentId?: string | null }

export async function getCampaignDraftSample(
  em: CampaignEm,
  ctx: GtmCtx,
  input: DraftSampleInput,
): Promise<CampaignDraftSample> {
  const campaign = await loadCampaign(em, ctx, input.campaignId)
  const scope = { organizationId: ctx.organizationId, tenantId: ctx.tenantId }

  const version = campaign.currentVersionId
    ? await em.findOne(GtmCampaignVersion, { ...scope, id: campaign.currentVersionId, campaignId: campaign.id })
    : null

  if (!version) return sampleFromDraft(em, ctx, campaign, input.enrollmentId ?? null)

  const enrollments = await em.find(
    GtmEnrollment,
    { ...scope, campaignId: campaign.id, campaignVersionId: version.id, deletedAt: null },
    { orderBy: { createdAt: 'asc', id: 'asc' } },
  )
  const rendered = await em.find(GtmRenderedMessage, {
    ...scope,
    campaignVersionId: version.id,
    deletedAt: null,
  })
  const renderedByEnrollment = new Map<string, GtmRenderedMessage[]>()
  for (const row of rendered) {
    const list = renderedByEnrollment.get(row.enrollmentId) ?? []
    list.push(row)
    renderedByEnrollment.set(row.enrollmentId, list)
  }

  let enrollment: GtmEnrollment | null = null
  if (input.enrollmentId) {
    enrollment = enrollments.find((row) => row.id === input.enrollmentId) ?? null
    if (!enrollment) throw new GtmCampaignError('enrollment_not_found', 'Enrollment not found')
  } else {
    enrollment = enrollments.find((row) => (renderedByEnrollment.get(row.id)?.length ?? 0) > 0) ?? null
    if (!enrollment) {
      throw new GtmCampaignError(
        'sample_unavailable',
        'No recipient in the current version has a rendered message yet',
      )
    }
  }

  const steps = await em.find(
    GtmStep,
    { ...scope, campaignVersionId: version.id, deletedAt: null },
    { orderBy: { order: 'asc', id: 'asc' } },
  )
  const candidate = await em.findOne(GtmCandidate, { ...scope, id: enrollment.candidateId })
  const values = await mergeValuesForCandidate(em, ctx, campaign.playId, candidate)
  const messagesByStep = new Map(
    (renderedByEnrollment.get(enrollment.id) ?? []).map((row) => [row.stepId, row]),
  )

  return {
    campaign_id: campaign.id,
    version_id: version.id,
    enrollment_id: enrollment.id,
    candidate_id: enrollment.candidateId,
    source: 'approved_version',
    recipient: recipientShape(candidate),
    steps: steps.map((step, index) => {
      const window = (step.sendWindow ?? {}) as Record<string, unknown>
      const message = messagesByStep.get(step.id)
      return stepShape(
        index,
        {
          key: typeof window.step_key === 'string' ? window.step_key : null,
          order: step.order,
          channel: step.channel,
          mode: step.mode,
          delay_days: step.delayDays,
          dependency_kind: step.dependencyKind,
        },
        message ? { subject: message.subject ?? null, body: message.bodyText ?? null } : null,
        values,
      )
    }),
  }
}

async function sampleFromDraft(
  em: CampaignEm,
  ctx: GtmCtx,
  campaign: GtmCampaign,
  enrollmentId: string | null,
): Promise<CampaignDraftSample> {
  // A draft has no enrollment rows, so a caller naming one gets the same
  // opaque answer as a foreign or deleted row.
  if (enrollmentId) throw new GtmCampaignError('enrollment_not_found', 'Enrollment not found')

  const draft = await computeDraftState(em, ctx, campaign)
  const recipient = draft.recipients.find((row) =>
    draft.rendered.some((preview) => preview.candidateId === row.candidateId),
  )
  if (!recipient) {
    throw new GtmCampaignError(
      'sample_unavailable',
      'No recipient in the draft has a rendered message yet',
    )
  }

  const candidate = await em.findOne(GtmCandidate, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    id: recipient.candidateId,
  })
  const values = await mergeValuesForCandidate(em, ctx, campaign.playId, candidate)
  const previews = draft.rendered.filter((preview) => preview.candidateId === recipient.candidateId)
  const ordered = [...draft.steps].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))

  return {
    campaign_id: campaign.id,
    version_id: null,
    enrollment_id: null,
    candidate_id: recipient.candidateId,
    source: 'draft',
    recipient: recipientShape(candidate),
    steps: ordered.map((step: StepSpec, index) => {
      const preview = previews.find((row) => row.stepKey === step.key)
      return stepShape(
        index,
        {
          key: step.key,
          order: step.order,
          channel: step.channel,
          mode: step.mode,
          delay_days: step.delay_days,
          dependency_kind: step.dependency_kind,
        },
        preview ? { subject: preview.subject, body: preview.bodyText } : null,
        values,
      )
    }),
  }
}
