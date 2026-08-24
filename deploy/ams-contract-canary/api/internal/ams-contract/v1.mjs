import { createHash, timingSafeEqual } from 'node:crypto'

export const AMS_CRM_CONTRACT_DESCRIPTOR_V1 = Object.freeze({
  contractVersion: 'noli.ams-crm.contract-descriptor.v1',
  commandContractVersion: 'noli.ams-crm.command.v1',
  eventContractVersion: 'noli.crm-ams.event.v1',
  eligibilityLeaseVersion: 'noli.crm-ams.eligibility-lease.v1',
  signingAlgorithm: 'Ed25519',
  canonicalization: 'recursive-key-sort-json-utf8-v1',
  commandMaxLifetimeSeconds: 600,
  eventMaxLifetimeSeconds: 600,
  eligibilityLeaseMaxLifetimeSeconds: 60,
  piiPolicy: 'opaque-references-and-digests-only',
  providerDispatchImplemented: false,
})

function canonicalValue(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (typeof value !== 'object') throw new TypeError('Unsupported canonical JSON value')
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]))
}

export function descriptorSha256V1() {
  return createHash('sha256')
    .update(JSON.stringify(canonicalValue(AMS_CRM_CONTRACT_DESCRIPTOR_V1)), 'utf8')
    .digest('hex')
}

function exactBearerAuthorized(headers, environment) {
  const secret = typeof environment.NOLI_INTERNAL_SERVICE_SECRET === 'string'
    ? environment.NOLI_INTERNAL_SERVICE_SECRET
    : ''
  const authorization = typeof headers.authorization === 'string'
    ? headers.authorization.trim()
    : ''
  if (secret.length < 32 || secret.length > 4096) return false
  const expected = Buffer.from(`Bearer ${secret}`, 'utf8')
  const actual = Buffer.from(authorization, 'utf8')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function acceptedCommandKeyVersions(environment) {
  const raw = environment.NOLI_AMS_CRM_COMMAND_PUBLIC_KEYS_V1
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 65536) return []
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return []
    return Object.entries(parsed)
      .filter(([version, key]) => (
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version)
        && typeof key === 'string'
        && key.length >= 32
        && key.length <= 4096
      ))
      .map(([version]) => version)
      .sort()
  } catch {
    return []
  }
}

export function buildContractResponseV1(headers, environment) {
  if (!exactBearerAuthorized(headers, environment)) {
    return { status: 401, body: { ok: false, error: 'Unauthorized' } }
  }
  return {
    status: 200,
    body: {
      ok: true,
      descriptor: AMS_CRM_CONTRACT_DESCRIPTOR_V1,
      descriptorSha256: descriptorSha256V1(),
      acceptedCommandKeyVersions: acceptedCommandKeyVersions(environment),
      rollout: {
        commandShadowIntake: false,
        eligibilityLeases: false,
        authorityProjection: false,
        eventPublication: false,
        providerDispatch: false,
      },
    },
  }
}

export default function handler(request, response) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET')
    response.setHeader('Cache-Control', 'no-store, max-age=0')
    return response.status(405).json({ ok: false, error: 'Method Not Allowed' })
  }
  const result = buildContractResponseV1(request.headers ?? {}, process.env)
  response.setHeader('Cache-Control', 'no-store, max-age=0')
  return response.status(result.status).json(result.body)
}
