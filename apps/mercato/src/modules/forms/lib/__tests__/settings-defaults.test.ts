import { BLANK_FORM_SETTINGS, formCapturesEmail, withNewFormDefaults } from '../settings-defaults'

const emailField = { type: 'email', label: 'Email', crm_mapping: 'contact.email' }
const nameField = { type: 'short_text', label: 'Name', crm_mapping: 'contact.first_name' }

describe('formCapturesEmail', () => {
  it('finds an email field by type or by contact-email mapping', () => {
    expect(formCapturesEmail([nameField, emailField])).toBe(true)
    expect(formCapturesEmail([{ type: 'short_text', crm_mapping: 'contact.email' }])).toBe(true)
    expect(formCapturesEmail([{ type: 'short_text', crmMapping: 'primary_email' }])).toBe(true)
  })

  it('is false for forms without one', () => {
    expect(formCapturesEmail([nameField, { type: 'rating' }])).toBe(false)
    expect(formCapturesEmail([])).toBe(false)
    expect(formCapturesEmail(null)).toBe(false)
  })
})

describe('withNewFormDefaults', () => {
  it('turns contact creation on for a new form that captures an email', () => {
    expect(withNewFormDefaults(undefined, [emailField])).toEqual({ createContact: true })
    expect(withNewFormDefaults({ submitLabel: 'Go' }, [emailField])).toEqual({ submitLabel: 'Go', createContact: true })
  })

  it('keeps an explicit choice', () => {
    expect(withNewFormDefaults({ createContact: false }, [emailField])).toEqual({ createContact: false })
    expect(withNewFormDefaults({ createContact: true }, [])).toEqual({ createContact: true })
  })

  it('leaves forms without an email field alone', () => {
    expect(withNewFormDefaults({ submitLabel: 'Go' }, [nameField])).toEqual({ submitLabel: 'Go' })
    expect(withNewFormDefaults(undefined, [])).toEqual({})
  })

  it('accepts settings sent as a JSON string', () => {
    expect(withNewFormDefaults(JSON.stringify({ submitLabel: 'Go' }), [emailField])).toEqual({ submitLabel: 'Go', createContact: true })
  })

  it('does not mutate the caller settings', () => {
    const settings = { submitLabel: 'Go' }
    withNewFormDefaults(settings, [emailField])
    expect(settings).toEqual({ submitLabel: 'Go' })
  })
})

describe('BLANK_FORM_SETTINGS', () => {
  it('starts a blank form with contact creation on', () => {
    expect(BLANK_FORM_SETTINGS.createContact).toBe(true)
  })
})
