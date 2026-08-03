import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CRM_TOOLS, renderToolCatalogForPrompt } from '../crm-tool-catalog'
import {
  PUBLIC_CHAT_LAUNCH_CONTAINMENT,
  refusePublicChatAtLaunch,
} from '../public-chat-launch-containment'

describe('source-owned public-chat launch containment', () => {
  it('is an immutable, dependency-free fail-closed decision', async () => {
    expect(PUBLIC_CHAT_LAUNCH_CONTAINMENT).toEqual({ active: true, status: 404 })
    expect(Object.isFrozen(PUBLIC_CHAT_LAUNCH_CONTAINMENT)).toBe(true)

    const response = refusePublicChatAtLaunch()
    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(await response.json()).toEqual({ ok: false, error: 'Not found' })

    const source = readFileSync(join(__dirname, '../public-chat-launch-containment.ts'), 'utf8')
    for (const token of ['process.env', 'fetch(', 'createRequestContainer', 'getAuthFromCookies', 'knex', 'supabase']) {
      expect(source.toLowerCase()).not.toContain(token.toLowerCase())
    }
  })

  it('removes public-chat creation and dispatch from the CRM tool catalog', () => {
    const chatWidgetTool = CRM_TOOLS.find((tool) => tool.name === 'manage_chat_widget')
    expect(chatWidgetTool).toBeUndefined()
    expect(renderToolCatalogForPrompt()).not.toContain('manage_chat_widget')

    const inboxTool = CRM_TOOLS.find((tool) => tool.name === 'manage_inbox_conversation')
    expect(inboxTool).toBeDefined()
    const inboxParameters = inboxTool?.parameters as { properties: { channel?: { enum?: readonly string[] } } } | undefined
    const channel = inboxParameters?.properties.channel
    expect(channel?.enum).toEqual(['email', 'sms'])
  })
})
