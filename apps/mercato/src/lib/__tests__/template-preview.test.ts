import { previewFirstNameTags } from '../template-preview'

describe('previewFirstNameTags', () => {
  it('fills first-name tags with the name, or "there" without one', () => {
    expect(previewFirstNameTags('Hi {{first_name}},\nThanks')).toBe('Hi there,\nThanks')
    expect(previewFirstNameTags('Hi {{ firstName }} and {{entity.first_name}}', 'Ada')).toBe('Hi Ada and Ada')
    expect(previewFirstNameTags('Hi {{first_name}}', '  ')).toBe('Hi there')
  })

  it('leaves other tags and empty input alone', () => {
    expect(previewFirstNameTags('Book: {{sender.booking_url}}')).toBe('Book: {{sender.booking_url}}')
    expect(previewFirstNameTags(null)).toBe('')
  })
})
