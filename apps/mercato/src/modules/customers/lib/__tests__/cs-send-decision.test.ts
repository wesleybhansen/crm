import {
  decideStandardAutoSend,
  effectiveReplyMode,
  parseSourceModes,
  scheduledSendStillAllowed,
  sourceModesAfterSave,
  type StandardSendInput,
} from '../cs-send-decision'

function input(overrides: Partial<StandardSendInput> = {}): StandardSendInput {
  return {
    mode: 'draft',
    confidence: 0.95,
    autoSendSafe: true,
    threshold: 0.8,
    flag: null,
    audienceAction: null,
    ...overrides,
  }
}

const AUTO_SEND_FLAG = { shouldPause: false }
const PAUSE_FLAG = { shouldPause: true }

describe('Draft for approval never auto-sends', () => {
  it('holds a message that matched a flag scenario set to auto-send', () => {
    expect(decideStandardAutoSend(input({ mode: 'draft', flag: AUTO_SEND_FLAG }))).toBe(false)
  })

  it('holds a message from an auto-send audience', () => {
    expect(decideStandardAutoSend(input({ mode: 'draft', audienceAction: 'auto_send' }))).toBe(false)
  })

  it('holds a confident, safe draft with every override pointing at send', () => {
    expect(decideStandardAutoSend(input({ mode: 'draft', flag: AUTO_SEND_FLAG, audienceAction: 'auto_send', confidence: 1 }))).toBe(false)
  })

  it('treats an unknown or missing mode as draft', () => {
    expect(decideStandardAutoSend(input({ mode: '', flag: AUTO_SEND_FLAG }))).toBe(false)
    expect(decideStandardAutoSend(input({ mode: 'yolo', flag: AUTO_SEND_FLAG }))).toBe(false)
  })
})

describe('auto and hybrid keep their rules', () => {
  it('auto sends a parsed draft and holds a raw one', () => {
    expect(decideStandardAutoSend(input({ mode: 'auto' }))).toBe(true)
    expect(decideStandardAutoSend(input({ mode: 'auto', confidence: 0, autoSendSafe: false }))).toBe(false)
  })

  it('hybrid sends only confident, safe drafts', () => {
    expect(decideStandardAutoSend(input({ mode: 'hybrid', confidence: 0.9 }))).toBe(true)
    expect(decideStandardAutoSend(input({ mode: 'hybrid', confidence: 0.5 }))).toBe(false)
    expect(decideStandardAutoSend(input({ mode: 'hybrid', autoSendSafe: false }))).toBe(false)
  })

  it('a flag scenario set to auto-send lets a held hybrid draft go', () => {
    expect(decideStandardAutoSend(input({ mode: 'hybrid', confidence: 0.2, flag: AUTO_SEND_FLAG }))).toBe(true)
  })

  it('a flag scenario set to pause holds even in auto', () => {
    expect(decideStandardAutoSend(input({ mode: 'auto', flag: PAUSE_FLAG }))).toBe(false)
  })

  it('a review-first audience holds; a trusted audience skips the hybrid gate but not a pause', () => {
    expect(decideStandardAutoSend(input({ mode: 'auto', audienceAction: 'pause' }))).toBe(false)
    expect(decideStandardAutoSend(input({ mode: 'hybrid', confidence: 0.1, audienceAction: 'auto_send' }))).toBe(true)
    expect(decideStandardAutoSend(input({ mode: 'hybrid', audienceAction: 'auto_send', flag: PAUSE_FLAG }))).toBe(false)
  })
})

describe('the held-reply (scheduled send) job re-checks the mode', () => {
  it('does not send once the owner is in Draft for approval', () => {
    expect(scheduledSendStillAllowed({ globalMode: 'draft', sourceModes: {} })).toBe(false)
  })

  it('still sends in auto, hybrid and assisted', () => {
    for (const mode of ['auto', 'hybrid', 'assisted']) {
      expect(scheduledSendStillAllowed({ globalMode: mode, sourceModes: {} })).toBe(true)
    }
  })

  it('follows the per-mailbox override of the mailbox the message came in on', () => {
    const sourceModes = parseSourceModes({ 'conn-a': { mode: 'draft', threshold: 0.8 } })
    expect(scheduledSendStillAllowed({ globalMode: 'auto', sourceModes, sourceConnectionId: 'conn-a' })).toBe(false)
    expect(scheduledSendStillAllowed({ globalMode: 'auto', sourceModes, sourceConnectionId: 'conn-b' })).toBe(true)
  })

  it('treats an unknown stored mode as draft', () => {
    expect(scheduledSendStillAllowed({ globalMode: null, sourceModes: {} })).toBe(false)
    expect(effectiveReplyMode('bogus', {}, null)).toBe('draft')
  })

  it('parses stored overrides from a JSON string and drops invalid ones', () => {
    expect(parseSourceModes('{"a":{"mode":"hybrid","threshold":2},"b":{"mode":"nope"}}')).toEqual({ a: { mode: 'hybrid', threshold: 1 } })
    expect(parseSourceModes('not json')).toEqual({})
  })
})

describe('sourceModesAfterSave (per-mailbox overrides)', () => {
  const saved = { 'conn-a': { mode: 'auto' as const, threshold: 0.8 }, 'conn-b': { mode: 'hybrid' as const, threshold: 0.9 } }

  it('clears every override when the owner changes the account-wide mode', () => {
    expect(sourceModesAfterSave({ previousMode: 'auto', nextMode: 'draft', saved, watched: ['conn-a', 'conn-b'] })).toEqual({})
  })

  it('keeps the overrides (pruned to watched mailboxes) when the mode is unchanged', () => {
    expect(sourceModesAfterSave({ previousMode: 'draft', nextMode: 'draft', saved, watched: ['conn-a'] })).toEqual({ 'conn-a': saved['conn-a'] })
  })

  it('an explicit request in the same save wins, including an empty map', () => {
    expect(sourceModesAfterSave({ previousMode: 'draft', nextMode: 'draft', requested: {}, saved, watched: ['conn-a'] })).toEqual({})
    const requested = { 'conn-a': { mode: 'hybrid' as const, threshold: 0.7 } }
    expect(sourceModesAfterSave({ previousMode: 'draft', nextMode: 'auto', requested, saved, watched: ['conn-a'] })).toEqual(requested)
  })

  it('a first save (no saved row) keeps whatever was saved before, pruned', () => {
    expect(sourceModesAfterSave({ previousMode: undefined, nextMode: 'auto', saved: {}, watched: [] })).toEqual({})
  })
})
