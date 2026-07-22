import * as path from 'path'
import {
  inventoryLandingPageImages,
} from '../apps/mercato/src/modules/landing_pages/services/landing-page-image-storage'

function requiredRoot(argumentName: string): string {
  const argument = process.argv.find((value) => value.startsWith(`--${argumentName}=`))
  if (!argument) throw new Error(`Missing --${argumentName}=<absolute-path>`)
  const requested = argument.slice(argumentName.length + 3)
  if (!path.isAbsolute(requested)) throw new Error(`--${argumentName} must be absolute`)
  return path.resolve(requested)
}

function eligible(inventory: Awaited<ReturnType<typeof inventoryLandingPageImages>>): boolean {
  return inventory.legacySvg === 0 &&
    inventory.unsupported === 0 &&
    inventory.unsafeLinks === 0 &&
    inventory.invalidDirectories === 0 &&
    inventory.untrustedDirectories === 0 &&
    inventory.runtimeRejected === 0
}

async function main(): Promise<void> {
  const currentRoot = requiredRoot('root')
  const legacyRoot = requiredRoot('legacy-root')
  if (currentRoot === legacyRoot) throw new Error('Current and legacy roots must be distinct')

  const requireLegacyParity = process.argv.includes('--require-legacy-parity')
  const current = await inventoryLandingPageImages(currentRoot)
  const legacy = await inventoryLandingPageImages(legacyRoot)
  const legacyHasData = legacy.supported > 0 || !eligible(legacy)
  const legacyMirrored = current.rootPresent && legacy.rootPresent && eligible(legacy) &&
    legacy.supported === current.supported &&
    legacy.contentSha256 === current.contentSha256
  const ready = current.rootPresent && eligible(current) && (
    requireLegacyParity ? legacyMirrored : (!legacyHasData || legacyMirrored)
  )

  process.stdout.write(`${JSON.stringify({
    ready,
    mode: requireLegacyParity ? 'upgrade' : 'steady-state',
    migrationRequired: (requireLegacyParity || legacyHasData) && !legacyMirrored,
    legacyRetirementRecommended: legacy.supported > 0 && legacyMirrored,
    current,
    legacy,
  })}\n`)
  if (!ready) process.exitCode = 2
}

void main().catch(() => {
  process.stderr.write('Landing-page image preflight failed\n')
  process.exitCode = 1
})
