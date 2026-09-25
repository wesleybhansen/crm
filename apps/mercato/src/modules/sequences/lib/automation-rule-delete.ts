/**
 * Deleting an automation rule.
 *
 * Bug (QA 2026-09-24): DELETE /api/sequences/automation-rules returned 500 for
 * EVERY rule, even one with no logs. The handler wrote
 * automation_rule_logs.deleted_rule_name, a column no database has, so the
 * first UPDATE failed before anything was deleted. Even with that column,
 * setting automation_rule_logs.rule_id to NULL breaks its NOT NULL constraint,
 * and the rule row is referenced by automation_rule_logs_rule_id_fkey
 * (no ON DELETE action), so the rule cannot be deleted while logs point at it.
 *
 * Now, in one transaction:
 * - When the database has the history columns (migration
 *   Migration20260925143100_sequences: deleted_rule_name + nullable rule_id),
 *   the logs are kept, unlinked and stamped with the rule's name.
 * - Otherwise (migration not run yet) the rule's logs are deleted, so the
 *   delete still works.
 * - Delayed steps still waiting for this rule (automation_scheduled_steps,
 *   where that table exists) are removed so they never fire for a rule the
 *   owner deleted.
 * - The rule row itself, scoped to the caller's organization.
 *
 * Relative imports only.
 */
import type { Knex } from 'knex'

export type DeleteAutomationRuleResult =
  | { status: 'deleted'; logsKept: number; logsDeleted: number; scheduledStepsDeleted: number }
  | { status: 'not_found' }

type LogColumns = { hasDeletedRuleName: boolean; ruleIdNullable: boolean }

function rowsOf(result: unknown): any[] {
  if (Array.isArray(result)) return result
  const rows = (result as { rows?: unknown })?.rows
  return Array.isArray(rows) ? rows : []
}

async function readLogColumns(trx: Knex | Knex.Transaction): Promise<LogColumns> {
  const result = await trx.raw(
    `SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'automation_rule_logs'
        AND column_name IN ('deleted_rule_name', 'rule_id')`,
  )
  const rows = rowsOf(result)
  return {
    hasDeletedRuleName: rows.some((row) => row.column_name === 'deleted_rule_name'),
    ruleIdNullable: rows.some((row) => row.column_name === 'rule_id' && row.is_nullable === 'YES'),
  }
}

async function tableExists(trx: Knex | Knex.Transaction, table: string): Promise<boolean> {
  const result = await trx.raw('SELECT to_regclass(?) AS reg', [table])
  const rows = rowsOf(result)
  return rows.length > 0 && rows[0].reg != null
}

export async function deleteAutomationRule(
  knex: Knex,
  organizationId: string,
  ruleId: string,
): Promise<DeleteAutomationRuleResult> {
  return knex.transaction(async (trx) => {
    const rule = await trx('automation_rules')
      .where('id', ruleId)
      .where('organization_id', organizationId)
      .first('id', 'name')
    if (!rule) return { status: 'not_found' as const }

    let logsKept = 0
    let logsDeleted = 0
    const columns = await readLogColumns(trx)
    if (columns.hasDeletedRuleName && columns.ruleIdNullable) {
      logsKept = Number(
        await trx('automation_rule_logs')
          .where('rule_id', ruleId)
          .update({ deleted_rule_name: rule.name, rule_id: null }),
      ) || 0
    } else {
      logsDeleted = Number(await trx('automation_rule_logs').where('rule_id', ruleId).del()) || 0
    }

    let scheduledStepsDeleted = 0
    if (await tableExists(trx, 'automation_scheduled_steps')) {
      scheduledStepsDeleted = Number(
        await trx('automation_scheduled_steps')
          .where('rule_id', ruleId)
          .where('organization_id', organizationId)
          .del(),
      ) || 0
    }

    await trx('automation_rules').where('id', ruleId).where('organization_id', organizationId).del()
    return { status: 'deleted' as const, logsKept, logsDeleted, scheduledStepsDeleted }
  })
}
