import { formatActivityText, humanizeActivityType } from '../activityDisplay'

describe('humanizeActivityType', () => {
  it('names system activity types in plain English', () => {
    expect(humanizeActivityType('form_submission')).toBe('Form submission')
    expect(humanizeActivityType('survey_response')).toBe('Survey response')
  })
  it('turns other machine values into words', () => {
    expect(humanizeActivityType('follow_up_call')).toBe('Follow up call')
    expect(humanizeActivityType('call')).toBe('Call')
  })
  it('keeps values that already read as words', () => {
    expect(humanizeActivityType('Site visit')).toBe('Site visit')
  })
  it('handles empty input', () => {
    expect(humanizeActivityType(null)).toBe('')
  })
})

describe('formatActivityText', () => {
  it('passes strings through', () => {
    expect(formatActivityText('Name: Ada')).toBe('Name: Ada')
  })
  it('turns a stored JSON body (an object after decryption) into lines, never [object Object]', () => {
    const text = formatActivityText({ name: 'Ada', email: 'ada@example.com', topics: ['a', 'b'], _hp: 'x', funnel_sid: 's', blank: '' })
    expect(text).toBe('name: Ada\nemail: ada@example.com\ntopics: a, b')
    expect(text).not.toContain('[object Object]')
  })
  it('stringifies nested objects', () => {
    expect(formatActivityText({ meta: { a: 1 } })).toBe('meta: {"a":1}')
  })
  it('returns null for empty values', () => {
    expect(formatActivityText(null)).toBeNull()
    expect(formatActivityText({})).toBeNull()
  })
  it('keeps numbers', () => {
    expect(formatActivityText(42)).toBe('42')
  })
})
