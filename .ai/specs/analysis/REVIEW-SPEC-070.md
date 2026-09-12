# Code Review: Scout usage observations

## Summary

Local metadata-only observer implemented; no generation requests, response selection, legacy billing fields or billing code changed. Not release-approved: translation and template synchronization gates fail. Independent adversarial review found no candidate-specific generation/fallback/billing regression; differential replay passed 47 comparisons and 16 deliberate regression controls.

## CI/CD Verification

Run with Node 24.19.0, Yarn 4.12.0, clean environment and no provider credentials. Receipt: `/Users/wesleyhansen/dev/Noli AI/outputs/harness-efficiency-2026-09-11/crm-scout-usage-verification/gates-2026-09-11T23-59-42.189Z/receipt.json`.

| Gate | Result | Notes |
| --- | --- | --- |
| Package build | PASS | All package build tasks |
| Generate | PASS | Generated locally, not hand-edited |
| Package rebuild | PASS | Includes generated files |
| Translation sync | FAIL | Same six reported issues on clean baseline |
| Translation usage | WARN | Seven missing / 3,650 unused keys; nonblocking CI gate |
| Typecheck | PASS | All 16 configured tasks |
| Root tests | PASS | 5,613 passed, eight skipped; no skipped test counted as passing |
| App build | PASS | Not a substitute for the separate type check |
| Template sync | FAIL | 976 differences; clean baseline has 973 |
| Dependency versions | PASS | No dependency changes |
| Deployment security | PASS | No deployment performed |
| CRM regression | PASS | 54 tests |
| Reply-quality dry run | PASS | 28 fixtures; no scored provider calls |

## Findings

### Critical

Release gate failure: app translations have missing `app.page.signIn` and 16 extra keys in each of pl/es/de. This is also present on clean baseline but still blocks review approval. No automatic translation deletion or fallback-English repair performed.

### High

Template parity: 976 file differences (948 missing, 25 mismatched, three extra), including pre-existing 973 differences and three newly added observer/test files. Bulk mirroring spans auth, layout and many domain routes. Requires separately scoped review/approval per the code-review skill; not silently applied to this measurement candidate.

### Medium

Observation scope is incomplete by design: successful final provider responses only, best-effort persistence, no complete failed-attempt or UI tool-turn ledger. Do not use for total cost per acceptable result or savings claims. No production latency/source/browser qualification yet.

### Low

Native parser+serialization microbenchmark on this machine: median batch means about 0.00083 ms for valid usage and 0.01374 ms for malformed usage, nine batches of 5,000 after warmup. Sample metadata sizes 337–366 bytes. This is not database-write or live response-latency evidence.

## Backward Compatibility

All 13 existing contract categories retained. Optional namespaced internal metadata added; `cachedTokensIn` is not forwarded and reasoning is not added to legacy `tokensOut`. Native storage tests compare every old row field, attribution and query/write count across 28 combinations. Existing strict rejection and best-effort failure isolation remain tested.

## Recommendation

Keep local and unactivated. Differential/independent review is complete within its offline scope; resolve the repository release blockers through a separately authorized scope. Do not relax gates, claim savings or spend on fresh generations for this observation-only change. No template synchronization has been performed; the skill's approval requirement remains open.
