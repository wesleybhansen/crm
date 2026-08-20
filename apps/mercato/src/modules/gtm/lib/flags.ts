// GTM Engineer feature gate (SPEC-066: optional-parallel, feature-flagged,
// OFF for the current launch candidate). Dispatcher-facing GTM routes must
// fail closed (404) when the flag is off.
export function gtmEnabled(): boolean {
  return process.env.GTM_ENGINEER_ENABLED === 'true'
}
