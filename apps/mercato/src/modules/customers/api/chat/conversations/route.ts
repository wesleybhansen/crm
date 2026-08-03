import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { refusePublicChatAtLaunch } from '@/modules/customers/lib/public-chat-launch-containment'

const authenticatedRoute = { requireAuth: true } as const

export const metadata = {
  path: '/chat/conversations',
  GET: authenticatedRoute,
  POST: authenticatedRoute,
  PUT: authenticatedRoute,
  PATCH: authenticatedRoute,
  DELETE: authenticatedRoute,
  HEAD: authenticatedRoute,
  OPTIONS: authenticatedRoute,
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
  summary: 'Public chat conversations are unavailable for launch',
  methods: {
    GET: { summary: 'Refuse public chat conversation access', tags: ['Chat'] },
    POST: { summary: 'Refuse public chat conversation creation', tags: ['Chat'] },
    PUT: { summary: 'Refuse public chat conversation updates', tags: ['Chat'] },
    PATCH: { summary: 'Refuse public chat conversation updates', tags: ['Chat'] },
    DELETE: { summary: 'Refuse public chat conversation deletion', tags: ['Chat'] },
  },
}
