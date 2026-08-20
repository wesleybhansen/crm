import { FakeEm } from './fake-em'
import { ORG, TENANT, USER, WORKSPACE, ctx, seedPlay, seedRun, seedCandidate } from './campaign-fixtures'
import { createCampaign, type ChannelMixInput } from '../../campaign/build'
import { approveCampaign, computeDraftState } from '../../campaign/approve'
import { launchCampaign, type Clock } from '../../execute/schedule'
import {
  GtmCampaign,
  GtmCampaignVersion,
  GtmCandidate,
  GtmContactPoint,
  GtmEnrollment,
  GtmPlay,
  GtmSendAttempt,
  GtmStep,
} from '../../../data/entities'
import { EmailConnection, EmailMessage } from '../../../../email/data/schema'
import {
  GtmSendTimeoutError,
  type GtmSendTransport,
  type GtmTransportSendArgs,
  type GtmTransportSendResult,
} from '../../execute/transport'

/*
 * Shared seed helpers for the Tranche 6 execution tests. All identities are
 * synthetic (SPEC-066 section 11.3); no transport in this file (or any test)
 * ever opens a socket.
 */

export const MAILBOX = 'eeeeeeee-5555-4555-8555-555555555555'
export const SENDER_ADDRESS = 'sender@fixture.example'

// Wednesday 2026-07-22 12:00 ET (16:00Z): inside the default 9-17
// America/New_York send window.
export const LAUNCH_ISO = '2026-07-22T16:00:00.000Z'

export function fixedClock(iso: string): Clock & { set: (nextIso: string) => void } {
  let current = new Date(iso)
  return {
    now: () => new Date(current.getTime()),
    set: (nextIso: string) => {
      current = new Date(nextIso)
    },
  }
}

export async function seedMailbox(
  em: FakeEm,
  overrides: Partial<EmailConnection> = {},
): Promise<EmailConnection> {
  const connection = em.create(EmailConnection, {
    id: MAILBOX,
    tenantId: TENANT,
    organizationId: ORG,
    userId: USER,
    provider: 'smtp',
    emailAddress: SENDER_ADDRESS,
    smtpHost: 'smtp.fixture.example',
    smtpPort: 587,
    smtpUser: SENDER_ADDRESS,
    smtpPass: 'synthetic-app-password',
    isPrimary: true,
    isActive: true,
    ...overrides,
  })
  em.persist(connection)
  await em.flush()
  return connection
}

export type LaunchedFixture = {
  play: GtmPlay
  campaign: GtmCampaign
  version: GtmCampaignVersion
  candidates: GtmCandidate[]
  enrollments: GtmEnrollment[]
  steps: GtmStep[]
  attempts: GtmSendAttempt[]
  connection: EmailConnection
  addressFor: (enrollment: GtmEnrollment) => string
}

export async function seedLaunchedCampaign(
  em: FakeEm,
  options: {
    clock: Clock
    recipients?: number
    emails?: number
    linkedin?: boolean
    dailyCap?: number
    jitterMinutes?: number
  },
): Promise<LaunchedFixture> {
  const connection = await seedMailbox(em)
  const play = await seedPlay(em)
  const run = await seedRun(em, play)
  const candidates: GtmCandidate[] = []
  for (let i = 0; i < (options.recipients ?? 1); i += 1) {
    candidates.push(await seedCandidate(em, run))
  }
  const channelMix: ChannelMixInput = {
    emails: options.emails ?? 2,
    linkedin: options.linkedin === true,
  }
  const { campaign } = await createCampaign(em, ctx, {
    workspaceId: WORKSPACE,
    playId: play.id,
    name: 'Execution fixture campaign',
    channelMix,
    settings: {
      mailbox_connection_id: MAILBOX,
      daily_cap: options.dailyCap,
      jitter_minutes: options.jitterMinutes ?? 0,
    },
  })
  const draft = await computeDraftState(em, ctx, campaign)
  const approved = await approveCampaign(em, ctx, {
    campaignId: campaign.id,
    expectedContentHash: draft.contentHash,
  })
  const launch = await launchCampaign(em, ctx, {
    campaignId: campaign.id,
    expectedContentHash: approved.version.contentHash,
  }, { clock: options.clock })
  const enrollments = await em.find(GtmEnrollment, { campaignId: campaign.id })
  const steps = await em.find(GtmStep, { campaignVersionId: approved.version.id })
  const pointByCandidate = new Map(
    (await em.find(GtmContactPoint, { organizationId: ORG, channel: 'email' })).map((point) => [
      point.candidateId,
      point.value.trim().toLowerCase(),
    ]),
  )
  return {
    play,
    campaign,
    version: approved.version,
    candidates,
    enrollments,
    steps,
    attempts: launch.attempts,
    connection,
    addressFor: (enrollment) => pointByCandidate.get(enrollment.candidateId) as string,
  }
}

// Recording transport spy. behavior 'success' | 'fail' | 'timeout'; onSend
// runs BEFORE the call is recorded so tests can assert durable state at the
// exact moment of provider contact.
export class FakeTransport implements GtmSendTransport {
  calls: GtmTransportSendArgs[] = []
  behavior: 'success' | 'fail' | 'timeout' = 'success'
  onSend?: (args: GtmTransportSendArgs) => void

  async send(args: GtmTransportSendArgs): Promise<GtmTransportSendResult> {
    this.onSend?.(args)
    this.calls.push(args)
    if (this.behavior === 'fail') throw new Error('smtp rejected: 550 no such user')
    if (this.behavior === 'timeout') throw new GtmSendTimeoutError('socket timeout after payload')
    return {
      ok: true,
      providerMessageId: `provider-${this.calls.length}`,
      receipt: { response: '250 OK' },
    }
  }
}

let inboundSeq = 0

export async function seedInboundMessage(
  em: FakeEm,
  options: {
    from: string
    accountId?: string | null
    threadId?: string | null
    headers?: Record<string, string>
    bodyText?: string
    createdAt: Date
  },
): Promise<EmailMessage> {
  const message = em.create(EmailMessage, {
    tenantId: TENANT,
    organizationId: ORG,
    accountId: options.accountId ?? MAILBOX,
    direction: 'inbound',
    fromAddress: options.from,
    toAddress: SENDER_ADDRESS,
    subject: 'Re: Quick question',
    bodyHtml: `<p>${options.bodyText ?? 'Thanks for reaching out.'}</p>`,
    bodyText: options.bodyText ?? 'Thanks for reaching out.',
    threadId: options.threadId ?? null,
    metadata: {
      provider_message_id: `inbound-${(inboundSeq += 1)}`,
      source: 'personal_inbox',
      ...(options.headers ? { headers: options.headers } : {}),
    },
    createdAt: options.createdAt,
  })
  em.persist(message)
  await em.flush()
  return message
}
