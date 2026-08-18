import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export function gtmInternalOpenApi(summary: string): OpenApiRouteDoc {
  return {
    tag: 'GTM Internal',
    summary,
    methods: { POST: { summary, tags: ['GTM Internal'] } },
  }
}

export const gtmUnsubscribeOpenApi: OpenApiRouteDoc = {
  tag: 'GTM Compliance',
  summary: 'Apply a scoped GTM unsubscribe token',
  methods: {
    GET: { summary: 'Apply an unsubscribe link', tags: ['GTM Compliance'] },
    POST: { summary: 'Apply a one-click unsubscribe', tags: ['GTM Compliance'] },
  },
}
