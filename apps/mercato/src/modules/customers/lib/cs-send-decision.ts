/* The draft / auto / hybrid send decision, shared by the Customer Service
 * engine (email + SMS) and the personal Inbox engine. Assisted mode has its
 * own decision (decideAssistedSend in assisted-send.ts).
 *
 * "Draft for approval" is absolute: nothing sends on its own, whatever a flag
 * scenario set to auto-send or an auto-send audience says. A flag scenario's
 * auto-send used to force a send in draft mode too.
 *
 * Pure and dependency-free (worker-safe). */

export const REPLY_MODES = ['draft', 'auto', 'hybrid', 'assisted'] as const
export type ReplyMode = (typeof REPLY_MODES)[number]

const MODE_SET = new Set<string>(REPLY_MODES)
const DEFAULT_THRESHOLD = 0.8

export function isReplyMode(value: unknown): value is ReplyMode {
  return typeof value === 'string' && MODE_SET.has(value)
}

export type StandardSendInput = {
  mode: string
  // Drafter signals. confidence 0 means the envelope did not parse (raw text).
  confidence: number
  autoSendSafe: boolean
  // Hybrid confidence cutoff.
  threshold: number
  // Matched flag scenarios: shouldPause when ANY matched scenario pauses.
  flag: { shouldPause: boolean } | null
  // Sender audience action ('pause' | 'auto_send' | 'no_draft' | null).
  audienceAction?: string | null
}

export function decideStandardAutoSend(input: StandardSendInput): boolean {
  // Only auto and hybrid ever send on their own. Draft (and anything unknown)
  // never does, so no override below can turn a send on for it.
  if (input.mode !== 'auto' && input.mode !== 'hybrid') return false

  let send =
    input.mode === 'auto'
      ? input.confidence > 0
      : input.autoSendSafe === true && input.confidence >= input.threshold

  // Flag scenarios: pause wins; all matched set to auto-send let it go.
  if (input.flag) send = !input.flag.shouldPause
  // Review-first audience always holds.
  if (input.audienceAction === 'pause') send = false
  // Trusted audience skips the hybrid confidence gate, never over a content pause.
  if (input.audienceAction === 'auto_send' && input.mode === 'hybrid' && !input.flag?.shouldPause) send = true
  return send
}

export type SourceModes = Record<string, { mode: ReplyMode; threshold: number }>

/** Per-mailbox overrides keyed by email connection id (jsonb, parsed or string). */
export function parseSourceModes(raw: unknown): SourceModes {
  let obj: unknown = raw
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj)
    } catch {
      return {}
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {}
  const out: SourceModes = {}
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const mode = (value as { mode?: unknown }).mode
    if (!isReplyMode(mode)) continue
    const t = Number((value as { threshold?: unknown }).threshold)
    out[key] = { mode, threshold: Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : DEFAULT_THRESHOLD }
  }
  return out
}

/** The reply mode that applies to mail from one mailbox: its override when it
 * has one, else the account-wide mode. Unknown values fall back to draft. */
export function effectiveReplyMode(globalMode: unknown, sourceModes: SourceModes, connectionId: string | null | undefined): ReplyMode {
  if (connectionId && sourceModes[connectionId]) return sourceModes[connectionId].mode
  return isReplyMode(globalMode) ? globalMode : 'draft'
}

/** Whether a held (scheduled) reply may still go out when its hold window
 * ends. The mode is re-read at send time: if the owner has since switched to
 * Draft for approval, the reply stays a draft. */
export function scheduledSendStillAllowed(input: {
  globalMode: unknown
  sourceModes: SourceModes
  sourceConnectionId?: string | null
}): boolean {
  return effectiveReplyMode(input.globalMode, input.sourceModes, input.sourceConnectionId ?? null) !== 'draft'
}
