import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { isThreadsDeletionConfirmationCode } from '../../lib/social/threads-callbacks'

export const openApi: OpenApiRouteDoc = {
  tag: 'GTM Sources',
  summary: 'Human-readable status page for a Threads data deletion request',
  methods: { GET: { summary: 'Threads deletion status', tags: ['GTM Sources'] } },
}

export const metadata = {
  path: '/gtm/threads/deletion-status',
  GET: { requireAuth: false },
}

function page(title: string, body: string, status = 200) {
  return new NextResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
    `<meta name="robots" content="noindex"><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#111}</style></head>` +
    `<body><h1>${title}</h1><p>${body}</p></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  )
}

export async function GET(req: Request) {
  const code = new URL(req.url).searchParams.get('code')
  if (!isThreadsDeletionConfirmationCode(code)) {
    return page('Deletion request not found', 'This confirmation code is not valid.', 404)
  }
  try {
    const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const { GtmSocialConnection } = await import('../../data/entities')
    const rows = await em.find(GtmSocialConnection, { statusReason: `meta_data_deletion:${code}` })
    if (rows.length === 0) {
      return page('Deletion request not found', 'This confirmation code is not valid.', 404)
    }
    const stillHoldingData = rows.some((row) => row.accessTokenSealed !== '' || row.username != null)
    return page(
      stillHoldingData ? 'Deletion in progress' : 'Deletion complete',
      stillHoldingData
        ? `Your request (code ${code}) is being processed.`
        : `Your Threads data has been removed from Noli. Confirmation code ${code}.`,
    )
  } catch (error) {
    console.error('[gtm.threads.deletion-status] failed', error)
    return page('Temporarily unavailable', 'Please try again shortly.', 500)
  }
}
