/** Deterministic lookup-hash columns maintained alongside encryption, keyed by
 *  entity id. The hash is of the normalized plaintext; a cleared source field
 *  clears its hash. `source`/`target` are ORM property names (camelCase);
 *  `sourceColumn`/`targetColumn` are the database columns, for raw writers.
 *
 *  Shared by the ORM subscriber and encryptRowForRawWrite so both paths hash
 *  the same way. Relative imports only (reachable from workers). */
export type LookupHashRule = {
  source: string
  target: string
  sourceColumn: string
  targetColumn: string
  normalize: (v: string) => string
  /** A partial unique index (org, target) where deleted_at is null exists for this hash. */
  uniquePerOrg?: boolean
}

export const LOOKUP_HASH_RULES: Record<string, LookupHashRule[]> = {
  'customers:customer_entity': [
    {
      source: 'primaryEmail',
      target: 'primaryEmailHash',
      sourceColumn: 'primary_email',
      targetColumn: 'primary_email_hash',
      normalize: (v) => v.toLowerCase().trim(),
      uniquePerOrg: true,
    },
    {
      source: 'primaryPhone',
      target: 'primaryPhoneHash',
      sourceColumn: 'primary_phone',
      targetColumn: 'primary_phone_hash',
      normalize: (v) => v.replace(/\D/g, ''),
    },
  ],
  // Raw-knex table (no ORM entity): only raw writers use this rule.
  'customers:event_attendee': [
    {
      source: 'attendeeEmail',
      target: 'attendeeEmailHash',
      sourceColumn: 'attendee_email',
      targetColumn: 'attendee_email_hash',
      normalize: (v) => v.toLowerCase().trim(),
    },
  ],
}
