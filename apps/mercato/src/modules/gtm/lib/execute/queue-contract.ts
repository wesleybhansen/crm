export const GTM_EXECUTION_TICK_QUEUE = 'gtm-execution-tick'

export type GtmExecutionTickJob = {
  organizationId: string
  tenantId: string
  requestedByUserId: string
  limit?: number
  // The generic scheduler injects this field. GTM's database claim/fence is
  // the execution idempotency boundary, so the worker accepts but never uses
  // the scheduler key as a substitute for that durable state.
  _idempotencyKey?: string
}
