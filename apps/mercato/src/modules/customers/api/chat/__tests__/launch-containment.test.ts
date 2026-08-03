import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as conversationsRoute from '../conversations/route'
import * as messagesRoute from '../messages/route'
import * as hostedPageRoute from '../page/[slug]/route'
import * as publicRoute from '../public/route'
import * as typingRoute from '../typing/route'
import * as widgetScriptRoute from '../widget/[widgetId]/route'
import * as widgetsRoute from '../widgets/route'

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const

type ContainedRoute = {
  metadata: Record<string, unknown>
} & Record<(typeof HTTP_METHODS)[number], (...args: unknown[]) => Response | Promise<Response>>

const routes: Array<{ name: string; module: ContainedRoute; source: string; requireAuth: boolean }> = [
  { name: 'public', module: publicRoute, source: join(__dirname, '../public/route.ts'), requireAuth: false },
  { name: 'typing', module: typingRoute, source: join(__dirname, '../typing/route.ts'), requireAuth: false },
  { name: 'hosted page', module: hostedPageRoute, source: join(__dirname, '../page/[slug]/route.ts'), requireAuth: false },
  { name: 'widget script', module: widgetScriptRoute, source: join(__dirname, '../widget/[widgetId]/route.ts'), requireAuth: false },
  { name: 'widgets', module: widgetsRoute, source: join(__dirname, '../widgets/route.ts'), requireAuth: true },
  { name: 'conversations', module: conversationsRoute, source: join(__dirname, '../conversations/route.ts'), requireAuth: true },
  { name: 'messages', module: messagesRoute, source: join(__dirname, '../messages/route.ts'), requireAuth: true },
]

function unreadableInput(label: string): unknown {
  return new Proxy({}, {
    get() {
      throw new Error(`${label} was read before containment`)
    },
  })
}

describe('public-chat launch containment routes', () => {
  it.each(routes)('$name refuses every method without reading request or route context', async ({ module, requireAuth }) => {
    for (const method of HTTP_METHODS) {
      expect(module.metadata[method]).toEqual({ requireAuth })

      const response = await module[method](unreadableInput('request'), unreadableInput('context'))
      expect(response.status).toBe(404)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('access-control-allow-origin')).toBeNull()
      expect(await response.json()).toEqual({ ok: false, error: 'Not found' })
    }
  })

  it.each(routes)('$name has no dependency, parsing, CORS, dispatch, or customer-mutation path', ({ source }) => {
    const routeSource = readFileSync(source, 'utf8')
    const forbidden = [
      'createRequestContainer',
      'getAuthFromCookies',
      'req.json',
      'request.json',
      'searchParams',
      'process.env',
      'crypto',
      'randomUUID',
      'Access-Control-Allow-Origin',
      'sendChatReply',
      'draftCustomerServiceChatReply',
      'getCustomerServiceChatSettings',
      'checkCustomersAiAllowance',
      'meterCustomersAi',
      'generateText',
      "knex('",
      '.insert(',
      '.update(',
      '.delete(',
    ]

    for (const token of forbidden) expect(routeSource).not.toContain(token)
    expect(routeSource).toContain('refusePublicChatAtLaunch')
  })
})
