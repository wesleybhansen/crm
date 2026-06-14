import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

const PKB_URL = process.env.NOLI_KB_BASE_URL ?? 'https://kb.noliai.com'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['courses.manage'] },
  PUT: { requireAuth: true, requireFeatures: ['courses.manage'] },
  POST: { requireAuth: true, requireFeatures: ['courses.manage'] },
}

// GET: Check if PKB is configured. Auto-connect on the way: if there's no
// cached/pasted key, try to mint one from KB so the Knowledge Base shows as
// connected with no manual paste. Falls back to false if KB is unreachable.
export async function GET(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const { ensureKbApiKey } = await import('@/modules/courses/lib/kb-connect')
    const apiKey = await ensureKbApiKey(
      knex,
      auth.orgId as string,
      (auth.noliUserId as string | undefined) ?? null,
      (auth.tenantId as string | undefined) ?? null,
    )
    return NextResponse.json({
      ok: true,
      data: { configured: !!apiKey },
    })
  } catch (error) {
    console.error('[pkb.config.get]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

// PUT: Save PKB API key
export async function PUT(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { apiKey } = body

    await knex('business_profiles').where('organization_id', auth.orgId).update({
      pkb_api_key: apiKey?.trim() || null,
    })

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[pkb.config.put]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

// POST: Test PKB connection
export async function POST(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Auto-connect: use the cached/pasted key if present, else mint one from KB.
    const { ensureKbApiKey } = await import('@/modules/courses/lib/kb-connect')
    const apiKey = await ensureKbApiKey(
      knex,
      auth.orgId as string,
      (auth.noliUserId as string | undefined) ?? null,
      (auth.tenantId as string | undefined) ?? null,
    )

    if (!apiKey) {
      return NextResponse.json({ ok: false, error: 'Could not connect to your Knowledge Base. Try again in a moment.' }, { status: 502 })
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)

    const res = await fetch(`${PKB_URL}/api/documents/export`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!res.ok) {
      return NextResponse.json({ ok: false, error: `Connection failed (${res.status}). Check your API key.` }, { status: 400 })
    }

    const data = await res.json()
    const docCount = Array.isArray(data) ? data.length : (data.data?.length || 0)

    return NextResponse.json({ ok: true, data: { connected: true, documentCount: docCount } })
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      return NextResponse.json({ ok: false, error: 'Connection timed out' }, { status: 408 })
    }
    console.error('[pkb.config.test]', error)
    return NextResponse.json({ ok: false, error: 'Connection failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Courses', summary: 'PKB configuration',
  methods: {
    GET: { summary: 'Get PKB config status', tags: ['Courses'] },
    PUT: { summary: 'Save PKB API key', tags: ['Courses'] },
    POST: { summary: 'Test PKB connection', tags: ['Courses'] },
  },
}
