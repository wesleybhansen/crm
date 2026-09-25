/** @jest-environment node */
import { automationStatusHint, initialAutomationStatus, stepsSendEmail } from '../automation-status'

const EMAIL = [{ type: 'action', actionType: 'send_email' }]
const SURVEY = [{ type: 'delay' }, { type: 'action', actionType: 'send_survey' }]
const TASK = [{ type: 'action', actionType: 'create_task' }]

describe('stepsSendEmail', () => {
  it('detects email and survey actions only', () => {
    expect(stepsSendEmail(EMAIL)).toBe(true)
    expect(stepsSendEmail(SURVEY)).toBe(true)
    expect(stepsSendEmail(TASK)).toBe(false)
    expect(stepsSendEmail(null)).toBe(false)
  })
})

describe('initialAutomationStatus', () => {
  it('starts a new email automation paused when email is not connected', () => {
    expect(initialAutomationStatus({ isNew: true, requested: 'active', steps: EMAIL, emailConnected: false })).toBe('paused')
  })
  it('keeps active when email is connected or unknown', () => {
    expect(initialAutomationStatus({ isNew: true, requested: 'active', steps: EMAIL, emailConnected: true })).toBe('active')
    expect(initialAutomationStatus({ isNew: true, requested: 'active', steps: EMAIL, emailConnected: null })).toBe('active')
  })
  it('keeps active for a new automation that sends no email', () => {
    expect(initialAutomationStatus({ isNew: true, requested: 'active', steps: TASK, emailConnected: false })).toBe('active')
  })
  it('never changes an existing rule', () => {
    expect(initialAutomationStatus({ isNew: false, requested: 'active', steps: EMAIL, emailConnected: false })).toBe('active')
    expect(initialAutomationStatus({ isNew: false, requested: 'paused', steps: TASK, emailConnected: true })).toBe('paused')
  })
})

describe('automationStatusHint', () => {
  it('explains the paused default instead of promising it will run', () => {
    const hint = automationStatusHint({ status: 'paused', steps: EMAIL, emailConnected: false })
    expect(hint.warning).toBe(true)
    expect(hint.text).toMatch(/email isn't connected/i)
    expect(hint.text).not.toMatch(/run immediately/)
  })
  it('warns when switched on without email', () => {
    expect(automationStatusHint({ status: 'active', steps: EMAIL, emailConnected: false }).text).toMatch(/can't be turned on yet/)
  })
  it('keeps the plain copy otherwise', () => {
    expect(automationStatusHint({ status: 'active', steps: TASK, emailConnected: false })).toEqual({ text: 'Automation will run immediately', warning: false })
    expect(automationStatusHint({ status: 'paused', steps: EMAIL, emailConnected: true })).toEqual({ text: 'Automation is paused', warning: false })
  })
})
