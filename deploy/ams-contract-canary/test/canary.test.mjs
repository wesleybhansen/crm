import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  AMS_CRM_CONTRACT_DESCRIPTOR_V1,
  buildContractResponseV1,
  descriptorSha256V1,
} from '../api/internal/ams-contract/v1.mjs'

const canaryRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const pin = JSON.parse(await readFile(new URL('../contract-source-pin.v1.json', import.meta.url), 'utf8'))

test('pins the exact merged CRM contract source and descriptor', async () => {
  assert.equal(descriptorSha256V1(), pin.descriptorSha256)
  assert.equal(AMS_CRM_CONTRACT_DESCRIPTOR_V1.providerDispatchImplemented, false)
  for (const source of pin.sourceFiles) {
    const bytes = await readFile(`${repositoryRoot}/${source.path}`)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256)
  }
})

test('requires a bounded bearer secret and always reports a dark rollout', () => {
  const secret = 'c'.repeat(48)
  assert.equal(buildContractResponseV1({}, { NOLI_INTERNAL_SERVICE_SECRET: secret }).status, 401)
  const result = buildContractResponseV1(
    { authorization: `Bearer ${secret}` },
    {
      NOLI_INTERNAL_SERVICE_SECRET: secret,
      NOLI_AMS_CRM_COMMAND_PUBLIC_KEYS_V1: JSON.stringify({
        'crm-canary-v2': 'B'.repeat(44),
        'crm-canary-v1': 'A'.repeat(44),
      }),
      NOLI_AMS_CRM_COMMAND_SHADOW_V1_ENABLED: 'true',
      NOLI_CRM_AMS_ELIGIBILITY_V1_ENABLED: 'true',
      NOLI_CRM_AMS_EVENTS_V1_ENABLED: 'true',
    },
  )
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.acceptedCommandKeyVersions, ['crm-canary-v1', 'crm-canary-v2'])
  assert.deepEqual(result.body.rollout, {
    commandShadowIntake: false,
    eligibilityLeases: false,
    authorityProjection: false,
    eventPublication: false,
    providerDispatch: false,
  })
})

test('the deployment artifact has no database, provider, CRM mutation, or network client', async () => {
  const source = await readFile(`${canaryRoot}/api/internal/ams-contract/v1.mjs`, 'utf8')
  assert.doesNotMatch(source, /\bfetch\s*\(|postgres|mikro-orm|prisma|resend|nodemailer|sendEmail|createContact/i)
  assert.equal(pin.canaryConstraints.databaseAccess, false)
  assert.equal(pin.canaryConstraints.providerDispatch, false)
  assert.equal(pin.canaryConstraints.crmMutation, false)
})
