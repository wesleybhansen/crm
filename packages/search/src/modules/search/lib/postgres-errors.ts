type ErrorWithCodeAndCause = {
  code?: unknown
  cause?: unknown
}

export function isMissingDatabaseRelation(error: unknown): boolean {
  let current = error
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== 'object') return false
    const candidate = current as ErrorWithCodeAndCause
    if (candidate.code === '42P01') return true
    current = candidate.cause
  }
  return false
}
