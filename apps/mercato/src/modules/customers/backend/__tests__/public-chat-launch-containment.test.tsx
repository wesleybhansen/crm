import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const assistantSource = readFileSync(join(__dirname, '../assistant/page.tsx'), 'utf8')
const chatPageSource = readFileSync(join(__dirname, '../chat/page.tsx'), 'utf8')
const customerServiceSource = readFileSync(join(__dirname, '../customer-service/page.tsx'), 'utf8')
const customerServiceSettingsRouteSource = readFileSync(join(__dirname, '../../api/customer-service/settings/route.ts'), 'utf8')

describe('public-chat launch containment UI', () => {
  it('makes the public-chat management page fail closed without client controls', () => {
    expect(chatPageSource).toContain("import { notFound } from 'next/navigation'")
    expect(chatPageSource).toContain('notFound()')
    expect(chatPageSource).not.toContain("'use client'")
    expect(chatPageSource).not.toContain('/api/chat')
    expect(chatPageSource).not.toContain('fetch(')
  })

  it('removes every public-chat control and dispatch from Customer Service', () => {
    const forbidden = [
      '/api/chat',
      'csChatEnabled',
      'ChatWidget',
      'Website chat',
      'Create a chat widget',
      'Hosted chat page',
      'Embed code',
    ]

    for (const token of forbidden) expect(customerServiceSource).not.toContain(token)
    expect(customerServiceSource).toContain('/api/customer-service/settings')
    expect(customerServiceSource).toContain('/api/email/connections')
    expect(customerServiceSource).toContain('/api/twilio/connections')
  })

  it('preserves the existing public-chat setting when unrelated settings autosave', () => {
    expect(customerServiceSource).not.toContain('csChatEnabled')
    expect(customerServiceSettingsRouteSource).toContain('body.csChatEnabled !== undefined')
    expect(customerServiceSettingsRouteSource).toContain(': !!existing?.cs_chat_enabled')
  })

  it('removes public-chat actions from Scout while preserving unrelated actions', () => {
    expect(assistantSource).not.toContain('manage_chat_widget')
    expect(assistantSource).not.toContain('/api/chat/widgets')
    expect(assistantSource).not.toContain('/api/chat/conversations')
    expect(assistantSource).not.toContain('/api/chat/messages')
    expect(assistantSource).toContain('/api/ai/assistant')
    expect(assistantSource).toContain('/api/courses')
    expect(assistantSource).toContain('manage_landing_page')
    expect(assistantSource).toContain('manage_inbox_conversation')
  })
})
