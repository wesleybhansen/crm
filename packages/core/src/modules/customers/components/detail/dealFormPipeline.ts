import { z } from 'zod'

export type DealPipelineOption = { id: string; name: string; isDefault: boolean }
export type DealPipelineStageOption = { id: string; label: string; order: number }

/**
 * An optional UUID form field where an empty picker ("" or null) means "not
 * set". A bare z.string().uuid().optional() rejects "" with "Invalid UUID",
 * which is what an unselected <select> submits.
 */
export const optionalUuidField = (message = 'customers.people.detail.deals.pipelineInvalid') =>
  z.preprocess(
    (value) => (value === '' || value === null ? undefined : value),
    z.string().uuid(message).optional(),
  )

/** The pipeline a new deal starts in: the workspace default, else the first one. */
export function pickDefaultPipelineId(pipelines: DealPipelineOption[]): string | null {
  if (!pipelines.length) return null
  return (pipelines.find((pipeline) => pipeline.isDefault) ?? pipelines[0]).id
}

/** The stage a new deal starts in: the lowest ordered one. */
export function pickFirstStageId(stages: DealPipelineStageOption[]): string | null {
  if (!stages.length) return null
  return [...stages].sort((a, b) => a.order - b.order)[0].id
}
