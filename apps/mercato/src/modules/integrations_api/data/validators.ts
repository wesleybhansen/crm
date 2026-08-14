import { z } from "zod";

const requiredIdentifier = z.string().trim().min(1);

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
