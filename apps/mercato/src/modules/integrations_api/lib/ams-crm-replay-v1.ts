export type AmsCrmReplayIdentityV1 = {
  commandId: string
  idempotencyDigest: string
  nonceDigest: string
  canonicalHash: string
  state: string
}

export type AmsCrmReplayDecisionV1 =
  | { action: 'insert' }
  | { action: 'replay'; state: string }
  | { action: 'conflict'; code: 'command_id_conflict' | 'idempotency_conflict' | 'nonce_conflict' }

export function decideAmsCrmReplayV1(
  incoming: Omit<AmsCrmReplayIdentityV1, 'state'>,
  existing: ReadonlyArray<AmsCrmReplayIdentityV1>,
): AmsCrmReplayDecisionV1 {
  const byCommandId = existing.find((record) => record.commandId === incoming.commandId)
  if (byCommandId) {
    return byCommandId.canonicalHash === incoming.canonicalHash
      ? { action: 'replay', state: byCommandId.state }
      : { action: 'conflict', code: 'command_id_conflict' }
  }
  const byIdempotency = existing.find((record) => record.idempotencyDigest === incoming.idempotencyDigest)
  if (byIdempotency) {
    return byIdempotency.canonicalHash === incoming.canonicalHash
      ? { action: 'replay', state: byIdempotency.state }
      : { action: 'conflict', code: 'idempotency_conflict' }
  }
  const byNonce = existing.find((record) => record.nonceDigest === incoming.nonceDigest)
  if (byNonce) {
    return byNonce.canonicalHash === incoming.canonicalHash
      ? { action: 'replay', state: byNonce.state }
      : { action: 'conflict', code: 'nonce_conflict' }
  }
  return { action: 'insert' }
}
