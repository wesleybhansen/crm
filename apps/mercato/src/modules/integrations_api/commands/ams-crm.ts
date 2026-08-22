import type { EntityManager } from '@mikro-orm/postgresql'
import { registerCommand, type CommandHandler } from '@open-mercato/shared/lib/commands'
import { IntegrationsApiAmsCommand } from '../data/entities'
import {
  commandCanonicalHashV1,
  commandIdempotencyDigestV1,
  commandNonceDigestV1,
  commandPayloadHashV1,
  type AmsCrmCommandEnvelopeV1,
} from '../lib/ams-crm-contract-v1'
import { decideAmsCrmReplayV1, type AmsCrmReplayIdentityV1 } from '../lib/ams-crm-replay-v1'

export const AMS_CRM_SHADOW_ACCEPT_COMMAND_V1 = 'integrations_api.ams_crm.shadow_accept_v1' as const

export class AmsCrmShadowCommandConflict extends Error {
  constructor(readonly code: 'command_id_conflict' | 'idempotency_conflict' | 'nonce_conflict') {
    super(code)
    this.name = 'AmsCrmShadowCommandConflict'
  }
}

export type AmsCrmShadowCommandInputV1 = {
  organizationId: string
  tenantId: string
  envelope: AmsCrmCommandEnvelopeV1
}

export type AmsCrmShadowCommandResultV1 = {
  action: 'inserted' | 'replayed'
  state: string
  commandId: string
  canonicalHash: string
}

async function loadCandidates(
  em: EntityManager,
  input: AmsCrmShadowCommandInputV1,
  identity: Omit<AmsCrmReplayIdentityV1, 'state'>,
): Promise<AmsCrmReplayIdentityV1[]> {
  const scope = {
    organizationId: input.organizationId,
    tenantId: input.tenantId,
    deletedAt: null,
  }
  const rows = await em.find(IntegrationsApiAmsCommand, {
    ...scope,
    $or: [
      { commandId: identity.commandId },
      { idempotencyDigest: identity.idempotencyDigest },
      { nonceDigest: identity.nonceDigest },
    ],
  })
  return rows.map((row) => ({
    commandId: row.commandId,
    idempotencyDigest: row.idempotencyDigest,
    nonceDigest: row.nonceDigest,
    canonicalHash: row.canonicalHash,
    state: row.state,
  }))
}

function replayIdentity(input: AmsCrmShadowCommandInputV1): Omit<AmsCrmReplayIdentityV1, 'state'> {
  return {
    commandId: input.envelope.commandId,
    idempotencyDigest: commandIdempotencyDigestV1(input.envelope),
    nonceDigest: commandNonceDigestV1(input.envelope),
    canonicalHash: commandCanonicalHashV1(input.envelope),
  }
}

async function acceptShadowCommand(
  em: EntityManager,
  input: AmsCrmShadowCommandInputV1,
): Promise<AmsCrmShadowCommandResultV1> {
  const identity = replayIdentity(input)
  const existing = await loadCandidates(em, input, identity)
  const decision = decideAmsCrmReplayV1(identity, existing)
  if (decision.action === 'conflict') throw new AmsCrmShadowCommandConflict(decision.code)
  if (decision.action === 'replay') {
    return {
      action: 'replayed',
      state: decision.state,
      commandId: identity.commandId,
      canonicalHash: identity.canonicalHash,
    }
  }

  const record = em.create(IntegrationsApiAmsCommand, {
    organizationId: input.organizationId,
    tenantId: input.tenantId,
    sourceOrganizationId: input.envelope.sourceOrganizationId,
    principalRef: input.envelope.principalRef,
    commandId: input.envelope.commandId,
    commandType: input.envelope.payload.commandType,
    commandRef: input.envelope.payload.commandRef,
    idempotencyDigest: identity.idempotencyDigest,
    nonceDigest: identity.nonceDigest,
    canonicalHash: identity.canonicalHash,
    payloadDigest: commandPayloadHashV1(input.envelope),
    issuer: input.envelope.issuer,
    audience: input.envelope.audience,
    contractVersion: input.envelope.contractVersion,
    schemaVersion: input.envelope.schemaVersion,
    keyVersion: input.envelope.keyVersion,
    issuedAt: new Date(input.envelope.issuedAt),
    expiresAt: new Date(input.envelope.expiresAt),
    state: 'shadow_validated',
  })
  await em.persistAndFlush(record)
  return {
    action: 'inserted',
    state: record.state,
    commandId: identity.commandId,
    canonicalHash: identity.canonicalHash,
  }
}

const shadowAcceptCommand: CommandHandler<AmsCrmShadowCommandInputV1, AmsCrmShadowCommandResultV1> = {
  id: AMS_CRM_SHADOW_ACCEPT_COMMAND_V1,
  async execute(input, ctx) {
    const root = ctx.container.resolve('em') as EntityManager
    const em = root.fork()
    try {
      return await em.transactional((transaction) => acceptShadowCommand(transaction, input))
    } catch (error) {
      if (error instanceof AmsCrmShadowCommandConflict) throw error
      const retryEm = root.fork()
      const identity = replayIdentity(input)
      const existing = await loadCandidates(retryEm, input, identity)
      if (existing.length === 0) throw error
      const decision = decideAmsCrmReplayV1(identity, existing)
      if (decision.action === 'conflict') throw new AmsCrmShadowCommandConflict(decision.code)
      if (decision.action === 'replay') {
        return {
          action: 'replayed',
          state: decision.state,
          commandId: identity.commandId,
          canonicalHash: identity.canonicalHash,
        }
      }
      throw error
    }
  },
  buildLog({ input, result }) {
    if (result.action === 'replayed') return null
    return {
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      resourceKind: 'integrations_api.ams_command',
      resourceId: result.commandId,
      actionLabel: 'Validate signed AMS CRM command in shadow mode',
      context: {
        action: result.action,
        canonicalHash: result.canonicalHash,
        commandType: input.envelope.payload.commandType,
      },
    }
  },
}

registerCommand(shadowAcceptCommand)

export const __test = { acceptShadowCommand }
