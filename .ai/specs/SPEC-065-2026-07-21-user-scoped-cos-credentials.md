# SPEC-065: User-scoped COS CRM credentials

**Status:** Implemented — awaiting coordinated rollout
**Owner:** Wesley Hansen
**Created:** 2026-07-21
**Driver:** COS currently rotates one CRM key per organization and source, so provisioning one teammate can revoke another teammate's hand. The provision endpoint also treats transient identity/provisioning failures as entitlement denial, causing Hub to remove otherwise healthy hands.

## Goals

- Scope every platform-auto credential to the original noli-core user, local CRM organization, and source.
- Return the same recoverable credential for repeated provisioning of the same user/source/version so a stale Hub writer is harmless during ordinary rewires.
- Serialize first mint and explicit version changes and retain the immediately superseded key for a bounded overlap window.
- Re-check the exact user's current `crm` entitlement and exact noli-core organization membership every time the key is authenticated.
- Emit a durable removal signal only after a successful noli-core lookup positively reports an inactive entitlement.
- Transition legacy `platform-auto:<source>` keys without a database migration.

## Design

- New names use `platform-auto:v2:<base64url noli user id>:<source sha256 prefix>:<integer version>`.
- The raw key is deterministically derived with HMAC-SHA256 from a dedicated server-only secret and the local tenant/org/user/source/version tuple. Only bcrypt hashes remain in CRM. Stable derivation lets idempotent provision calls return the same secret without storing plaintext.
- `NOLI_COS_CRM_KEY_VERSION` selects the requested version (default `1`). A PostgreSQL transaction advisory lock serializes a user/source mint. Same-version requests return the existing key; a higher version retains exactly the immediately superseded same-user key at a bounded deadline, immediately expires older generations, and creates the new row atomically.
- Legacy rows are attributed through `created_by -> users.clerk_user_id -> noli-core users.id`. A first v2 mint—or a later stable v2 retry that encounters a delayed legacy row—gives only that user's legacy row the overlap deadline; teammates' rows are untouched. Use-time legacy acceptance defaults to 2026-08-04 and cannot be configured past the hard 2026-08-21 cutoff. A malformed explicit cutoff fails closed instead of restoring the later default.
- Platform-auto authentication fails closed unless the local creator is active and still belongs to the key's local org, that org is active and linked to noli-core, the creator still maps to the encoded noli user, the exact user has an active `crm` entitlement, and an exact `organization_members` row links that user to the linked noli org.
- `ApiKey.organizationId` is a hard authorization cap: role ACLs can narrow it but cannot widen it, all-org/superadmin roles cannot bypass it, and API keys ignore interactive tenant/org selection cookies. Managed platform keys also suppress the `superadmin` role name on legacy role-only global routes while retaining their RBAC-derived features inside the key scope.
- Re-provisioning refreshes current roles on every retained same-user credential and best-effort invalidates the tenant RBAC cache after commit. A cache outage must not withhold an already committed replacement; in that case stale role ACLs remain bounded by the existing five-minute RBAC TTL while entitlement and org checks still fail closed on every use.
- Managed platform-auto rows are hidden from the ordinary API-key list, their reserved name prefix cannot be created there, and the ordinary delete route cannot revoke them. Explicit operator revocation requires a reviewed version bump/re-wire plan.

## Provision response semantics

- `403` with `code=entitlement_lapsed` and `remove=true`: the user exists and a successful entitlement query positively returned inactive. Hub may remove the hand.
- `5xx` with no remove signal: missing/indeterminate noli identity, missing org membership/link, noli-core failure, or local provisioning/link failure. Hub must keep the installed hand.
- `4xx`: malformed or unauthorized request; not an entitlement removal signal.

## Rollout and cleanup

1. Set a high-entropy `NOLI_COS_CREDENTIAL_DERIVATION_SECRET` on every CRM instance before deploying code. It must remain stable; changing it without incrementing the credential version makes derived secrets diverge from stored hashes.
2. Deploy use-time v2/legacy validation and idempotent provisioning together.
3. Re-provision every active CRM hand. Its same-user legacy key remains valid only for the configured overlap.
4. After the overlap and fleet verification, delete expired legacy/platform-auto predecessor rows in a separately reviewed maintenance operation.
5. Do not increment `NOLI_COS_CRM_KEY_VERSION` until Hermes validates a monotonic hand generation. Bounded overlap protects mint/patch crashes, but alone cannot prevent a response from an older rotation being written last after a newer rotation.

No production database change or migration is required.

## Verification

- Focused unit tests cover deterministic derivation, same-user idempotency, teammate isolation, transaction-bound advisory-lock invocation, legacy overlap, and strict use-time revocation. A disposable-Postgres concurrent-mint test remains recommended before the first version bump.
- Route tests cover durable `403 remove=true` versus indeterminate `5xx keep` behavior.
- Changed TypeScript files are diagnostics-free and focused/API-key tests are green. The repository-wide app typecheck still has unrelated generated-file and pre-existing diagnostics.
