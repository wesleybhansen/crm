import type { TranslateParams } from './context'

/**
 * A small ICU MessageFormat subset for translation templates.
 *
 * The translators only replaced `{name}` / `{{name}}`, so templates using
 * `{name, select, other { ...}}` rendered raw, for example a notification that
 * read "Test Contact was added{sourceLabel, select, other { from manual}}".
 *
 * Supported:
 * - `{name}` and `{{name}}` substitution (unknown names are handled by
 *   `onMissing`, so each caller keeps its existing behavior).
 * - `{name, select, key {...} other {...}}`. An empty or missing value renders
 *   nothing: every select in the dictionaries is an "append this when the value
 *   is present" suffix, which is how their authors meant them to read.
 * - `{name, plural, =0 {...} one {...} other {...}}` with `#` for the number.
 *
 * Branch bodies are formatted recursively. Anything that does not parse as one
 * of these is left exactly as written.
 */
export function formatIcuMessage(
  template: string,
  params: TranslateParams | undefined,
  onMissing: (key: string, doubleBraced: boolean) => string = (key, doubleBraced) =>
    doubleBraced ? `{{${key}}}` : `{${key}}`,
  locale = 'en',
): string {
  if (!params) return template
  let out = ''
  let i = 0
  while (i < template.length) {
    const ch = template[i]
    if (ch !== '{') {
      out += ch
      i += 1
      continue
    }
    // {{name}}
    const dbl = /^\{\{(\w+)\}\}/.exec(template.slice(i))
    if (dbl) {
      const value = params[dbl[1]!]
      out += value === undefined ? onMissing(dbl[1]!, true) : String(value)
      i += dbl[0].length
      continue
    }
    const end = findClosingBrace(template, i)
    if (end < 0) {
      out += template.slice(i)
      break
    }
    const inner = template.slice(i + 1, end)
    const simple = /^(\w+)$/.exec(inner)
    if (simple) {
      const value = params[simple[1]!]
      out += value === undefined ? onMissing(simple[1]!, false) : String(value)
    } else {
      const rendered = renderSelectOrPlural(inner, params, onMissing, locale)
      out += rendered ?? template.slice(i, end + 1)
    }
    i = end + 1
  }
  return out
}

function findClosingBrace(text: string, openIndex: number): number {
  let depth = 0
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function parseBranches(body: string): Map<string, string> | null {
  const branches = new Map<string, string>()
  let i = 0
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i]!)) i += 1
    if (i >= body.length) break
    const keyMatch = /^(=?[\w-]+)\s*\{/.exec(body.slice(i))
    if (!keyMatch) return null
    const open = i + keyMatch[0].length - 1
    const close = findClosingBrace(body, open)
    if (close < 0) return null
    branches.set(keyMatch[1]!, body.slice(open + 1, close))
    i = close + 1
  }
  return branches.has('other') ? branches : null
}

function renderSelectOrPlural(
  inner: string,
  params: TranslateParams,
  onMissing: (key: string, doubleBraced: boolean) => string,
  locale: string,
): string | null {
  const head = /^\s*(\w+)\s*,\s*(select|plural)\s*,/.exec(inner)
  if (!head) return null
  const [, name, kind] = head
  const branches = parseBranches(inner.slice(head[0].length))
  if (!branches) return null
  const raw = params[name!]

  if (kind === 'select') {
    if (raw === undefined || raw === null || String(raw) === '') return ''
    const branch = branches.get(String(raw)) ?? branches.get('other')!
    return formatIcuMessage(branch, params, onMissing, locale)
  }

  const n = typeof raw === 'number' ? raw : Number(raw)
  if (raw === undefined || raw === null || Number.isNaN(n)) return ''
  let branch = branches.get(`=${n}`)
  if (branch === undefined) {
    let category = 'other'
    try {
      category = new Intl.PluralRules(locale).select(n)
    } catch {
      category = n === 1 ? 'one' : 'other'
    }
    branch = branches.get(category) ?? branches.get('other')!
  }
  // `#` is the number, except inside a nested argument.
  return formatIcuMessage(branch.replace(/#(?![^{]*\})/g, String(n)), params, onMissing, locale)
}
