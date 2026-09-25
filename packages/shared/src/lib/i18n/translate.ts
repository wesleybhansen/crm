import type { Dict, TranslateFn, TranslateParams } from './context'
import { formatIcuMessage } from './icu'

export type TranslateWithFallbackFn = (key: string, fallback?: string, params?: TranslateParams) => string

function format(template: string, params?: TranslateParams) {
  // ICU select/plural aware; unknown names stay as written.
  return formatIcuMessage(template, params)
}

export function createTranslator(dict: Dict): TranslateFn {
  const translator = ((key: string, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => {
    let fallback: string | undefined
    let resolvedParams: TranslateParams | undefined

    if (typeof fallbackOrParams === 'string') {
      fallback = fallbackOrParams
      resolvedParams = params
    } else {
      resolvedParams = fallbackOrParams
    }

    const template = dict[key] ?? fallback ?? key
    return format(template, resolvedParams)
  }) as TranslateFn

  return translator
}

export function translateWithFallback(
  t: TranslateFn,
  key: string,
  fallback?: string,
  params?: TranslateParams,
): string {
  const value = params ? t(key, params) : t(key)
  if (value !== key) return value
  if (fallback === undefined) return key
  return format(fallback, params)
}

export function createTranslatorWithFallback(translate: TranslateFn): TranslateWithFallbackFn {
  return (key, fallback, params) => translateWithFallback(translate, key, fallback, params)
}

export function createFallbackTranslator(dict: Dict): TranslateWithFallbackFn {
  const t = createTranslator(dict)
  return (key, fallback, params) => translateWithFallback(t, key, fallback, params)
}
