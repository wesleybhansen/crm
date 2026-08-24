import { z } from "zod";

const requiredIdentifier = z.string().trim().min(1);
const uuid = z.string().uuid();
const canonicalInstant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const opaqueRef = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const keyVersion = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const eventNonce = z.string().min(22).max(128).regex(/^[A-Za-z0-9_-]+$/);
const positiveVersion = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(
  (value) => BigInt(value) <= BigInt("9223372036854775807"),
);

export const internalCalendarEventsRequestSchema = z
  .object({
    noliUserId: requiredIdentifier,
    op: z.enum(["list", "upsert"]),
    syncToken: z.unknown().optional(),
    updatedMinMs: z.unknown().optional(),
    pageToken: z.unknown().optional(),
    externalId: z.unknown().optional(),
    event: z.unknown().optional(),
  })
  .passthrough();

export const internalSetupStatusRequestSchema = z
  .object({
    noliUserId: requiredIdentifier,
  })
  .passthrough();

export const internalContactContextRequestSchema = z
  .object({
    noliUserId: requiredIdentifier,
    contactId: requiredIdentifier,
  })
  .passthrough();

const crmAmsConsentProjectionV1Schema = z
  .object({
    version: positiveVersion,
    state: z.enum(["granted", "denied", "withdrawn"]),
    policyRef: opaqueRef,
    sourceRef: opaqueRef,
    effectiveAt: canonicalInstant,
    expiresAt: canonicalInstant.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.expiresAt !== null && Date.parse(value.expiresAt) <= Date.parse(value.effectiveAt)) {
      context.addIssue({ code: "custom", message: "Consent expiry must follow its effective instant" });
    }
  });

const crmAmsSuppressionProjectionV1Schema = z
  .object({
    version: positiveVersion,
    active: z.boolean(),
    reasonCode: opaqueRef,
    effectiveAt: canonicalInstant,
  })
  .strict();

/**
 * Internal owner-domain input for atomically projecting CRM authority and a
 * corresponding held-dark event. Every free-form value is an opaque safe
 * reference; plaintext contact data, rendered content, URLs, and provider
 * responses cannot pass this strict schema.
 */
export const crmAmsAuthorityProjectionInputV1Schema = z
  .object({
    organizationId: uuid,
    tenantId: uuid,
    sourceOrganizationId: uuid,
    crmContactRef: opaqueRef,
    purpose: z.enum(["marketing", "transactional_asset"]),
    event: z
      .object({
        eventId: uuid,
        eventType: z.enum(["consent.changed", "suppression.changed"]),
        occurredAt: canonicalInstant,
        expiresAt: canonicalInstant,
        nonce: eventNonce,
        commandRef: opaqueRef.nullable(),
        receiptRef: opaqueRef,
      })
      .strict(),
    consent: crmAmsConsentProjectionV1Schema,
    suppression: crmAmsSuppressionProjectionV1Schema,
  })
  .strict();

export const crmAmsAuthoritySignerV1Schema = z
  .object({
    keyVersion,
    privateKeyPem: z.string().min(1).max(4096),
  })
  .strict();

export type CrmAmsAuthorityProjectionInputV1 = z.infer<typeof crmAmsAuthorityProjectionInputV1Schema>;
export type CrmAmsAuthoritySignerV1 = z.infer<typeof crmAmsAuthoritySignerV1Schema>;
