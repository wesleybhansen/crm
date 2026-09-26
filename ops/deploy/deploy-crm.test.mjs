// Runs ops/deploy/deploy-crm.sh --dry-run with systemctl, git and docker
// stubbed on PATH. Proves the guarantees the script exists for, without a box.
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'deploy-crm.sh')

function sandbox({ activeUnits = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-crm-'))
  const bin = join(dir, 'bin')
  spawnSync('mkdir', ['-p', bin])
  const stub = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755) }
  stub('systemctl', `if [ "$1" = list-units ]; then printf '%s' "${activeUnits}"; fi; exit 0`)
  stub('git', 'echo abc1234')
  stub('docker', 'echo "docker must not run in a dry run" >&2; exit 99')
  stub('systemd-run', 'echo "systemd-run must not run in a dry run" >&2; exit 99')
  const base = join(dir, 'base.yml')
  writeFileSync(base, 'services: {}\n')
  return {
    dir, base,
    run: (args, env = {}) => spawnSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin`, CRM_REPO_DIR: dir, CRM_COMPOSE_BASE: base, ...env },
    }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('dry run: docker-compose.prod.yml only, cached build, preflight, systemd-run unit, DEPLOY_DONE marker', () => {
  const box = sandbox()
  try {
    const r = box.run(['--dry-run', '--ref', 'deadbeef'])
    assert.equal(r.status, 0, r.stderr + r.stdout)
    const out = r.stdout
    const systemdLine = out.split('\n').find((l) => l.startsWith('+ systemd-run'))
    assert.ok(systemdLine, out)
    assert.match(systemdLine, /--unit=crm-deploy-\d+/)
    assert.equal(systemdLine.split(`-f ${box.base}`).length - 1, 2, 'base file on build and up')
    assert.equal(systemdLine.split(' -f ').length - 1, 2, 'no other compose file (the Vault overlay is retired)')
    assert.doesNotMatch(systemdLine, /vault/i)
    assert.match(systemdLine, /build app/)
    assert.doesNotMatch(systemdLine, /--no-cache/, 'cache is on by default')
    assert.match(systemdLine, /up -d --force-recreate app mcp gtm-mailbox-worker gtm-execution-worker gtm-auto-refill-worker scheduler-worker/)
    assert.match(systemdLine, /DEPLOY_DONE commit=deadbeef rc=/)
    assert.match(out, /^\+ sh .*preflight-gtm-active-runs\.sh 60$/m)
    assert.match(out, /^\+ git -C .* checkout -q deadbeef$/m)
    assert.match(out, /^DEPLOY_DONE commit=deadbeef rc=0 unit=crm-deploy-\d+ dry-run=1$/m)
    assert.doesNotMatch(out, /DEPLOY_FAILED/)
  } finally { box.cleanup() }
})

test('--no-cache only when asked', () => {
  const box = sandbox()
  try {
    const r = box.run(['--dry-run', '--no-cache'])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /build --no-cache app/)
  } finally { box.cleanup() }
})

test('refuses while another crm-* unit is active', () => {
  const box = sandbox({ activeUnits: 'crm-build-1790298779.service loaded active running' })
  try {
    const r = box.run(['--dry-run'])
    assert.equal(r.status, 75)
    assert.match(r.stderr, /never overlap builds/)
    assert.match(r.stderr, /crm-build-1790298779/)
    assert.match(r.stdout, /^DEPLOY_FAILED step=busy-check rc=75$/m)
    assert.doesNotMatch(r.stdout, /systemd-run/)
  } finally { box.cleanup() }
})

test('runs without the retired Vault overlay file on the box', () => {
  const box = sandbox()
  try {
    const r = box.run(['--dry-run'], { CRM_COMPOSE_OVERLAY: join(box.dir, 'nope.yml') })
    assert.equal(r.status, 0, r.stderr)
    assert.doesNotMatch(r.stdout, /nope\.yml/)
  } finally { box.cleanup() }
})

test('fails fast when the compose file is missing', () => {
  const box = sandbox()
  try {
    const r = box.run(['--dry-run'], { CRM_COMPOSE_BASE: join(box.dir, 'nope.yml') })
    assert.equal(r.status, 66)
    assert.match(r.stderr, /Compose file missing: .*nope\.yml/)
    assert.equal((r.stdout.match(/DEPLOY_FAILED step=compose-files rc=66/g) ?? []).length, 1, 'one failure marker')
  } finally { box.cleanup() }
})

test('unknown options are refused', () => {
  const box = sandbox()
  try {
    const r = box.run(['--yolo'])
    assert.equal(r.status, 64)
    assert.match(r.stdout, /DEPLOY_FAILED step=arguments rc=64/)
  } finally { box.cleanup() }
})
