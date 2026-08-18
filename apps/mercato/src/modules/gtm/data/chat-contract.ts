export const GTM_CHAT_CONTENT_MAX_BYTES = 64 * 1024
export const GTM_CHAT_MESSAGE_READ_CAP = 200

export function chatContentSizeBytes(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value)
    if (typeof serialized !== 'string') return null
    return new TextEncoder().encode(serialized).byteLength
  } catch {
    return null
  }
}

export function chatContentIsBounded(value: unknown): boolean {
  const size = chatContentSizeBytes(value)
  return size !== null && size <= GTM_CHAT_CONTENT_MAX_BYTES
}
