import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { refusePublicChatAtLaunch } from '@/modules/customers/lib/public-chat-launch-containment'

const publicRoute = { requireAuth: false } as const

export const metadata = {
  path: '/chat/public',
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
  summary: 'Public chat is unavailable for launch',
  methods: {
    GET: { summary: 'Refuse public chat access', tags: ['Chat'] },
    POST: { summary: 'Refuse public chat messages', tags: ['Chat'] },
    PUT: { summary: 'Refuse public chat mutations', tags: ['Chat'] },
    PATCH: { summary: 'Refuse public chat mutations', tags: ['Chat'] },
    DELETE: { summary: 'Refuse public chat mutations', tags: ['Chat'] },
  },
}
