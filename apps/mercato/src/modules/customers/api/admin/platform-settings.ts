import { query, queryOne } from '@/lib/db'

export const GLOBAL_AI_CAP_KEY = 'global_ai_monthly_cap'

/**
 * The global monthly AI cap, or null when none is set. platform_settings was
 * read by the admin panel before any migration created it, which turned the
 * whole panel into a 500. A missing table or row now reads as "not set" and is
 * logged, so the rest of the panel still loads.
 */
export async function readGlobalAiCap(): Promise<number | null> {
  try {
    const row = await queryOne(`SELECT setting_value FROM platform_settings WHERE setting_key = $1`, [GLOBAL_AI_CAP_KEY])
    const value = row?.setting_value ? parseInt(String(row.setting_value), 10) : NaN
    return Number.isFinite(value) ? value : null
  } catch (error) {
    console.error('[admin.platform_settings] read failed', error)
    return null
  }
}

/** Upsert, so setting the cap works even before the row was seeded. */
export async function writeGlobalAiCap(cap: number): Promise<void> {
  await query(
    `INSERT INTO platform_settings (setting_key, setting_value, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = now()`,
    [GLOBAL_AI_CAP_KEY, String(cap)],
  )
}
