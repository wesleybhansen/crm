import { formatIcuMessage } from '../icu'
import { createTranslator, translateWithFallback } from '../translate'

describe('formatIcuMessage', () => {
  const personCreated = '{contactName} was added{sourceLabel, select, other { {sourceLabel}}}'

  it('renders a select suffix when the value is present', () => {
    expect(formatIcuMessage(personCreated, { contactName: 'Test Contact', sourceLabel: 'from manual' }))
      .toBe('Test Contact was added from manual')
  })

  it('drops a select suffix when the value is empty or missing', () => {
    expect(formatIcuMessage(personCreated, { contactName: 'Ann', sourceLabel: '' })).toBe('Ann was added')
    expect(formatIcuMessage(personCreated, { contactName: 'Ann' })).toBe('Ann was added')
  })

  it('picks an exact select branch before other', () => {
    const tpl = '{kind, select, deal {a deal} other {something}}'
    expect(formatIcuMessage(tpl, { kind: 'deal' })).toBe('a deal')
    expect(formatIcuMessage(tpl, { kind: 'task' })).toBe('something')
  })

  it('renders plural with exact, category and # substitution', () => {
    const tpl = 'You have {count, plural, =0 {no tasks} one {# task} other {# tasks}}'
    expect(formatIcuMessage(tpl, { count: 0 })).toBe('You have no tasks')
    expect(formatIcuMessage(tpl, { count: 1 })).toBe('You have 1 task')
    expect(formatIcuMessage(tpl, { count: 4 })).toBe('You have 4 tasks')
  })

  it('keeps the old simple substitution behavior', () => {
    expect(formatIcuMessage('Hi {name} and {{other}}', { name: 'Wes', other: 'Ann' })).toBe('Hi Wes and Ann')
    expect(formatIcuMessage('Hi {name} {unknown} {{gone}}', { name: 'Wes' })).toBe('Hi Wes {unknown} {{gone}}')
    expect(formatIcuMessage('no params {x}', undefined)).toBe('no params {x}')
  })

  it('leaves unparseable braces as written', () => {
    expect(formatIcuMessage('JSON {"a": 1} and {name}', { name: 'x' })).toBe('JSON {"a": 1} and x')
    expect(formatIcuMessage('open { brace {name}', { name: 'x' })).toBe('open { brace {name}')
  })

  it('handles every select template shipped in the notification dictionaries', () => {
    expect(formatIcuMessage('{dealTitle} has been marked as won{dealValue, select, other { ({dealValue})}}', { dealTitle: 'Big', dealValue: '$5' }))
      .toBe('Big has been marked as won ($5)')
    expect(formatIcuMessage('{productName}{sku, select, other { ({sku})}} is low', { productName: 'Mug', sku: '' }))
      .toBe('Mug is low')
  })
})

describe('translator integration', () => {
  it('createTranslator and translateWithFallback render ICU selects', () => {
    const t = createTranslator({ k: '{name} was added{src, select, other { {src}}}' })
    expect(t('k', { name: 'Ann', src: 'manually' })).toBe('Ann was added manually')
    expect(translateWithFallback(t, 'missing', '{n, plural, one {# item} other {# items}}', { n: 2 })).toBe('2 items')
  })
})
