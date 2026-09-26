/**
 * Renaming a pipeline stage carries what sits in it.
 *
 * The organization's stages are a list of names on the business profile
 * (`pipeline_stages`), and deals and contacts hold the stage by NAME
 * (`customer_deals.pipeline_stage`, `customer_entities.lifecycle_stage`,
 * which the contacts page sets from the same list). Saving a renamed list
 * used to leave every deal and contact on the old name, so they fell off the
 * board. When the list is saved, the renames are applied to the rows of the
 * same tenant and organization.
 *
 * A rename is either sent explicitly (`stageRenames: [{ from, to }]`, what
 * the settings page sends) or inferred when the new list differs from the old
 * one in exactly one position and the old name is gone (a rename in place,
 * e.g. by the assistant's "update stages"). A rename never moves rows out of
 * a stage that is still in the list.
 */

import type { EntityManager } from '@mikro-orm/postgresql'

export type StageRename = { from: string; to: string }

const MAX_RENAMES = 50
const MAX_STAGE_NAME = 200

/** Stage names from a stored or submitted `pipeline_stages` value (names or `{ name }`, JSON text or array). */
export function stageNamesOf(raw: unknown): string[] {
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (!Array.isArray(parsed)) return []
  return parsed
    .map((stage) => (typeof stage === 'string' ? stage : (stage as { name?: unknown } | null)?.name))
    .filter((name): name is string => typeof name === 'string')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
}

function lowerSet(names: readonly string[]): Set<string> {
  return new Set(names.map((name) => name.toLowerCase()))
}

function explicitRenames(raw: unknown, next: readonly string[]): StageRename[] {
  if (!Array.isArray(raw)) return []
  const nextLower = lowerSet(next)
  const out: StageRename[] = []
  for (const entry of raw.slice(0, MAX_RENAMES)) {
    const from = typeof (entry as { from?: unknown })?.from === 'string' ? (entry as { from: string }).from.trim() : ''
    const to = typeof (entry as { to?: unknown })?.to === 'string' ? (entry as { to: string }).to.trim() : ''
    if (!from || !to || from.length > MAX_STAGE_NAME || to.length > MAX_STAGE_NAME) continue
    if (from.toLowerCase() === to.toLowerCase()) continue
    if (!nextLower.has(to.toLowerCase())) continue
    if (nextLower.has(from.toLowerCase())) continue
    out.push({ from, to })
  }
  return out
}

function inferredRename(previous: readonly string[], next: readonly string[]): StageRename[] {
  if (previous.length === 0 || previous.length !== next.length) return []
  const changed: number[] = []
  for (let i = 0; i < next.length; i += 1) {
    if (previous[i] !== next[i]) changed.push(i)
  }
  if (changed.length !== 1) return []
  const index = changed[0]
  const from = previous[index]
  const to = next[index]
  if (from.toLowerCase() === to.toLowerCase()) return []
  if (lowerSet(next).has(from.toLowerCase())) return []
  return [{ from, to }]
}

/**
 * The renames a stage-list save implies. `explicit` (the request's
 * `stageRenames`) wins when it is an array; otherwise a single in-place
 * rename is inferred from the previous and next lists.
 */
export function planStageRenames(previousRaw: unknown, nextRaw: unknown, explicit?: unknown): StageRename[] {
  const next = stageNamesOf(nextRaw)
  if (next.length === 0) return []
  if (Array.isArray(explicit)) return explicitRenames(explicit, next)
  return inferredRename(stageNamesOf(previousRaw), next)
}

type Knex = ReturnType<EntityManager['getKnex']>

/**
 * Moves the organization's deals (`pipeline_stage`) and contacts
 * (`lifecycle_stage`) from each renamed stage to its new name, matching the
 * old name case-insensitively. Scoped to one tenant AND organization;
 * `updated_at` is left alone so a rename does not look like activity in
 * reports. Neither column is encrypted.
 */
export async function applyStageRenames(
  knex: Knex,
  scope: { tenantId: string; organizationId: string },
  renames: readonly StageRename[],
): Promise<{ deals: number; contacts: number }> {
  if (renames.length === 0) return { deals: 0, contacts: 0 }
  return knex.transaction(async (trx) => {
    let deals = 0
    let contacts = 0
    for (const { from, to } of renames) {
      deals += Number(await trx('customer_deals')
        .where('tenant_id', scope.tenantId)
        .where('organization_id', scope.organizationId)
        .whereNull('deleted_at')
        .whereRaw('lower(trim(pipeline_stage)) = lower(?)', [from])
        .update({ pipeline_stage: to })) || 0
      contacts += Number(await trx('customer_entities')
        .where('tenant_id', scope.tenantId)
        .where('organization_id', scope.organizationId)
        .where('kind', 'person')
        .whereNull('deleted_at')
        .whereRaw('lower(trim(lifecycle_stage)) = lower(?)', [from])
        .update({ lifecycle_stage: to })) || 0
    }
    return { deals, contacts }
  })
}
