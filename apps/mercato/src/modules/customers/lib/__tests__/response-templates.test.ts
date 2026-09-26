import { fillResponseTemplate, normalizeResponseTemplateInput } from '../response-templates'

describe('normalizeResponseTemplateInput', () => {
  it('accepts a name and text, trims, and defaults the category', () => {
    expect(normalizeResponseTemplateInput({ name: '  Showing confirmation ', subject: ' ', bodyText: ' Hi {{firstName}} ' })).toEqual({
      ok: true,
      value: { name: 'Showing confirmation', subject: null, body_text: 'Hi {{firstName}}', category: 'general' },
    })
  })

  it('keeps a subject and category when given', () => {
    const r = normalizeResponseTemplateInput({ name: 'A', subject: 'Re: tour', bodyText: 'x', category: 'showings' })
    expect(r).toEqual({ ok: true, value: { name: 'A', subject: 'Re: tour', body_text: 'x', category: 'showings' } })
  })

  it.each([
    [{ bodyText: 'x' }, 'Give the template a name.'],
    [{ name: 'A' }, 'Write the template text.'],
    [{ name: 'A', bodyText: '   ' }, 'Write the template text.'],
    [null, 'Give the template a name.'],
    [{ name: 'x'.repeat(121), bodyText: 'y' }, 'Keep the name under 120 characters.'],
    [{ name: 'A', bodyText: 'y'.repeat(10001) }, 'Keep the text under 10000 characters.'],
  ])('rejects %j', (input, error) => {
    expect(normalizeResponseTemplateInput(input)).toEqual({ ok: false, error })
  })
})

describe('fillResponseTemplate', () => {
  it('fills the contact placeholders', () => {
    expect(fillResponseTemplate('Hi {{firstName}} ({{ name }}, {{email}})', { name: 'Jane Doe', email: 'jane@x.com' }))
      .toBe('Hi Jane (Jane Doe, jane@x.com)')
  })

  it('leaves blanks when the contact has no name or email', () => {
    expect(fillResponseTemplate('Hi {{firstName}},', { name: null, email: null })).toBe('Hi ,')
  })
})
