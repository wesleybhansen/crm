export function summarizeRecentWorkPartitions(
  partitionNames: readonly string[],
  results: readonly PromiseSettledResult<unknown>[],
): { failedPartitions: string[]; totalFailure: boolean } {
  if (partitionNames.length !== results.length) {
    throw new Error('Recent-work partition metadata mismatch')
  }

  const failedPartitions = results.flatMap((result, index) =>
    result.status === 'rejected' ? [partitionNames[index]] : [],
  )
  return {
    failedPartitions,
    totalFailure: failedPartitions.length === results.length,
  }
}

export function classifyRecentWorkIdentity({
  hasNoliIdentity,
  entitled,
  organizationId,
}: {
  hasNoliIdentity: boolean;
  entitled: boolean;
  organizationId: string | null | undefined;
}): { state: 'empty' } | { state: 'forbidden' } | { state: 'ready'; organizationId: string } {
  if (!hasNoliIdentity) return { state: 'empty' }
  if (!entitled) return { state: 'forbidden' }
  return organizationId
    ? { state: 'ready', organizationId }
    : { state: 'empty' }
}
