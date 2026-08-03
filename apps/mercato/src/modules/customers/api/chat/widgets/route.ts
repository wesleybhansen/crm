import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { refusePublicChatAtLaunch } from '@/modules/customers/lib/public-chat-launch-containment'

const authenticatedRoute = { requireAuth: true } as const

export const metadata = {
  path: '/chat/widgets',
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
  summary: 'Public chat widget management is unavailable for launch',
  methods: {
    GET: { summary: 'Refuse public chat widget management', tags: ['Chat'] },
    POST: { summary: 'Refuse public chat widget creation', tags: ['Chat'] },
    PUT: { summary: 'Refuse public chat widget updates', tags: ['Chat'] },
    PATCH: { summary: 'Refuse public chat widget updates', tags: ['Chat'] },
    DELETE: { summary: 'Refuse public chat widget deletion', tags: ['Chat'] },
  },
}
