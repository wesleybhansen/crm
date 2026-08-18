import { GtmCampaignError, type CampaignEm, type GtmCtx } from './campaign/build'
import { GtmAuditEvent, GtmWorkspace } from '../data/entities'

/*
 * Workspace-level GTM settings stored in gtm_workspaces.settings (jsonb).
 *
 * settings.postal_address is the CUSTOMER organization's business postal
 * address. CAN-SPAM requires the sender's valid physical postal address in
 * every commercial email, and for GTM outreach the sender is the customer's
 * org (their mailbox, their campaign), never Noli. The address is:
 *   - a single free-form string, trimmed, capped at 300 characters
 *   - empty / whitespace-only = unset (the key is removed, not stored as '')
 *   - required before a campaign can be APPROVED (lib/campaign/approve.ts)
 *   - rechecked at send time (lib/execute/send.ts) so clearing it after
 *     approval fails sends closed instead of shipping non-compliant mail
 *   - rendered into the compliance footer of every message body
 *     (lib/campaign/render.ts), so it is covered by the frozen content hash
 */

export const POSTAL_ADDRESS_MAX_LENGTH = 300

// Read the workspace's postal address; unset / blank / non-string -> null.
export function readWorkspacePostalAddress(
  workspace: Pick<GtmWorkspace, 'settings'> | null | undefined,
): string | null {
  const settings = (workspace?.settings ?? {}) as Record<string, unknown>
  const raw = settings.postal_address
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed ? trimmed : null
}

// Normalize a caller-supplied postal address: trim, empty -> null (unset),
// over-cap -> typed error (never silently truncated).
export function normalizePostalAddress(input: unknown): string | null {
  if (input == null) return null
  if (typeof input !== 'string') {
    throw new GtmCampaignError('invalid_settings', 'postal_address must be a string')
  }
  const trimmed = input.trim()
  if (!trimmed) return null
  if (trimmed.length > POSTAL_ADDRESS_MAX_LENGTH) {
    throw new GtmCampaignError(
      'invalid_settings',
      `postal_address must be at most ${POSTAL_ADDRESS_MAX_LENGTH} characters`,
    )
  }
  return trimmed
}

export type UpdateWorkspacePostalAddressResult = {
  workspace: GtmWorkspace
  postalAddress: string | null
}

// Write settings.postal_address (or remove it when the input is empty),
// self-scoped by org/tenant, with an audit event in the same transaction.
export async function updateWorkspacePostalAddress(
  em: CampaignEm,
  ctx: GtmCtx,
  workspaceId: string,
  input: unknown,
): Promise<UpdateWorkspacePostalAddressResult> {
  const postalAddress = normalizePostalAddress(input)
  const workspace = await em.findOne(GtmWorkspace, {
    id: workspaceId,
    organizationId: ctx.organizationId,
    tenantId: ctx.tenantId,
    deletedAt: null,
  })
  if (!workspace) {
    throw new GtmCampaignError('workspace_not_found', 'Workspace not found')
  }

  await em.transactional(async (tem) => {
    const settings = { ...((workspace.settings ?? {}) as Record<string, unknown>) }
    if (postalAddress) settings.postal_address = postalAddress
    else delete settings.postal_address
    workspace.settings = settings
    tem.persist(workspace)
    const audit = tem.create(GtmAuditEvent, {
      organizationId: ctx.organizationId,
      tenantId: ctx.tenantId,
      actor: 'user_id',
      actorUserId: ctx.userId,
      action: 'gtm.workspace.settings_updated',
      objectType: 'gtm_workspace',
      objectId: workspace.id,
      requestId: ctx.requestId ?? null,
      // Redacted: presence and length only, never the address text itself.
      metadata: {
        setting: 'postal_address',
        postal_address_set: postalAddress != null,
        postal_address_length: postalAddress?.length ?? 0,
      },
    })
    tem.persist(audit)
    await tem.flush()
  })

  return { workspace, postalAddress }
}
