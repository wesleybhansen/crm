import crypto from 'crypto'
import type { CampaignEm, CampaignTemplate, GtmCtx, StepSpec } from './build'
import {
  MAX_EMAIL_BODY_WORDS,
  MIN_EMAIL_BODY_WORDS,
  parseStoredAiDrafts,
  templateForEmailStep,
  type StoredAiDraft,
} from './build'
import { GtmCampaign, GtmCandidate, GtmEvidence, GtmPlay } from '../../data/entities'

/*
 * Per-recipient template rendering (SPEC-066 section 14 Tranche 5).
 *
 * Deterministic merge-field substitution over a single {subject, body}
 * template. Supported fields and their GROUNDED sources:
 *
 *   {{first_name}}  first token of candidate identity.name
 *   {{company}}     candidate identity.company (or the name itself for a
 *                   company-kind candidate)
 *   {{signal}}      the candidate's highest-confidence evidence claim
 *   {{why_now}}     the play's why_now line (part of the play the user
 *                   approved, grounded by import)
 *
 * A missing field renders the honest review token [[missing:field]] and
 * flags the row needs_review; a fact is NEVER invented to fill a hole.
 *
 * Injection safety: candidate- and evidence-sourced text is DATA. Every
 * merge value is sanitized by stripping curly braces before substitution, so
 * a candidate whose name or evidence contains "{{evil}}" (or any template-
 * like sequence) can never introduce a token that expands. Substitution is
 * single-pass on the template only; rendered output is scanned and any
 * remaining {{...}} token (an unsupported field typed into the template)
 * flags the row for review instead of silently shipping.
 *
 * content_hash = sha256(subject + '\n' + body_html), the per-message hash
 * frozen onto gtm_rendered_messages at approval and folded into the draft
 * content hash (approve.ts).
 *
 * Compliance footer: every rendered body (html + text) ends with a
 * standardized footer carrying the sending ORG's business postal address
 * (CAN-SPAM: the sender is the customer's org, not Noli; read from workspace
 * settings and passed in by the caller) and an unsubscribe line holding the
 * literal token [[unsubscribe_url]]. The footer, address included, is part
 * of the frozen rendered content and therefore hash-covered. The token stays
 * a token in the stored row: the execution layer substitutes the real
 * per-enrollment URL on a copy at send time (lib/execute/send.ts). A missing
 * postal address renders the honest [[missing:postal_address]] token and
 * flags the row for review; approval is blocked separately until the address
 * is set (lib/campaign/approve.ts).
 */

export type RenderedPreview = {
  candidateId: string
  stepKey: string
  stepOrder: number
  subject: string
  bodyHtml: string
  bodyText: string
  contentHash: string
  needsReview: boolean
  missingFields: string[]
  wordCount: number
  qualityIssues: string[]
  // How the copy was produced: the deterministic merge template, or an AI
  // draft written in the workspace's locked voice (lib/campaign/ai-draft.ts).
  // Both freeze identically; provenance is display metadata for the reviewer.
  provenance: 'template' | 'ai'
}

const MERGE_FIELDS = ['first_name', 'company', 'signal', 'why_now'] as const
type MergeField = (typeof MERGE_FIELDS)[number]

const MERGE_TOKEN = /\{\{\s*(first_name|company|signal|why_now)\s*\}\}/g
const ANY_TOKEN = /\{\{[^}]*\}\}/

// Literal token stored in the frozen rendered content; replaced with the real
// per-enrollment unsubscribe URL only on the send-time copy (execute/send.ts).
export const UNSUBSCRIBE_URL_TOKEN = '[[unsubscribe_url]]'

export function substituteUnsubscribeUrl(content: string, url: string): string {
  return content.split(UNSUBSCRIBE_URL_TOKEN).join(url)
}

export function messageContentHash(
  subject: string,
  bodyHtml: string,
  bodyText = '',
  stepKey = 'email_1',
): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ schema: 'gtm-message-v2', step_key: stepKey, subject, body_html: bodyHtml, body_text: bodyText }))
    .digest('hex')
}

export function countMessageWords(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length
}

function normalizedWordSet(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/\[\[[^\]]+\]\]/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter((word) => word.length > 2),
  )
}

export function messageSimilarity(left: string, right: string): number {
  const a = normalizedWordSet(left)
  const b = normalizedWordSet(right)
  if (a.size === 0 && b.size === 0) return 1
  let intersection = 0
  for (const word of a) if (b.has(word)) intersection += 1
  return intersection / Math.max(1, a.size + b.size - intersection)
}

export function messagesAreMateriallyDistinct(left: string, right: string): boolean {
  const leftCore = left.split('\n\n--\n')[0]
  const rightCore = right.split('\n\n--\n')[0]
  const normalizedLeft = leftCore.replace(/\s+/g, ' ').trim().toLowerCase()
  const normalizedRight = rightCore.replace(/\s+/g, ' ').trim().toLowerCase()
  return normalizedLeft !== normalizedRight && messageSimilarity(leftCore, rightCore) < 0.72
}

// Candidate-sourced text is data, never template: strip anything that could
// read as a merge token and collapse whitespace.
export function sanitizeMergeValue(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim()
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

type MergeValues = Partial<Record<MergeField, string>>

function substitute(
  template: string,
  values: MergeValues,
  missing: Set<string>,
  transform: (value: string) => string,
): string {
  return template.replace(MERGE_TOKEN, (_match, field: MergeField) => {
    const value = values[field]
    if (!value) {
      missing.add(field)
      return `[[missing:${field}]]`
    }
    return transform(value)
  })
}

// Append the standardized CAN-SPAM footer (sending org's postal address +
// unsubscribe token), run the unresolved-token review check, and produce the
// final hashed preview. Shared by the template and AI-draft render paths so
// the footer, hashing, and review semantics are identical regardless of how
// the core copy was produced.
function finalizeRender(
  candidateId: string,
  step: Pick<StepSpec, 'key' | 'order'>,
  subject: string,
  bodyTextCore: string,
  bodyHtmlCore: string,
  postalAddress: string | null,
  missing: Set<string>,
  provenance: 'template' | 'ai',
): RenderedPreview {
  const address = typeof postalAddress === 'string' && postalAddress.trim() ? postalAddress.trim() : null
  if (!address) missing.add('postal_address')
  const addressText = address ?? '[[missing:postal_address]]'
  const bodyText = `${bodyTextCore}\n\n--\n${addressText}\nUnsubscribe: ${UNSUBSCRIBE_URL_TOKEN}`
  const bodyHtml = `${bodyHtmlCore}<br/><br/>--<br/>${address ? escapeHtml(address) : addressText}<br/>Unsubscribe: ${UNSUBSCRIBE_URL_TOKEN}`

  // Unsupported {{...}} tokens left in the output (typed into the template or,
  // for AI copy, defensively neutralized upstream) force a human review pass.
  const unresolved = ANY_TOKEN.test(subject) || ANY_TOKEN.test(bodyText)
  const wordCount = countMessageWords(bodyTextCore)
  const qualityIssues: string[] = []
  if (wordCount < MIN_EMAIL_BODY_WORDS) qualityIssues.push('body_too_short')
  if (wordCount > MAX_EMAIL_BODY_WORDS) qualityIssues.push('body_too_long')
  if (unresolved) qualityIssues.push('unresolved_template_token')

  return {
    candidateId,
    stepKey: step.key,
    stepOrder: step.order,
    subject,
    bodyHtml,
    bodyText,
    contentHash: messageContentHash(subject, bodyHtml, bodyText, step.key),
    needsReview: missing.size > 0 || qualityIssues.length > 0,
    missingFields: [...missing].sort(),
    wordCount,
    qualityIssues,
    provenance,
  }
}

export function renderForCandidate(
  template: CampaignTemplate,
  values: MergeValues,
  candidateId: string,
  postalAddress: string | null = null,
  step: Pick<StepSpec, 'key' | 'order'> = { key: 'email_1', order: 1 },
): RenderedPreview {
  const missing = new Set<string>()
  const identity = (value: string) => value
  const subject = substitute(template.subject, values, missing, identity)
  const bodyText = substitute(template.body, values, missing, identity)
  // Escape the template body first (braces survive escaping), substitute
  // HTML-escaped values, then turn newlines into breaks.
  const bodyHtml = substitute(escapeHtml(template.body), values, missing, escapeHtml).replace(
    /\n/g,
    '<br/>',
  )
  return finalizeRender(candidateId, step, subject, bodyText, bodyHtml, postalAddress, missing, 'template')
}

// Render a stored AI draft (lib/campaign/ai-draft.ts). The stored body_text is
// treated as DATA: braces are neutralized so it can never smuggle a merge
// token, then it flows through the SAME footer + hash path as a template
// render. An AI draft therefore freezes into an approved version identically.
export function renderAiDraftForCandidate(
  draft: StoredAiDraft,
  candidateId: string,
  postalAddress: string | null = null,
  step: Pick<StepSpec, 'key' | 'order'> = { key: 'email_1', order: 1 },
): RenderedPreview {
  const missing = new Set<string>()
  const subject = draft.subject.replace(/[{}]/g, '')
  const bodyTextCore = draft.body_text.replace(/[{}]/g, '')
  const bodyHtmlCore = escapeHtml(bodyTextCore).replace(/\n/g, '<br/>')
  return finalizeRender(candidateId, step, subject, bodyTextCore, bodyHtmlCore, postalAddress, missing, 'ai')
}

export async function renderMessages(
  em: CampaignEm,
  ctx: GtmCtx,
  campaign: GtmCampaign,
  candidates: GtmCandidate[],
  template: CampaignTemplate,
  // The sending org's business postal address from workspace settings
  // (lib/workspace-settings.ts), passed in by the caller.
  postalAddress: string | null = null,
  steps: StepSpec[] = [{
    key: 'email_1',
    order: 1,
    channel: 'email',
    mode: 'automated_email',
    delay_days: 0,
    depends_on_key: null,
    dependency_kind: 'none',
    social_action: null,
  }],
): Promise<RenderedPreview[]> {
  const play = await em.findOne(GtmPlay, {
    id: campaign.playId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  const whyNow = sanitizeMergeValue(play?.whyNow ?? null)

  // Opt-in AI drafts stored per candidate on the draft jsonb: a recipient with
  // a stored draft renders from it (voice-grounded copy), everyone else stays
  // on the deterministic template. Both paths append the same footer + hash.
  const aiDrafts = parseStoredAiDrafts(campaign)

  const candidateIds = candidates.map((candidate) => candidate.id)
  const evidence = candidateIds.length
    ? await em.find(GtmEvidence, {
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        candidateId: { $in: candidateIds },
        deletedAt: null,
      })
    : []
  // Highest-confidence claim per candidate; ties resolved by insertion order
  // so rendering stays deterministic.
  const topClaim = new Map<string, { claim: string; confidence: number }>()
  for (const row of evidence) {
    const confidence = Number(row.confidence ?? 0)
    const current = topClaim.get(row.candidateId)
    if (!current || confidence > current.confidence) {
      topClaim.set(row.candidateId, { claim: row.claim, confidence })
    }
  }

  const emailSteps = steps
    .filter((step) => step.mode === 'automated_email' && step.channel === 'email')
    .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
  const rendered: RenderedPreview[] = []
  for (const candidate of candidates) {
    const identity = (candidate.identity ?? {}) as Record<string, unknown>
    const name = sanitizeMergeValue(identity.name)
    const values: MergeValues = {
      first_name: candidate.entityKind === 'person' ? name.split(' ')[0] || '' : '',
      company:
        sanitizeMergeValue(identity.company) ||
        (candidate.entityKind === 'company' ? name : ''),
      signal: sanitizeMergeValue(topClaim.get(candidate.id)?.claim ?? null),
      why_now: whyNow,
    }
    const candidateRows = emailSteps.map((step) => {
      const stored = aiDrafts[candidate.id]?.[step.key]
      if (stored) {
        return renderAiDraftForCandidate(stored, candidate.id, postalAddress, step)
      }
      return renderForCandidate(
        templateForEmailStep(template, step),
        values,
        candidate.id,
        postalAddress,
        step,
      )
    })
    for (let left = 0; left < candidateRows.length; left += 1) {
      for (let right = left + 1; right < candidateRows.length; right += 1) {
        if (messagesAreMateriallyDistinct(candidateRows[left].bodyText, candidateRows[right].bodyText)) continue
        const issue = `step_not_distinct:${candidateRows[left].stepKey}:${candidateRows[right].stepKey}`
        if (!candidateRows[left].qualityIssues.includes(issue)) candidateRows[left].qualityIssues.push(issue)
        if (!candidateRows[right].qualityIssues.includes(issue)) candidateRows[right].qualityIssues.push(issue)
        candidateRows[left].needsReview = true
        candidateRows[right].needsReview = true
      }
    }
    rendered.push(...candidateRows)
  }
  return rendered
}
