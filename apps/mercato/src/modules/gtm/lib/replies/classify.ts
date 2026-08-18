import type { GtmCtx } from '../campaign/build'
import type { Clock, ExecutionEm } from '../execute/schedule'
import { GtmExecutionError } from '../execute/schedule'
import { hashAddress } from '../campaign/exclusions'
import {
  GtmAuditEvent,
  GtmContactPoint,
  GtmEnrollment,
  GtmReply,
  GtmSuppression,
} from '../../data/entities'
import { EmailMessage } from '../../../email/data/schema'
import { UniqueConstraintViolationException } from '@mikro-orm/core'

/*
 * Reply classification + response drafting (SPEC-066 section 9, Tranche 6).
 *
 * Classification runs AFTER the atomic stop committed (correlate.ts). The
 * Classifier interface is the seam: v1 is a deterministic keyword mapper so
 * the pipeline is fully testable offline; an LLM classifier is a later
 * enhancement that plugs into the same interface (and, like every GTM LLM
 * call, would be metered - not built in this tranche).
 *
 * `unsubscribe` classification ALSO writes gtm_suppressions in the SAME
 * transaction as the classification update (section 9).
 *
 * Drafting: draftResponse stores draft_response + draft_status 'drafted';
 * approveDraft flips to 'approved' with an audit event. There is NO send
 * path for drafts in this tranche - sending an approved draft is a NEW send
 * attempt through the full section 6 machine, wired in a later tranche.
 */

export type ReplyClassification =
  | 'interested'
  | 'neutral_question'
  | 'not_now'
  | 'referral'
  | 'unsubscribe'
  | 'wrong_person'
  | 'negative'

export interface ReplyClassifier {
  classify(text: string): ReplyClassification
}

// Ordered: the first bucket with a matching pattern wins. Negative intent is
// checked before positive so "not interested" never reads as interest.
const RULES: Array<[ReplyClassification, RegExp[]]> = [
  [
    'unsubscribe',
    [
      /unsubscribe/i,
      /opt\s*(me\s*)?out/i,
      /remove me (from|off)/i,
      /take me off/i,
      /stop (emailing|sending|messaging)/i,
    ],
  ],
  [
    'wrong_person',
    [
      /wrong person/i,
      /not the (right|correct) person/i,
      /no longer (work|works|with|at)/i,
      /doesn'?t work here/i,
      /left the (company|team|firm)/i,
    ],
  ],
  [
    'referral',
    [
      /reach out to/i,
      /you should (talk|speak) (to|with)/i,
      /the (right|best) person (for this )?is/i,
      /forward(ed|ing)? (this|your|you)/i,
      /try contacting/i,
      /looping in/i,
    ],
  ],
  [
    'not_now',
    [
      /not (right )?now/i,
      /maybe (later|next)/i,
      /next (week|month|quarter|year)/i,
      /circle back/i,
      /check back/i,
      /bad timing/i,
      /revisit (this )?(later|in)/i,
    ],
  ],
  [
    'negative',
    [
      /not interested/i,
      /no,? than(k|ks)/i,
      /please stop/i,
      /do ?n[o']t contact/i,
      /never (contact|email)/i,
      /not a (good )?fit/i,
    ],
  ],
  [
    'interested',
    [
      /interested/i,
      /let'?s (talk|chat|connect)/i,
      /book a (call|meeting|demo)/i,
      /tell me more/i,
      /sounds (good|great|interesting)/i,
      /send (me )?(more|over|the)/i,
      /schedule/i,
      /demo/i,
    ],
  ],
]

export const keywordClassifier: ReplyClassifier = {
  classify(text: string): ReplyClassification {
    const haystack = (text ?? '').slice(0, 20000)
    for (const [classification, patterns] of RULES) {
      if (patterns.some((pattern) => pattern.test(haystack))) return classification
    }
    return 'neutral_question'
  },
}

export const REPLY_CLASSIFICATIONS: ReplyClassification[] = [
  'interested',
  'neutral_question',
  'not_now',
  'referral',
  'unsubscribe',
  'wrong_person',
  'negative',
]

async function loadReply(em: ExecutionEm, ctx: GtmCtx, replyId: string): Promise<GtmReply> {
  const reply = await em.findOne(GtmReply, {
    id: replyId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!reply) throw new GtmExecutionError('reply_not_found', 'Reply not found')
  return reply
}

// Resolve the counterparty address for a reply: the inbound message's from
// address when the reply is an email, else the enrollment's verified email
// contact point.
async function resolveReplyAddress(
  em: ExecutionEm,
  ctx: GtmCtx,
  reply: GtmReply,
): Promise<string | null> {
  if (reply.emailMessageId) {
    const message = await em.findOne(EmailMessage, {
      id: reply.emailMessageId,
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
    })
    if (message?.fromAddress) return message.fromAddress.trim().toLowerCase()
  }
  const enrollment = await em.findOne(GtmEnrollment, {
    id: reply.enrollmentId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
  })
  if (!enrollment) return null
  const points = await em.find(GtmContactPoint, {
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    candidateId: enrollment.candidateId,
    channel: 'email',
    verificationState: 'verified',
    deletedAt: null,
  })
  return points[0]?.value?.trim().toLowerCase() ?? null
}

export type ClassifyInput = {
  replyId: string
  // Explicit classification = user override; absent = run the classifier
  // over the linked inbound text.
  classification?: ReplyClassification
}

export async function classifyReply(
  em: ExecutionEm,
  ctx: GtmCtx,
  input: ClassifyInput,
  deps: { classifier?: ReplyClassifier; clock?: Clock } = {},
): Promise<{ reply: GtmReply; classification: ReplyClassification; suppressed: boolean }> {
  const reply = await loadReply(em, ctx, input.replyId)
  let classification = input.classification ?? null
  const source = input.classification ? 'user_override' : 'model'
  if (!classification) {
    let text = ''
    if (reply.emailMessageId) {
      const message = await em.findOne(EmailMessage, {
        id: reply.emailMessageId,
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
      })
      text = message?.bodyText || message?.bodyHtml || ''
    }
    classification = (deps.classifier ?? keywordClassifier).classify(text)
  }
  const resolved: ReplyClassification = classification

  let suppressed = false
  const run = () =>
    em.transactional(async (tem) => {
      reply.classification = resolved
      reply.classificationSource = source
      tem.persist(reply)
      if (resolved === 'unsubscribe') {
        // Section 9: an unsubscribe classification writes the suppression in
        // the SAME transaction as the classification update.
        const address = await resolveReplyAddress(tem, ctx, reply)
        if (address) {
          const addressHash = hashAddress(address)
          const existing = await tem.findOne(GtmSuppression, {
            organizationId: ctx.organizationId,
            channel: 'email',
            addressHash,
            deletedAt: null,
          })
          if (!existing) {
            tem.persist(
              tem.create(GtmSuppression, {
                organizationId: ctx.organizationId,
                tenantId: ctx.tenantId,
                scope: 'org',
                channel: 'email',
                addressHash,
                addressDisplay: address,
                reason: 'unsubscribe',
                source: { via: 'reply_classification', reply_id: reply.id },
              }),
            )
            suppressed = true
          }
        }
      }
      tem.persist(
        tem.create(GtmAuditEvent, {
          organizationId: ctx.organizationId,
          tenantId: ctx.tenantId,
          actor: source === 'user_override' ? 'user_id' : 'system',
          actorUserId: source === 'user_override' ? ctx.userId : null,
          action: 'gtm.reply.classified',
          objectType: 'gtm_reply',
          objectId: reply.id,
          requestId: ctx.requestId ?? null,
          metadata: { classification: resolved, source, suppressed },
        }),
      )
      await tem.flush()
    })
  try {
    await run()
  } catch (err) {
    if (!(err instanceof UniqueConstraintViolationException)) throw err
    suppressed = false
    await run()
  }
  return { reply, classification: resolved, suppressed }
}

export type DraftInput = {
  replyId: string
  draft: { subject?: string | null; body: string }
}

export async function draftResponse(
  em: ExecutionEm,
  ctx: GtmCtx,
  input: DraftInput,
  deps: { clock?: Clock } = {},
): Promise<GtmReply> {
  const reply = await loadReply(em, ctx, input.replyId)
  await em.transactional(async (tem) => {
    reply.draftResponse = {
      subject: input.draft.subject ?? null,
      body: input.draft.body,
      drafted_by_user_id: ctx.userId,
      drafted_at: (deps.clock?.now() ?? new Date()).toISOString(),
    }
    reply.draftStatus = 'drafted'
    tem.persist(reply)
    await tem.flush()
  })
  return reply
}

// Flips 'drafted' -> 'approved' with an audit event. NO send happens here:
// an approved draft becomes a NEW send attempt through the full state
// machine in a later tranche.
export async function approveDraft(
  em: ExecutionEm,
  ctx: GtmCtx,
  input: { replyId: string },
): Promise<GtmReply> {
  const reply = await loadReply(em, ctx, input.replyId)
  if (reply.draftStatus !== 'drafted') {
    throw new GtmExecutionError(
      'invalid_state',
      `Draft status '${reply.draftStatus}' cannot be approved`,
    )
  }
  await em.transactional(async (tem) => {
    reply.draftStatus = 'approved'
    tem.persist(reply)
    tem.persist(
      tem.create(GtmAuditEvent, {
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        actor: 'user_id',
        actorUserId: ctx.userId,
        action: 'gtm.reply.draft_approved',
        objectType: 'gtm_reply',
        objectId: reply.id,
        requestId: ctx.requestId ?? null,
        metadata: null,
      }),
    )
    await tem.flush()
  })
  return reply
}
