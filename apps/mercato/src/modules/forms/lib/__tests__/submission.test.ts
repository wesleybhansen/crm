import { isValidEmail, summarizeFormSubmission, validateFormSubmission } from '../submission'

const fields = [
  { id: 'f_name', type: 'short_text', label: 'Full Name', required: true },
  { id: 'f_email', type: 'email', label: 'Email', required: true },
  { id: 'f_work', type: 'email', label: 'Work Email', required: false },
  { id: 'f_age', type: 'number', label: 'Age', required: false, validation: { min: 18, max: 120 } },
  { id: 'f_topics', type: 'multi_select', label: 'Topics', required: false },
  { id: 's1', type: 'section', label: 'About you', required: true },
]

describe('validateFormSubmission', () => {
  it('accepts a complete, valid submission', () => {
    expect(validateFormSubmission(fields, { f_name: 'Ada', f_email: 'ada@example.com' })).toEqual({ ok: true })
  })

  it('rejects an invalid email with a plain-English message on that field', () => {
    const result = validateFormSubmission(fields, { f_name: 'Ada', f_email: 'notanemail' })
    expect(result).toEqual({ ok: false, field: 'f_email', error: 'Enter a valid email address, like name@example.com.' })
  })

  it('rejects an email with no domain dot or with spaces', () => {
    expect(validateFormSubmission(fields, { f_name: 'Ada', f_email: 'ada@example' }).ok).toBe(false)
    expect(validateFormSubmission(fields, { f_name: 'Ada', f_email: 'ada @example.com' }).ok).toBe(false)
  })

  it('checks optional email fields only when filled in', () => {
    expect(validateFormSubmission(fields, { f_name: 'Ada', f_email: 'ada@example.com', f_work: '' }).ok).toBe(true)
    expect(validateFormSubmission(fields, { f_name: 'Ada', f_email: 'ada@example.com', f_work: 'nope' })).toMatchObject({ ok: false, field: 'f_work' })
  })

  it('treats blank and whitespace answers as missing for required fields', () => {
    expect(validateFormSubmission(fields, { f_name: '   ', f_email: 'ada@example.com' })).toEqual({ ok: false, field: 'f_name', error: 'Full Name is required.' })
    expect(validateFormSubmission(fields, { f_email: 'ada@example.com' })).toMatchObject({ ok: false, field: 'f_name' })
  })

  it('skips layout fields even when marked required', () => {
    expect(validateFormSubmission(fields, { f_name: 'Ada', f_email: 'ada@example.com' }).ok).toBe(true)
  })

  it('checks numbers and their limits', () => {
    const base = { f_name: 'Ada', f_email: 'ada@example.com' }
    expect(validateFormSubmission(fields, { ...base, f_age: 'abc' })).toMatchObject({ ok: false, error: 'Age must be a number.' })
    expect(validateFormSubmission(fields, { ...base, f_age: '12' })).toMatchObject({ ok: false, error: 'Age must be 18 or more.' })
    expect(validateFormSubmission(fields, { ...base, f_age: '200' })).toMatchObject({ ok: false, error: 'Age must be 120 or less.' })
    expect(validateFormSubmission(fields, { ...base, f_age: '40' }).ok).toBe(true)
  })

  it('isValidEmail trims and requires a string', () => {
    expect(isValidEmail(' ada@example.com ')).toBe(true)
    expect(isValidEmail(42)).toBe(false)
    expect(isValidEmail(null)).toBe(false)
  })
})

describe('summarizeFormSubmission', () => {
  it('writes one "Label: answer" line per answered field, in form order', () => {
    const text = summarizeFormSubmission(fields, {
      f_email: 'ada@example.com',
      f_name: 'Ada Lovelace',
      f_topics: ['Pricing', 'Demo'],
      f_work: '',
      _hp: 'bot',
      funnel_sid: 'abc',
      extra: 'kept',
    })
    expect(text).toBe('Full Name: Ada Lovelace\nEmail: ada@example.com\nTopics: Pricing, Demo\nextra: kept')
  })

  it('returns an empty string when nothing was answered', () => {
    expect(summarizeFormSubmission(fields, {})).toBe('')
  })

  it('never produces [object Object]', () => {
    const text = summarizeFormSubmission([{ id: 'x', type: 'short_text', label: 'X' }], { x: { a: 1 } })
    expect(text).not.toContain('[object Object]')
  })
})
