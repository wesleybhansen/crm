import { shouldRegenerateSlug, slugBase, slugifyFormName } from '../slug'

describe('form slug rules', () => {
  it('builds a slug from the name with a short suffix', () => {
    expect(slugifyFormName('Contact Us!')).toMatch(/^contact-us-[a-z0-9]{1,4}$/)
    expect(slugifyFormName('!!!')).toMatch(/^form-[a-z0-9]{1,4}$/)
    expect(slugBase('  Hello  World ')).toBe('hello-world')
  })

  it('renames the slug while the form has never been published', () => {
    expect(shouldRegenerateSlug({ name: 'Untitled Form', status: 'draft', published_at: null }, 'Contact Us')).toBe(true)
  })

  it('keeps the slug once the form is published', () => {
    expect(shouldRegenerateSlug({ name: 'Untitled Form', status: 'published', published_at: new Date() }, 'Contact Us')).toBe(false)
  })

  it('keeps the slug for a form that was published and later unpublished', () => {
    expect(shouldRegenerateSlug({ name: 'Old', status: 'draft', published_at: '2026-09-01T00:00:00Z' }, 'New')).toBe(false)
  })

  it('does nothing when the name does not really change or is blank', () => {
    expect(shouldRegenerateSlug({ name: 'Contact Us', status: 'draft', published_at: null }, 'contact us')).toBe(false)
    expect(shouldRegenerateSlug({ name: 'Contact Us', status: 'draft', published_at: null }, '   ')).toBe(false)
    expect(shouldRegenerateSlug({ name: 'Contact Us', status: 'draft', published_at: null }, undefined)).toBe(false)
  })
})
