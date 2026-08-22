# SPEC-068 — AMS ↔ CRM Authority Contracts

## TLDR

CRM becomes the sole authority for contact identity, purpose-specific consent,
preferences, suppression, send eligibility, provider dispatch, and delivery
events. AMS may submit only a short-lived Ed25519-signed, idempotent command
whose payload contains opaque CRM-owned references and content/consent version
references. This tranche ships dark: command intake and eligibility leases are
disabled by exact-false-default environment interlocks and no email provider is
called.

## Overview

The contract version is `noli.ams-crm.command.v1`. AMS is issuer `noli-ams` and
CRM is audience `noli-crm`. CRM-issued events use
`noli.crm-ams.event.v1`; short-lived dispatch eligibility uses
`noli.crm-ams.eligibility-lease.v1`. Canonical JSON bytes, Ed25519 key versions,
explicit timestamps, nonces, replay windows, tenant mapping, and strict schemas
are frozen in the CRM repository.

## Problem Statement

Legacy AMS and CRM routes can each imply authority to persist contacts or send
email. They use shared-secret authentication, have no domain command replay
contract, and can treat an old consent snapshot as current eligibility. That can
produce duplicate or suppressed sends and can spread PII into generic receipts.

## Proposed Solution

- Persist CRM-owned consent versions and suppression versions scoped by both
  `organization_id` and `tenant_id`.
- Persist only command/event identifiers and cryptographic digests in the
  integration inbox/outbox. No email, name, rendered body, raw URL, secret, or
  provider response is stored there.
- Verify strict canonical Ed25519 envelopes with bounded key overlap and a
  maximum ten-minute command replay window.
- Re-evaluate current effective consent and suppression immediately before any
  future dispatch. A lease is informational unless unexpired and exact-version
  matched; dependency failure, stale consent, or active suppression denies.
- Keep command intake, eligibility serving, event publication, and provider
  dispatch independently default-off. This implementation adds no provider
  dispatch path.

## Architecture

1. AMS signs a strict command envelope that refers to a CRM-owned command or
   contact reference and exact content/consent artifacts.
2. CRM authenticates the transport, verifies signature, issuer/audience,
   timestamps, tenant mapping, canonical payload hash, command ID, nonce, and
   idempotency digest.
3. Exact replay returns the original inbox result. Same ID or idempotency digest
   with different canonical bytes is a conflict.
4. Before any later provider call, CRM reads the latest consent and suppression
   versions in the same organization and tenant and denies unknown/unavailable.
5. CRM emits only signed, privacy-minimal event projections. Event payloads use
   opaque references and safe outcome classes.

## Data Models

- `integrations_api_ams_commands`: immutable command identity, tenant mapping,
  principal reference, canonical/payload/idempotency/nonce digests,
  contract/issuer/audience/key/schema,
  expiry, state, safe failure, and timestamps. No plaintext command payload.
- `integrations_api_consent_versions`: CRM contact reference, purpose, monotonic
  version, granted/denied/withdrawn state, policy/source refs and effective/
  expiry times.
- `integrations_api_suppression_versions`: CRM contact reference, channel,
  monotonic version, active state, safe reason code, and effective time.
- `integrations_api_ams_events`: immutable signed-event outbox metadata and
  contract/issuer/audience/key/schema plus payload digest, with no PII-bearing
  body.

Every table has UUID primary key, explicit organization and tenant columns,
timestamps, soft-delete column, and composite tenant indexes. Migrations are
generated from MikroORM entities.

## API Contracts

- `GET /api/internal/ams-contract/v1`: authenticated, read-only contract and
  public-key discovery. It is safe while all mutation flags are off.
- `POST /api/internal/ams-commands/v1`: exact flag and shadow-mode gated. Initial
  state is `shadow_validated`; it cannot dispatch or call a provider.
- `POST /api/internal/ams-eligibility/v1`: exact flag gated, read-only, requires
  CRM contact/purpose and expected versions, and returns a signed lease or a
  fail-closed denial. It never sends.

All routes publish OpenAPI metadata. Machine errors are finite and contain no
payload, PII, provider body, raw URL, or secret.

## Migration & Backward Compatibility

All tables and routes are additive. Existing CRM email, API-key, webhook, and
integration routes are not changed or reinterpreted. Legacy behavior remains
reachable only through its existing entry points; it is not evidence that the
new governed contract is enabled. Rollback turns the new flags off and leaves
immutable digest metadata and ongoing consent/suppression obligations intact.

## Risks & Impact Review

| Failure | Severity | Mitigation | Residual risk |
|---|---|---|---|
| Forged/wrong-tenant command | Critical | Ed25519, exact issuer/audience, tenant mapping, canonical bytes | Key custody remains operationally critical. |
| Duplicate command | High | Command/idempotency uniqueness and canonical conflict checks | Cross-region acknowledgement loss requires reconciliation. |
| Send after unsubscribe | Critical | JIT latest-version consent/suppression check; unknown denies | Provider dispatch is intentionally absent in this tranche. |
| PII in generic metadata | High | Opaque refs/digests only; sentinel tests | Owner-domain payload storage needs a later encrypted implementation. |
| Key rotation outage | High | Key-versioned overlap and explicit unknown-key denial | Operators must publish overlap before rotating signers. |

## Integration Coverage

- Contract canonicalization and cross-key rotation vectors.
- Forged signature, wrong issuer/audience/org, stale/expired time, replay, and
  same-ID/different-payload conflicts.
- Consent granted then withdrawn, suppression after enqueue, stale version,
  dependency outage, and lease expiry; every denial proves zero provider call.
- Database/source sentinels prove plaintext email/body/URL/provider response is
  absent from integration metadata.
- Flags-off route tests prove zero body parsing, database mutation, or provider
  access.

## Final Compliance Report

- Additive schema only: required.
- Generated migration: required.
- Organization plus tenant scope on every query: required.
- Command mutation guard and idempotent command handler: required.
- No direct provider send: required.
- Dark-by-default rollout: required.
- D5 contract fields and outage behavior: covered.

## Changelog

- 2026-08-22: Initial contract, data model, dark rollout, and verification plan.
