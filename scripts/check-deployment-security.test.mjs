import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { findDeploymentSecurityViolations } from './check-deployment-security.mjs'

function createFixture({
  productionPort = '127.0.0.1:3000:3000',
  extraProductionPort,
  includeOpenCode = false,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'deployment-security-'))
  mkdirSync(join(root, 'docker/opencode'), { recursive: true })
  mkdirSync(join(root, '.github/workflows'), { recursive: true })
  mkdirSync(join(root, 'ops/host-security'), { recursive: true })
  writeFileSync(
    join(root, 'docker-compose.prod.yml'),
    `services:\n  app:\n    ports:\n      - "${productionPort}"${extraProductionPort ? `\n      - ${extraProductionPort}` : ''}\n  nginx:\n    ports:\n      - "80:80"\n      - "443:443"\n`,
  )
  writeFileSync(
    join(root, 'docker-compose.yml'),
    includeOpenCode
      ? 'services:\n  opencode:\n    image: opencode-mvp\n    ports:\n      - "4096:4096"\n'
      : 'services:\n  postgres:\n    image: postgres:17\n',
  )
  writeFileSync(
    join(root, 'docker/opencode/entrypoint.sh'),
    '#!/bin/sh\nif [ -z "${OPENCODE_SERVER_PASSWORD:-}" ]; then exit 78; fi\nexec opencode serve --hostname 127.0.0.1\n',
  )
  writeFileSync(join(root, '.github/workflows/ci.yml'), 'name: CI\n')
  writeFileSync(
    join(root, 'ops/host-security/noli-docker-ingress-policy'),
    '--ctorigdstport 80\n--ctorigdstport 443\n-i "$PUBLIC_INTERFACE" -j DROP\n',
  )
  writeFileSync(
    join(root, 'ops/host-security/noli-ingress-policy.conf'),
    'ExecStartPost=/usr/local/sbin/noli-docker-ingress-policy\n',
  )
  return root
}

test('accepts the production loopback and public proxy allowlist', () => {
  const root = createFixture()
  try {
    assert.deepEqual(findDeploymentSecurityViolations(root).violations, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects a public application port and any Compose coding-agent service', () => {
  const root = createFixture({
    productionPort: '3000:3000',
    extraProductionPort: '5000:5000',
    includeOpenCode: true,
  })
  try {
    const violations = findDeploymentSecurityViolations(root).violations.join('\n')
    assert.match(violations, /bare public port 3000 binding is forbidden/)
    assert.match(violations, /unexpected published port 5000:5000/)
    assert.match(violations, /coding-agent service is forbidden/)
    assert.match(violations, /coding-agent image, container, or port reference is forbidden/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
