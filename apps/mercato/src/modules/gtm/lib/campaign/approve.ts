import crypto from 'crypto'
import { UniqueConstraintViolationException } from '@mikro-orm/core'
import {
  GtmCampaignError,
  parseAssetRefs,
  parseDraftMix,
  parseSettings,
  type AssetRef,
  type CampaignEm,
  type CampaignSettings,
  type CampaignTemplate,
  type GtmCtx,
  type StepSpec,
} from './build'
import { computeExclusions, type ComputeExclusionsResult } from './exclusions'
import { renderMessages, type RenderedPreview } from './render'
import { readWorkspacePostalAddress } from '../workspace-settings'
import { projectCampaignCredits, type CreditProjection } from './project-credits'
import { computeExecutionEligibility, type EligibilityResult } from '../eligibility'
import {
  GtmAuditEvent,
  GtmCampaign,
  GtmCampaignVersion,
  GtmCandidate,
  GtmEnrollment,
  GtmPlay,
  GtmRenderedMessage,
  GtmResearchRun,
  GtmStep,
  GtmWorkspace,
} from '../../data/entities'
import { EmailConnection } from '../../../email/data/schema'

/*
 * Immutable batch approval (SPEC-066 sections 4, 7, 8, 12, 14 Tranche 5).
 *
 * The draft (jsonb on gtm_campaigns) is recomputed into a canonical,
 * deterministic object whose sha256 (sorted keys) is the draft content hash.
 * The SAME computation backs the draft-state preview and the approval
 * freeze, so the hash the reviewer saw is exactly what gets approved:
 * approve rejects 'stale_draft' when the caller's expected hash no longer
 * matches (concurrent edit, suppression change, play change, new
 * candidates).
 *
 * On approval, in one transaction: play eligibility is rechecked (section 7
 * boundary 4: a strategy_only play cannot be approved even by direct call
 * with raw ids), exclusions are recomputed (section 8: a suppression added
 * between render and approve drops the recipient), and the frozen rows are
 * created: GtmCampaignVersion (version = max + 1, immutable), GtmStep rows
 * for the version, GtmEnrollment rows (unique (campaign, candidate),
 * race-safe: a unique violation is treated as already-enrolled and the
 * existing row is repointed at the new version), GtmRenderedMessage rows
 * (unique (enrollment, step)), campaign flipped to 'approved' with
 * current_version_id set, one audit event.
 *
 * Invalidation: any draft-mutating operation on an approved campaign
 * (template edit, manual exclude/include, settings change, play
 * geography/market change) calls invalidateCurrentVersion, which stamps
 * invalidated_at/reason on the version row WITHOUT touching its snapshot or
 * content hash (the version stays an immutable historical record), returns
 * the campaign to 'draft', clears current_version_id, and audits.
 */

// ---------------------------------------------------------------------------
// Canonical JSON (sorted keys) -> sha256
// ---------------------------------------------------------------------------

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
  return `{${parts.join(',')}}`
}

export function canonicalHash(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalize(value)).digest('hex')
}

export function approvalCanonicalSnapshot(snapshot: unknown): Record<string, unknown> | null {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null
  const canonical = { ...(snapshot as Record<string, unknown>) }
  delete canonical.ids
  delete canonical.version
  return canonical
}

export function approvalEnvelopeMatches(snapshot: unknown, contentHash: string): boolean {
  const canonical = approvalCanonicalSnapshot(snapshot)
  return canonical != null && canonicalHash(canonical) === contentHash
}

// ---------------------------------------------------------------------------
// Draft state (shared by the draft-state preview op and the approval freeze)
// ---------------------------------------------------------------------------

export type DraftRecipient = {
  candidateId: string
  address: string
  addressHash: string
  contactId: string | null
  contactPointId: string
}

export type ApprovedSender = {
  mailbox_connection_id: string
  provider: string
  email_address: string
  user_id: string
  purpose: string | null
  updated_at: string
  fingerprint: string
}

export type CampaignDraftState = {
  campaign: GtmCampaign
  play: GtmPlay
  eligibility: EligibilityResult
  steps: StepSpec[]
  template: CampaignTemplate
  settings: CampaignSettings
  // accepted candidates of the campaign's play considered for enrollment
  consideredCandidateIds: string[]
  exclusions: ComputeExclusionsResult
  recipients: DraftRecipient[]
  // rendered previews for recipients only (frozen at approval)
  rendered: RenderedPreview[]
  // workspace settings.postal_address (CAN-SPAM sender address; null = unset,
  // which blocks approval and lets the UI prompt from draft-state)
  postalAddress: string | null
  sender: ApprovedSender | null
  // AMS asset references attached to the draft (frozen at approval)
  assetRefs: AssetRef[]
  projectedCredits: CreditProjection
  // deterministic canonical draft object; contentHash = sha256 of it
  canonical: Record<string, unknown>
  contentHash: string
}

export async function loadCampaign(
  em: CampaignEm,
  ctx: GtmCtx,
  campaignId: string,
): Promise<GtmCampaign> {
  const campaign = await em.findOne(GtmCampaign, {
    id: campaignId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!campaign) throw new GtmCampaignError('campaign_not_found', 'Campaign not found')
  return campaign
}

export async function computeDraftState(
  em: CampaignEm,
  ctx: GtmCtx,
  campaign: GtmCampaign,
): Promise<CampaignDraftState> {
  const play = await em.findOne(GtmPlay, {
    id: campaign.playId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!play) throw new GtmCampaignError('play_not_found', 'The campaign play no longer exists')

  // The org's business postal address (workspace settings): rendered into
  // every compliance footer and required for approval (CAN-SPAM; the sender
  // is the customer's org, not Noli).
  const workspace = await em.findOne(GtmWorkspace, {
    id: campaign.workspaceId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  const postalAddress = readWorkspacePostalAddress(workspace)

  // Recomputed from the play row's CURRENT state, never from stored columns
  // or caller input (section 7).
  const eligibility = computeExecutionEligibility({
    market_type: play.marketType ?? null,
    geography: play.geography ?? null,
  })

  const mix = parseDraftMix(campaign)
  const settings = parseSettings(campaign)
  const senderConnection = settings.mailbox_connection_id
    ? await em.findOne(EmailConnection, {
        id: settings.mailbox_connection_id,
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        deletedAt: null,
      })
    : null
  const senderMaterial = senderConnection && senderConnection.isActive
    ? {
        mailbox_connection_id: senderConnection.id,
        provider: senderConnection.provider,
        email_address: senderConnection.emailAddress.trim().toLowerCase(),
        user_id: senderConnection.userId,
        purpose: senderConnection.purpose ?? null,
        updated_at: senderConnection.updatedAt.toISOString(),
      }
    : null
  const sender: ApprovedSender | null = senderMaterial
    ? { ...senderMaterial, fingerprint: canonicalHash(senderMaterial) }
    : null

  // Recipients pool: accepted candidates sourced by this play's research
  // runs inside the campaign workspace.
  const runs = await em.find(GtmResearchRun, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    playId: campaign.playId,
    deletedAt: null,
  })
  const runIds = new Set(runs.map((run) => run.id))
  const candidates = (
    await em.find(GtmCandidate, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      workspaceId: campaign.workspaceId,
      fitStatus: 'accepted',
      deletedAt: null,
    })
  )
    .filter((candidate) => runIds.has(candidate.researchRunId))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const candidateIds = candidates.map((candidate) => candidate.id)

  // Section 8 enforcement at build: suppression + legacy unsubscribes +
  // duplicate-across-campaigns.
  const exclusions = await computeExclusions(em, ctx, {
    workspaceId: campaign.workspaceId,
    candidateIds,
    channel: 'email',
    excludeCampaignId: campaign.id,
    allowDuplicates: settings.duplicate_override,
  })

  // Manual exclusion overrides (draft-level, reason 'manual').
  const manual = new Set(mix.manual_exclusions)
  for (const entry of exclusions.entries) {
    if (!entry.excluded && manual.has(entry.candidateId)) {
      entry.excluded = true
      entry.reason = 'manual'
      entry.source = 'manual'
      exclusions.summary.excluded += 1
      exclusions.summary.byReason.manual = (exclusions.summary.byReason.manual ?? 0) + 1
    }
  }

  const recipientCandidates = candidates.filter(
    (candidate) => !(exclusions.byCandidate.get(candidate.id)?.excluded ?? true),
  )
  const recipients: DraftRecipient[] = recipientCandidates.map((candidate) => {
    const entry = exclusions.byCandidate.get(candidate.id)!
    return {
      candidateId: candidate.id,
      address: entry.address as string,
      addressHash: entry.addressHash as string,
      contactId: candidate.promotedContactId ?? null,
      contactPointId: entry.contactPointId as string,
    }
  })

  const rendered = await renderMessages(
    em,
    ctx,
    campaign,
    recipientCandidates,
    mix.template,
    postalAddress,
    mix.steps,
  )
  const assetRefs = parseAssetRefs(campaign)
  const projectedCredits = projectCampaignCredits({
    recipientCount: recipients.length,
    steps: mix.steps,
  })

  const canonical: Record<string, unknown> = {
    campaign_id: campaign.id,
    play_id: play.id,
    eligibility: eligibility.execution_eligibility,
    template: { subject: mix.template.subject, body: mix.template.body },
    steps: mix.steps.map((step) => ({
      key: step.key,
      order: step.order,
      channel: step.channel,
      mode: step.mode,
      delay_days: step.delay_days,
      depends_on_key: step.depends_on_key,
      dependency_kind: step.dependency_kind,
      social_action: step.social_action,
    })),
    settings: {
      daily_cap: settings.daily_cap,
      send_window: settings.send_window,
      jitter_minutes: settings.jitter_minutes,
      sender_mailbox_id: settings.mailbox_connection_id,
      sender,
      duplicate_override: settings.duplicate_override,
      // CAN-SPAM sender address frozen into the snapshot: the reviewer
      // approves the exact footer address, and setting or changing it
      // invalidates the reviewed draft hash.
      postal_address: postalAddress,
    },
    recipients: recipients.map((recipient) => ({
      candidate_id: recipient.candidateId,
      address_hash: recipient.addressHash,
      contact_id: recipient.contactId,
      contact_point_id: recipient.contactPointId,
    })),
    rendered: [...rendered]
      .sort((a, b) =>
        a.candidateId.localeCompare(b.candidateId)
        || a.stepOrder - b.stepOrder
        || a.stepKey.localeCompare(b.stepKey),
      )
      .map((row) => ({
        candidate_id: row.candidateId,
        step_key: row.stepKey,
        step_order: row.stepOrder,
        content_hash: row.contentHash,
        needs_review: row.needsReview,
        missing_fields: row.missingFields,
        word_count: row.wordCount,
        quality_issues: row.qualityIssues,
      })),
    exclusions: exclusions.entries
      .filter((entry) => entry.excluded)
      .map((entry) => ({
        candidate_id: entry.candidateId,
        reason: entry.reason,
        source: entry.source,
        address_hash: entry.addressHash,
      })),
    // AMS asset references: frozen into the snapshot at approval so a later
    // channel_mix edit or an AMS unpublish never changes an approved version
    // (asset-handoff contract item 4).
    asset_refs: assetRefs.map((ref) => ({
      id: ref.id,
      kind: ref.kind,
      title: ref.title,
      published_url: ref.publishedUrl,
      frozen_url: ref.frozen_url,
    })),
    projected_credits: projectedCredits.projected_credits,
  }

  return {
    campaign,
    play,
    eligibility,
    steps: mix.steps,
    template: mix.template,
    settings,
    consideredCandidateIds: candidateIds,
    exclusions,
    recipients,
    rendered,
    postalAddress,
    sender,
    assetRefs,
    projectedCredits,
    canonical,
    contentHash: canonicalHash(canonical),
  }
}

// ---------------------------------------------------------------------------
// Approval freeze
// ---------------------------------------------------------------------------

export type ApproveCampaignResult = {
  campaign: GtmCampaign
  version: GtmCampaignVersion
  alreadyApproved: boolean
  contentHash: string
}

export async function approveCampaign(
  em: CampaignEm,
  ctx: GtmCtx,
  input: { campaignId: string; expectedContentHash: string },
): Promise<ApproveCampaignResult> {
  const campaign = await loadCampaign(em, ctx, input.campaignId)

  // A LAUNCHED campaign is never re-approvable. launchCampaign sets status
  // 'active', which fell straight through the double-approve guard below
  // (that guard only recognises 'approved'), so a replayed re-approve minted
  // a second version, repointed every
  // enrollment at it, silently deactivated the running campaign, and armed a
  // duplicate send batch.
  //
  // Editing a live campaign is still supported and unchanged: the edit ops go
  // through mutateDraft -> invalidateCurrentVersion, which puts the campaign
  // back to 'draft' first. This only rejects re-approving something that is
  // still live.
  if (campaign.status !== 'draft' && campaign.status !== 'in_review') {
    if (!(campaign.status === 'approved' && campaign.currentVersionId)) {
      throw new GtmCampaignError(
        'campaign_not_editable',
        `Campaign status '${campaign.status}' cannot be approved; invalidate the current version first`,
      )
    }
  }

  // Double-approve: a second approve carrying the hash of the live approved
  // version is idempotent and returns the existing version; anything else
  // against an approved campaign is a stale draft.
  if (campaign.status === 'approved' && campaign.currentVersionId) {
    const current = await em.findOne(GtmCampaignVersion, {
      id: campaign.currentVersionId,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
    })
    if (current && !current.invalidatedAt) {
      if (input.expectedContentHash === current.contentHash) {
        return {
          campaign,
          version: current,
          alreadyApproved: true,
          contentHash: current.contentHash,
        }
      }
      throw new GtmCampaignError(
        'stale_draft',
        'Campaign is already approved with different content; invalidate the current version to edit',
      )
    }
  }

  const draft = await computeDraftState(em, ctx, campaign)

  // Section 7 boundary 4: the approval freeze binds to the play's current
  // computed eligibility. Direct calls with raw ids cannot bypass this.
  if (draft.eligibility.execution_eligibility !== 'executable') {
    throw new GtmCampaignError('play_not_executable', draft.eligibility.eligibility_reason)
  }

  // Concurrent-edit guard: the reviewer approves exactly what they saw.
  if (input.expectedContentHash !== draft.contentHash) {
    throw new GtmCampaignError(
      'stale_draft',
      'The draft changed since it was reviewed; reload the draft state and approve again',
    )
  }

  if (draft.recipients.length === 0) {
    throw new GtmCampaignError('no_recipients', 'No eligible recipients remain after exclusions')
  }

  if (!draft.postalAddress) {
    throw new GtmCampaignError(
      'postal_address_required',
      'Set your business postal address in workspace settings before approving outreach (required by CAN-SPAM)',
    )
  }
  const reviewRequired = draft.rendered.filter((row) => row.needsReview)
  if (reviewRequired.length > 0) {
    throw new GtmCampaignError(
      'message_review_required',
      `${reviewRequired.length} rendered email step artifacts are outside the approved quality envelope`,
    )
  }

  const renderedByCandidateStep = new Map(
    draft.rendered.map((row) => [`${row.candidateId}:${row.stepKey}`, row]),
  )
  const now = new Date()

  const version = await em.transactional(async (tem) => {
    // CAN-SPAM gate, checked INSIDE the approve transaction: the workspace
    // must carry the org's business postal address (the sender is the
    // customer's org, not Noli) or the footer of every frozen message would
    // ship without a sender address. Re-read here so a concurrent clear
    // between draft computation and approval still fails closed.
    const workspaceRow = await tem.findOne(GtmWorkspace, {
      id: campaign.workspaceId,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      deletedAt: null,
    })
    const transactionalPostalAddress = readWorkspacePostalAddress(workspaceRow)
    if (!transactionalPostalAddress) {
      throw new GtmCampaignError(
        'postal_address_required',
        'Set your business postal address in workspace settings before approving outreach (required by CAN-SPAM)',
      )
    }
    if (transactionalPostalAddress !== draft.postalAddress) {
      throw new GtmCampaignError(
        'stale_draft',
        'The approved postal footer changed; reload and review the draft again',
      )
    }

    if (draft.settings.mailbox_connection_id) {
      const senderRow = await tem.findOne(EmailConnection, {
        id: draft.settings.mailbox_connection_id,
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        deletedAt: null,
      })
      const currentMaterial = senderRow && senderRow.isActive
        ? {
            mailbox_connection_id: senderRow.id,
            provider: senderRow.provider,
            email_address: senderRow.emailAddress.trim().toLowerCase(),
            user_id: senderRow.userId,
            purpose: senderRow.purpose ?? null,
            updated_at: senderRow.updatedAt.toISOString(),
          }
        : null
      if (!currentMaterial || !draft.sender || canonicalHash(currentMaterial) !== draft.sender.fingerprint) {
        throw new GtmCampaignError(
          'sender_changed',
          'The selected sender changed or became inactive; reload and review the draft again',
        )
      }
    }

    const existingVersions = await tem.find(GtmCampaignVersion, {
      campaignId: campaign.id,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
    })
    const versionNumber =
      existingVersions.reduce((max, row) => Math.max(max, row.version), 0) + 1

    const versionRow = tem.create(GtmCampaignVersion, {
      id: crypto.randomUUID(),
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      campaignId: campaign.id,
      version: versionNumber,
      snapshot: draft.canonical,
      contentHash: draft.contentHash,
      approvedByUserId: ctx.userId,
      approvedAt: now,
      invalidatedAt: null,
      invalidatedReason: null,
    })
    tem.persist(versionRow)

    // Steps belong to the version (entity model): create rows now, resolving
    // connect-first dependencies from draft keys to row ids.
    const stepIdByKey = new Map<string, string>()
    const stepRows: GtmStep[] = []
    for (const spec of draft.steps) {
      const stepId = crypto.randomUUID()
      stepIdByKey.set(spec.key, stepId)
      const row = tem.create(GtmStep, {
        id: stepId,
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        campaignVersionId: versionRow.id,
        order: spec.order,
        channel: spec.channel,
        mode: spec.mode,
        delayDays: spec.delay_days,
        sendWindow: {
          ...draft.settings.send_window,
          jitter_minutes: draft.settings.jitter_minutes,
          step_key: spec.key,
          social_action: spec.social_action,
        },
        dependsOnStepId: spec.depends_on_key ? stepIdByKey.get(spec.depends_on_key) ?? null : null,
        dependencyKind: spec.dependency_kind,
      })
      tem.persist(row)
      stepRows.push(row)
    }
    await tem.flush()

    // Enrollments: unique (campaign, candidate). Existing rows (from an
    // earlier, since-invalidated version, or a concurrent approve) are
    // repointed at the new version; a unique violation on insert means a
    // concurrent writer won the race and is treated as already-enrolled.
    const enrollmentByCandidate = new Map<string, GtmEnrollment>()
    for (const recipient of draft.recipients) {
      let enrollment = await tem.findOne(GtmEnrollment, {
        campaignId: campaign.id,
        candidateId: recipient.candidateId,
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
      })
      if (!enrollment) {
        try {
          enrollment = tem.create(GtmEnrollment, {
            id: crypto.randomUUID(),
            organizationId: ctx.organizationId,
            tenantId: ctx.tenantId,
            campaignId: campaign.id,
            campaignVersionId: versionRow.id,
            candidateId: recipient.candidateId,
            contactId: recipient.contactId,
            status: 'active',
          })
          tem.persist(enrollment)
          await tem.flush()
        } catch (err) {
          if (!(err instanceof UniqueConstraintViolationException)) throw err
          // Already-enrolled by a concurrent writer: reuse the durable row.
          enrollment = await tem.findOne(GtmEnrollment, {
            campaignId: campaign.id,
            candidateId: recipient.candidateId,
            organizationId: ctx.organizationId,
            tenantId: ctx.tenantId,
          })
          if (!enrollment) throw err
        }
      }
      if (enrollment.campaignVersionId !== versionRow.id) {
        // Repoint at the new version; a stopped enrollment stays stopped
        // (durable outreach history is never revived by re-approval).
        enrollment.campaignVersionId = versionRow.id
        tem.persist(enrollment)
      }
      enrollmentByCandidate.set(recipient.candidateId, enrollment)
    }
    await tem.flush()

    // Frozen rendered messages: one row per (enrollment, email step).
    const emailSteps = stepRows.filter((step) => step.mode === 'automated_email')
    const stepKeyById = new Map(
      emailSteps.map((step) => [
        step.id,
        (step.sendWindow as Record<string, unknown> | null)?.step_key as string,
      ]),
    )
    const renderedIds: Array<Record<string, unknown>> = []
    for (const recipient of draft.recipients) {
      const enrollment = enrollmentByCandidate.get(recipient.candidateId)
      if (!enrollment) continue
      // A stopped enrollment gets no new frozen messages.
      if (enrollment.status !== 'active') continue
      for (const step of emailSteps) {
        const stepKey = stepKeyById.get(step.id)
        const preview = stepKey
          ? renderedByCandidateStep.get(`${recipient.candidateId}:${stepKey}`)
          : null
        if (!stepKey || !preview) {
          throw new GtmCampaignError(
            'message_review_required',
            'An approved recipient-step artifact is missing from the reviewed envelope',
          )
        }
        const messageRow = tem.create(GtmRenderedMessage, {
          id: crypto.randomUUID(),
          organizationId: ctx.organizationId,
          tenantId: ctx.tenantId,
          campaignVersionId: versionRow.id,
          enrollmentId: enrollment.id,
          stepId: step.id,
          subject: preview.subject,
          bodyHtml: preview.bodyHtml,
          bodyText: preview.bodyText,
          contentHash: preview.contentHash,
          editedByUserId: null,
        })
        tem.persist(messageRow)
        renderedIds.push({
          enrollment_id: enrollment.id,
          step_id: step.id,
          step_key: stepKey,
          rendered_message_id: messageRow.id,
          content_hash: preview.contentHash,
        })
      }
    }

    // The snapshot carries the canonical draft (whose hash is content_hash)
    // plus the created row ids; the hash is computed over the canonical part
    // only, so it matches what the reviewer saw in draft-state.
    versionRow.snapshot = {
      ...draft.canonical,
      version: versionNumber,
      ids: {
        steps: stepRows.map((row) => ({
          key: (row.sendWindow as Record<string, unknown> | null)?.step_key ?? null,
          id: row.id,
          depends_on_step_id: row.dependsOnStepId ?? null,
        })),
        enrollments: [...enrollmentByCandidate.entries()].map(([candidateId, row]) => ({
          candidate_id: candidateId,
          enrollment_id: row.id,
        })),
        rendered: renderedIds,
      },
    }
    tem.persist(versionRow)

    campaign.status = 'approved'
    campaign.currentVersionId = versionRow.id
    tem.persist(campaign)

    const audit = tem.create(GtmAuditEvent, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      actor: 'user_id',
      actorUserId: ctx.userId,
      action: 'gtm.campaign.approved',
      objectType: 'gtm_campaign_version',
      objectId: versionRow.id,
      objectVersion: versionNumber,
      requestId: ctx.requestId ?? null,
      metadata: {
        campaign_id: campaign.id,
        content_hash: draft.contentHash,
        recipients: draft.recipients.length,
        excluded: draft.exclusions.summary.excluded,
        steps: stepRows.length,
        projected_credits: draft.projectedCredits.projected_credits,
      },
    })
    tem.persist(audit)
    await tem.flush()
    return versionRow
  })

  return { campaign, version, alreadyApproved: false, contentHash: version.contentHash }
}

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

export type InvalidateResult = {
  invalidated: boolean
  campaign: GtmCampaign
  version: GtmCampaignVersion | null
}

export async function invalidateCurrentVersion(
  em: CampaignEm,
  ctx: GtmCtx,
  campaignId: string,
  reason: string,
): Promise<InvalidateResult> {
  const campaign = await loadCampaign(em, ctx, campaignId)
  if (!campaign.currentVersionId) {
    return { invalidated: false, campaign, version: null }
  }
  const version = await em.findOne(GtmCampaignVersion, {
    id: campaign.currentVersionId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
  })

  await em.transactional(async (tem) => {
    if (version && !version.invalidatedAt) {
      // Only the invalidation stamp changes; snapshot and content_hash stay
      // frozen forever (the version is an immutable record).
      version.invalidatedAt = new Date()
      version.invalidatedReason = reason
      tem.persist(version)
    }
    campaign.status = 'draft'
    campaign.currentVersionId = null
    tem.persist(campaign)
    const audit = tem.create(GtmAuditEvent, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      actor: 'user_id',
      actorUserId: ctx.userId,
      action: 'gtm.campaign.version_invalidated',
      objectType: 'gtm_campaign_version',
      objectId: version?.id ?? campaign.currentVersionId,
      objectVersion: version?.version ?? null,
      requestId: ctx.requestId ?? null,
      metadata: { campaign_id: campaign.id, reason },
    })
    tem.persist(audit)
    await tem.flush()
  })

  return { invalidated: true, campaign, version: version ?? null }
}

// Section 7 ladder: a play edit that changes geography or market invalidates
// every dependent approved campaign version with reason 'scope_change'.
export async function invalidateForPlayScopeChange(
  em: CampaignEm,
  ctx: GtmCtx,
  playId: string,
): Promise<{ invalidatedCampaignIds: string[] }> {
  const campaigns = await em.find(GtmCampaign, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    playId,
    deletedAt: null,
  })
  const invalidatedCampaignIds: string[] = []
  for (const campaign of campaigns) {
    if (!campaign.currentVersionId) continue
    await invalidateCurrentVersion(em, ctx, campaign.id, 'scope_change')
    invalidatedCampaignIds.push(campaign.id)
  }
  return { invalidatedCampaignIds }
}

// ---------------------------------------------------------------------------
// Draft-mutating operations (auto-invalidate an approved campaign)
// ---------------------------------------------------------------------------

async function mutateDraft(
  em: CampaignEm,
  ctx: GtmCtx,
  campaignId: string,
  reason: string,
  mutate: (campaign: GtmCampaign) => void,
): Promise<{ campaign: GtmCampaign; invalidated: boolean }> {
  let campaign = await loadCampaign(em, ctx, campaignId)
  let invalidated = false
  if (campaign.currentVersionId) {
    const result = await invalidateCurrentVersion(em, ctx, campaignId, reason)
    campaign = result.campaign
    invalidated = result.invalidated
  }
  await em.transactional(async (tem) => {
    mutate(campaign)
    tem.persist(campaign)
    await tem.flush()
  })
  return { campaign, invalidated }
}

export async function updateCampaignTemplate(
  em: CampaignEm,
  ctx: GtmCtx,
  campaignId: string,
  template: CampaignTemplate,
): Promise<{ campaign: GtmCampaign; invalidated: boolean }> {
  const subject = template.subject.trim()
  const body = template.body
  if (!subject || !body.trim()) {
    throw new GtmCampaignError('invalid_settings', 'template subject and body are required')
  }
  return mutateDraft(em, ctx, campaignId, 'template_edited', (campaign) => {
    campaign.channelMix = {
      ...((campaign.channelMix ?? {}) as Record<string, unknown>),
      template: { subject, body },
    }
  })
}

export async function setCandidateExclusion(
  em: CampaignEm,
  ctx: GtmCtx,
  campaignId: string,
  candidateId: string,
  excluded: boolean,
): Promise<{ campaign: GtmCampaign; invalidated: boolean }> {
  const candidate = await em.findOne(GtmCandidate, {
    id: candidateId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!candidate) throw new GtmCampaignError('candidate_not_found', 'Candidate not found')
  const reason = excluded ? 'recipient_excluded' : 'recipient_included'
  return mutateDraft(em, ctx, campaignId, reason, (campaign) => {
    const mixRaw = (campaign.channelMix ?? {}) as Record<string, unknown>
    const current = Array.isArray(mixRaw.manual_exclusions)
      ? (mixRaw.manual_exclusions as unknown[]).filter((id): id is string => typeof id === 'string')
      : []
    const next = new Set(current)
    if (excluded) next.add(candidateId)
    else next.delete(candidateId)
    campaign.channelMix = { ...mixRaw, manual_exclusions: [...next].sort() }
  })
}
