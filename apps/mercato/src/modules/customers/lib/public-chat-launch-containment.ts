/**
 * Launch containment for the public-chat feature.
 *
 * This decision is intentionally source-owned and has no runtime dependency on
 * configuration, credentials, customer data, or provider availability. Routes
 * call this function before reading their request or constructing dependencies.
 */
export const PUBLIC_CHAT_LAUNCH_CONTAINMENT = Object.freeze({
  active: true,
  status: 404,
} as const)

const CONTAINED_RESPONSE_BODY = JSON.stringify({ ok: false, error: 'Not found' })

export function refusePublicChatAtLaunch(): Response {
  return new Response(CONTAINED_RESPONSE_BODY, {
    status: PUBLIC_CHAT_LAUNCH_CONTAINMENT.status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
