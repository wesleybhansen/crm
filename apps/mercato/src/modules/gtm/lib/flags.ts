// GTM Engineer feature gate (SPEC-066: optional-parallel, feature-flagged,
// OFF for the current launch candidate). Dispatcher-facing GTM routes must
// fail closed (404) when the flag is off.
export function gtmEnabled(): boolean {
  return process.env.GTM_ENGINEER_ENABLED === 'true'
}

// Consumer research has a separate dark-release gate. Enabling the GTM
// workspace must never implicitly authorize customer-serving consumer-source
// calls. This gate controls research only; consumer outreach stays manual-only
// in policy regardless of its value.
export function gtmConsumerResearchEnabled(): boolean {
  return process.env.GTM_CONSUMER_RESEARCH_ENABLED === 'true'
}
