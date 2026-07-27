#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

export function findDeploymentSecurityViolations(root) {
  const composeFiles = readdirSync(root)
    .filter((name) => /^docker-compose.*\.ya?ml$/.test(name))
    .sort()

  const violations = []

  function read(path) {
    return readFileSync(resolve(root, path), 'utf8')
  }

  for (const file of composeFiles) {
    const contents = read(file)
    if (/(^|\n)\s{2}opencode:\s*(\n|$)/.test(contents)) {
      violations.push(`${file}: coding-agent service is forbidden in supported Compose files`)
    }
    if (/docker\/opencode|opencode-mvp|mercato-opencode|(?:^|[^0-9])4096(?:[^0-9]|$)/i.test(contents)) {
      violations.push(`${file}: coding-agent image, container, or port reference is forbidden`)
    }
  }

  const productionCompose = read('docker-compose.prod.yml')
  if (!/["']127\.0\.0\.1:3000:3000["']/.test(productionCompose)) {
    violations.push('docker-compose.prod.yml: app port must be published only on 127.0.0.1')
  }
  if (/^\s*-\s*["']?3000:3000["']?\s*$/m.test(productionCompose)) {
    violations.push('docker-compose.prod.yml: bare public port 3000 binding is forbidden')
  }

  const productionPublishedPorts = [...productionCompose.matchAll(/^\s*-\s*["']([^"']+:[^"']+)["']\s*$/gm)]
    .map((match) => match[1])
    .filter((binding) => /:\d+$/.test(binding))

  const allowedProductionPorts = new Set([
    '127.0.0.1:3000:3000',
    '80:80',
    '443:443',
  ])

  for (const binding of productionPublishedPorts) {
    if (!allowedProductionPorts.has(binding)) {
      violations.push(`docker-compose.prod.yml: unexpected published port ${binding}`)
    }
  }

  const opencodeEntrypoint = read('docker/opencode/entrypoint.sh')
  if (/opencode serve[^\n]*--hostname\s+0\.0\.0\.0/.test(opencodeEntrypoint)) {
    violations.push('docker/opencode/entrypoint.sh: public coding-agent bind is forbidden')
  }
  if (!/\[\s+-z\s+"\$\{OPENCODE_SERVER_PASSWORD:-\}"/.test(opencodeEntrypoint)) {
    violations.push('docker/opencode/entrypoint.sh: direct execution must fail closed without authentication')
  }

  const workflow = read('.github/workflows/ci.yml')
  if (/docker\/opencode|Build opencode container/i.test(workflow)) {
    violations.push('.github/workflows/ci.yml: quarantined coding-agent image must not be built')
  }

  const dockerIngressPolicy = read('ops/host-security/noli-docker-ingress-policy')
  for (const required of ['--ctorigdstport 80', '--ctorigdstport 443', '-i "$PUBLIC_INTERFACE" -j DROP']) {
    if (!dockerIngressPolicy.includes(required)) {
      violations.push(`ops/host-security/noli-docker-ingress-policy: missing ${required}`)
    }
  }

  const dockerDropIn = read('ops/host-security/noli-ingress-policy.conf')
  if (!dockerDropIn.includes('ExecStartPost=/usr/local/sbin/noli-docker-ingress-policy')) {
    violations.push('ops/host-security/noli-ingress-policy.conf: Docker restart persistence is missing')
  }

  return { composeFiles, violations }
}

function main() {
  const { composeFiles, violations } = findDeploymentSecurityViolations(repoRoot)
  if (violations.length > 0) {
    console.error('Deployment security invariant check failed:')
    for (const violation of violations) {
      console.error(`- ${violation}`)
    }
    process.exit(1)
  }

  console.log(`Deployment security invariants pass across ${composeFiles.length} Compose files.`)
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main()
}
