import { NextResponse } from 'next/server'
import { createHash, timingSafeEqual } from 'crypto'
import { readFile } from 'fs/promises'

export const metadata = {
  path: '/internal/backup-status',
  POST: { requireAuth: false },
}

/**
 * Backup freshness for the hub's ops-health cron. The nightly backup on the
 * box writes /root/backups/status.json; docker-compose mounts it read-only at
 * /backups/status.json. Same shared-secret auth as the other /internal/*,
 * and POST like them: the API dispatcher does not serve GET on this tree.
 */
export async function POST(req: Request) {
  const secret = process.env.NOLI_INTERNAL_SERVICE_SECRET
  const authHeader = (req.headers.get('authorization') || '').trim()
  const expected = secret ? `Bearer ${secret}` : ''
  const digest = (v: string) => createHash('sha256').update(v).digest()
  if (!secret || !timingSafeEqual(digest(authHeader), digest(expected))) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const raw = await readFile(process.env.BACKUP_STATUS_FILE || '/backups/status.json', 'utf8')
    const status = JSON.parse(raw) as Record<string, unknown>
    return NextResponse.json({ ok: true, status })
  } catch {
    return NextResponse.json({ ok: false, error: 'status_unavailable' }, { status: 503 })
  }
}
