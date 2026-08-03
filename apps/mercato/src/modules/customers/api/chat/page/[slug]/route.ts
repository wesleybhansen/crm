import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { refusePublicChatAtLaunch } from '@/modules/customers/lib/public-chat-launch-containment'

const publicRoute = { requireAuth: false } as const

export const metadata = {
  path: '/chat/page/[slug]',
  GET: publicRoute,
  POST: publicRoute,
  PUT: publicRoute,
  PATCH: publicRoute,
  DELETE: publicRoute,
  HEAD: publicRoute,
  OPTIONS: publicRoute,
}

export const GET = refusePublicChatAtLaunch
export const POST = refusePublicChatAtLaunch
export const PUT = refusePublicChatAtLaunch
export const PATCH = refusePublicChatAtLaunch
export const DELETE = refusePublicChatAtLaunch
export const HEAD = refusePublicChatAtLaunch
export const OPTIONS = refusePublicChatAtLaunch

export const openApi: OpenApiRouteDoc = {
  tag: 'Chat',
  summary: 'Hosted public chat pages are unavailable for launch',
  methods: {
    GET: { summary: 'Refuse hosted public chat access', tags: ['Chat'] },
    POST: { summary: 'Refuse hosted public chat mutations', tags: ['Chat'] },
    PUT: { summary: 'Refuse hosted public chat mutations', tags: ['Chat'] },
    PATCH: { summary: 'Refuse hosted public chat mutations', tags: ['Chat'] },
    DELETE: { summary: 'Refuse hosted public chat mutations', tags: ['Chat'] },
  },
}
