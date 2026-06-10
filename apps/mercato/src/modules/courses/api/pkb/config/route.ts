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

// GET: Check if PKB is configured
export async function GET(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const profile = await knex('business_profiles').where('organization_id', auth.orgId).first()
    return NextResponse.json({
      ok: true,
      data: { configured: !!profile?.pkb_api_key },
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
    const profile = await knex('business_profiles').where('organization_id', auth.orgId).first()

    if (!profile?.pkb_api_key) {
      return NextResponse.json({ ok: false, error: 'PKB API key not configured' }, { status: 400 })
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)

    const res = await fetch(`${PKB_URL}/api/documents/export`, {
      headers: { 'Authorization': `Bearer ${profile.pkb_api_key}` },
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
