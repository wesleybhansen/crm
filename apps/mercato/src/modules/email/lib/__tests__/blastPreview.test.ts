import { blastErrorMessage, fillBlastVariables, parseTestRecipient, PREVIEW_SAMPLE } from '../blastPreview'

describe('fillBlastVariables', () => {
  it('fills the subject the same way as the body', () => {
    expect(fillBlastVariables('Hi {{firstName}}, a note for {{name}} ({{email}})'))
      .toBe('Hi John, a note for John Smith (john@example.com)')
    expect(fillBlastVariables('{{ firstName }}, your March update')).toBe('John, your March update')
  })

  it('uses a given sample and leaves other text alone', () => {
    expect(fillBlastVariables('Hey {{firstName}} {{unknown}}', { ...PREVIEW_SAMPLE, firstName: 'Ana' })).toBe('Hey Ana {{unknown}}')
    expect(fillBlastVariables('')).toBe('')
  })
})

describe('parseTestRecipient', () => {
  it('accepts one address, trimmed', () => {
    expect(parseTestRecipient('  me@example.com ')).toBe('me@example.com')
  })
  it('rejects blanks, malformed input and lists', () => {
    expect(parseTestRecipient('')).toBeNull()
    expect(parseTestRecipient(undefined)).toBeNull()
    expect(parseTestRecipient('notanemail')).toBeNull()
    expect(parseTestRecipient('a@b.com, c@d.com')).toBeNull()
    expect(parseTestRecipient('a@b')).toBeNull()
  })
})

describe('blastErrorMessage', () => {
  it('prefers the server message and falls back otherwise', () => {
    expect(blastErrorMessage({ ok: false, error: 'Name is required' }, 'Could not save')).toBe('Name is required')
    expect(blastErrorMessage({ ok: false }, 'Could not save')).toBe('Could not save')
    expect(blastErrorMessage(null, 'Could not save')).toBe('Could not save')
  })
})
