# Pre-Implementation Analysis: Scout usage observations

## Executive Summary

Ready for a local, app-owned metadata observer. Not a billing fix, quality qualification or deployable savings claim.

## Backward Compatibility

No violation across the 13 contract categories: no removal, rename or narrowing of discovery, public types/functions/imports, events, widget spots, routes, schema, DI, ACL, notifications, CLI or generated contracts. The spec includes migration/backward compatibility. Existing internal provider result is extended; legacy HTTP and meter fields must compare exactly.

## Spec Completeness

Required sections and route/UI coverage are present. No new entity/command/cache/UI design is needed. Browser execution and deployed-source attestation are explicit unproven gates, not silently passed.

## AGENTS.md Compliance

App-owned placement and additive metadata preserve core upgrade boundaries. Add route OpenAPI documentation without changing runtime behavior. New numeric parsing uses Zod/unknown, not any. Existing ORM/auth and raw provider fetch code stay unchanged.

## Risk Assessment

High: billing drift, false savings from unobserved failures, raw data leaking into metrics. Mitigate with fixed numeric whitelist, incomplete-workflow labels, exact legacy billing comparisons and no new writes. Medium: parser exceptions, latency, best-effort loss. Mitigate with bounded pure parsing, malformed tests, differential route replay and explicit production limits. Low: additive row storage growth; constant-size observation only.

## Gap Analysis

Critical design gaps: none. Important verification gaps: full CI, native route replay, independent review and production attestation. No meaningful net savings can be inferred from this candidate alone.

## Remediation Plan

Before implementation: pin source and preserve the app-extension boundary (done). During implementation: unit, differential route and native billing tests; keep all external services mocked. After implementation: adversarial review and full gates; remain local until publication/deployment separately approved.

## Recommendation

Implement and test locally. Do not forward cachedTokensIn to billing or add thought tokens to legacy tokensOut.
