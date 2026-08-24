import crypto from 'node:crypto'
import { NextResponse } from 'next/server'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import {
  AMS_CRM_CONTRACT_DESCRIPTOR_V1,
  amsCrmContractDescriptorHashV1,
  parseEd25519PublicKeysV1,
} from '../../../../lib/ams-crm-contract-v1'

export const metadata = {
  path: '/internal/ams-contract/v1',
  GET: { requireAuth: false },
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Internal Integrations',
  summary: 'Read the dark AMS CRM authority contract descriptor',
  methods: {
    GET: {
      summary: 'Return version pins, signer key versions, and rollout interlocks without mutation',
      tags: ['Internal Integrations'],
    },
  },
}

function authorized(request: Request): boolean {
  const secret = process.env.NOLI_INTERNAL_SERVICE_SECRET
  const got = Buffer.from((request.headers.get('authorization') || '').trim())
  const expected = Buffer.from(secret ? `Bearer ${secret}` : '')
  return Boolean(secret) && got.length === expected.length && crypto.timingSafeEqual(got, expected)
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }

  const commandKeys = parseEd25519PublicKeysV1(process.env.NOLI_AMS_CRM_COMMAND_PUBLIC_KEYS_V1)
  return NextResponse.json(
    {
      ok: true,
      descriptor: AMS_CRM_CONTRACT_DESCRIPTOR_V1,
      descriptorSha256: amsCrmContractDescriptorHashV1(),
      acceptedCommandKeyVersions: Object.keys(commandKeys).sort(),
      rollout: {
        commandShadowIntake: process.env.NOLI_AMS_CRM_COMMAND_SHADOW_V1_ENABLED === 'true',
        eligibilityLeases: process.env.NOLI_CRM_AMS_ELIGIBILITY_V1_ENABLED === 'true',
        authorityProjection: process.env.NOLI_CRM_AMS_AUTHORITY_PROJECTION_V1_ENABLED === 'true',
        // No publisher is registered in this tranche. An obsolete environment
        // value must not be able to imply that delivery exists.
        eventPublication: false,
        providerDispatch: false,
      },
    },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  )
}
