import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'

export const LANDING_PAGE_IMAGE_ROOT_ENV = 'ATTACHMENTS_PARTITION_LANDING_PAGE_IMAGES_ROOT'

export function resolveLandingPageImageRoot(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  const configured = env[LANDING_PAGE_IMAGE_ROOT_ENV]?.trim()
  return configured
    ? path.resolve(configured)
    : path.join(cwd, 'storage', 'attachments', 'landingPageImages')
}

export const LANDING_PAGE_IMAGE_ROOT = resolveLandingPageImageRoot()
export const LEGACY_LANDING_PAGE_IMAGE_ROOT = path.join(process.cwd(), 'uploads', 'page-images')
export const MAX_LANDING_PAGE_IMAGE_BYTES = 10 * 1024 * 1024

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const IMAGE_FILENAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpe?g|png|gif|webp)$/i
const LEGACY_SVG_FILENAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.svg$/i

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
}

const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

export type LandingPageImageAsset = {
  buffer: Buffer
  contentType: string
  size: number
}

export type LandingPageImageInventory = {
  rootPresent: boolean
  supported: number
  legacySvg: number
  unsupported: number
  unsafeLinks: number
  invalidDirectories: number
  untrustedDirectories: number
  runtimeRejected: number
  contentSha256: string
}

type FileIdentity = Pick<fs.Stats, 'dev' | 'ino'>

export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

export function isGeneratedImageFilename(value: string): boolean {
  return IMAGE_FILENAME_RE.test(value)
}

export function verifiedImageExtension(contentType: string, buffer: Buffer): string | null {
  const extension = EXTENSION_BY_MIME[contentType]
  if (!extension) return null

  const valid = extension === 'jpg'
    ? buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
    : extension === 'png'
      ? buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : extension === 'gif'
        ? buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))
        : buffer.length >= 12 &&
          buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
          buffer.subarray(8, 12).toString('ascii') === 'WEBP'

  return valid ? extension : null
}

function isContained(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`)
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function trustedDirectory(stat: fs.Stats): boolean {
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) return false
  return typeof process.getuid !== 'function' || stat.uid === process.getuid()
}

function trustedRegularFile(stat: fs.Stats): boolean {
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) return false
  return typeof process.getuid !== 'function' || stat.uid === process.getuid()
}

export function resolveLandingPageImagePath(args: {
  root?: string
  organizationId: string
  pageId: string
  filename: string
}): string | null {
  if (
    !isUuid(args.organizationId) ||
    !isUuid(args.pageId) ||
    !isGeneratedImageFilename(args.filename)
  ) return null

  const root = path.resolve(args.root ?? LANDING_PAGE_IMAGE_ROOT)
  const pageDirectory = path.resolve(root, args.organizationId, args.pageId)
  const candidate = path.resolve(pageDirectory, args.filename)
  return isContained(root, pageDirectory) && isContained(pageDirectory, candidate)
    ? candidate
    : null
}

function safePageDirectory(args: {
  root?: string
  organizationId: string
  pageId: string
}): string | null {
  if (!isUuid(args.organizationId) || !isUuid(args.pageId)) return null
  const root = path.resolve(args.root ?? LANDING_PAGE_IMAGE_ROOT)
  const organizationDirectory = path.resolve(root, args.organizationId)
  const pageDirectory = path.resolve(organizationDirectory, args.pageId)
  if (!isContained(root, organizationDirectory) || !isContained(organizationDirectory, pageDirectory)) {
    return null
  }
  return pageDirectory
}

function hasOnlyTrustedDirectories(root: string, organizationId: string, pageId: string): boolean {
  try {
    const resolvedRoot = path.resolve(root)
    const organizationDirectory = path.join(resolvedRoot, organizationId)
    const pageDirectory = path.join(organizationDirectory, pageId)
    for (const directory of [resolvedRoot, organizationDirectory, pageDirectory]) {
      if (!trustedDirectory(fs.lstatSync(directory))) return false
    }
    const realRoot = fs.realpathSync(resolvedRoot)
    const realPageDirectory = fs.realpathSync(pageDirectory)
    return realPageDirectory === path.join(realRoot, organizationId, pageId)
  } catch {
    return false
  }
}

function ensureDirectoryTreeWithoutSymlinks(directory: string): boolean {
  const absolute = path.resolve(directory)
  const parsed = path.parse(absolute)
  let current = parsed.root
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)
  try {
    for (const segment of segments) {
      current = path.join(current, segment)
      if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o750 })
      const stat = fs.lstatSync(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false
    }
    return fs.realpathSync(absolute) === absolute
  } catch {
    return false
  }
}

export function ensureLandingPageImageDirectory(args: {
  root?: string
  organizationId: string
  pageId: string
}): string | null {
  const root = path.resolve(args.root ?? LANDING_PAGE_IMAGE_ROOT)
  const pageDirectory = safePageDirectory({ ...args, root })
  if (!pageDirectory) return null
  if (!ensureDirectoryTreeWithoutSymlinks(pageDirectory)) return null
  return hasOnlyTrustedDirectories(root, args.organizationId, args.pageId) ? pageDirectory : null
}

async function removeCreatedFileIfStillOwned(filePath: string, opened: fs.Stats): Promise<void> {
  try {
    const current = await fs.promises.lstat(filePath)
    if (current.isFile() && !current.isSymbolicLink() && sameIdentity(current, opened)) {
      await fs.promises.unlink(filePath)
    }
  } catch {
    // Best effort only; the caller still fails closed without writing content.
  }
}

export async function writeLandingPageImage(args: {
  root?: string
  organizationId: string
  pageId: string
  filename: string
  buffer: Buffer
}): Promise<boolean> {
  if (args.buffer.length <= 0 || args.buffer.length > MAX_LANDING_PAGE_IMAGE_BYTES) return false

  const root = path.resolve(args.root ?? LANDING_PAGE_IMAGE_ROOT)
  const directory = ensureLandingPageImageDirectory({ ...args, root })
  const filePath = resolveLandingPageImagePath({ ...args, root })
  if (!directory || !filePath || path.dirname(filePath) !== directory) return false

  const extension = path.extname(args.filename).slice(1).toLowerCase()
  const contentType = MIME_BY_EXTENSION[extension]
  const detectedExtension = contentType ? verifiedImageExtension(contentType, args.buffer) : null
  if (!detectedExtension || (extension !== detectedExtension && extension !== 'jpeg')) return false

  let handle: fs.promises.FileHandle | null = null
  let openedStat: fs.Stats | null = null
  let completed = false
  try {
    const directoryBefore = await fs.promises.lstat(directory)
    if (!trustedDirectory(directoryBefore)) return false

    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0
    handle = await fs.promises.open(
      filePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o640,
    )
    openedStat = await handle.stat()
    const [directoryAfter, pathAfter] = await Promise.all([
      fs.promises.lstat(directory),
      fs.promises.lstat(filePath),
    ])

    // The content is written only after the directory and pathname identities
    // still match the exact objects opened above. Combined with app-owned,
    // non-writable parent directories this prevents tenant-controlled swaps.
    if (
      !trustedDirectory(directoryAfter) ||
      !sameIdentity(directoryBefore, directoryAfter) ||
      !trustedRegularFile(openedStat) ||
      !trustedRegularFile(pathAfter) ||
      !sameIdentity(openedStat, pathAfter)
    ) return false

    await handle.writeFile(args.buffer)
    await handle.sync()
    const [completedStat, completedPath] = await Promise.all([
      handle.stat(),
      fs.promises.lstat(filePath),
    ])
    completed = trustedRegularFile(completedStat) &&
      trustedRegularFile(completedPath) &&
      sameIdentity(completedStat, completedPath) &&
      completedStat.size === args.buffer.length
    return completed
  } catch {
    return false
  } finally {
    if (handle) await handle.close().catch(() => undefined)
    if (openedStat && !completed) {
      await removeCreatedFileIfStillOwned(filePath, openedStat)
    }
  }
}

export async function readLandingPageImage(args: {
  root?: string
  organizationId: string
  pageId: string
  filename: string
}): Promise<LandingPageImageAsset | null> {
  const root = path.resolve(args.root ?? LANDING_PAGE_IMAGE_ROOT)
  const filePath = resolveLandingPageImagePath({ ...args, root })
  if (!filePath || !hasOnlyTrustedDirectories(root, args.organizationId, args.pageId)) return null

  let handle: fs.promises.FileHandle | null = null
  try {
    const directory = path.dirname(filePath)
    const [directoryBefore, pathBefore] = await Promise.all([
      fs.promises.lstat(directory),
      fs.promises.lstat(filePath),
    ])
    if (!trustedDirectory(directoryBefore) || !trustedRegularFile(pathBefore)) return null

    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow)
    const [openedStat, directoryAfter, pathAfter] = await Promise.all([
      handle.stat(),
      fs.promises.lstat(directory),
      fs.promises.lstat(filePath),
    ])
    if (
      !trustedRegularFile(openedStat) ||
      openedStat.size <= 0 ||
      openedStat.size > MAX_LANDING_PAGE_IMAGE_BYTES ||
      !trustedDirectory(directoryAfter) ||
      !sameIdentity(directoryBefore, directoryAfter) ||
      !trustedRegularFile(pathAfter) ||
      !sameIdentity(pathBefore, openedStat) ||
      !sameIdentity(openedStat, pathAfter)
    ) return null

    const extension = path.extname(args.filename).slice(1).toLowerCase()
    const contentType = MIME_BY_EXTENSION[extension]
    if (!contentType) return null
    const buffer = await handle.readFile()
    const detectedExtension = verifiedImageExtension(contentType, buffer)
    if (!detectedExtension || (extension !== detectedExtension && extension !== 'jpeg')) return null
    return { buffer, contentType, size: buffer.length }
  } catch {
    return null
  } finally {
    if (handle) await handle.close().catch(() => undefined)
  }
}

export async function listLandingPageImages(args: {
  root?: string
  organizationId: string
  pageId: string
}): Promise<Array<{ filename: string; size: number }> | null> {
  const root = path.resolve(args.root ?? LANDING_PAGE_IMAGE_ROOT)
  const pageDirectory = safePageDirectory({ ...args, root })
  if (!pageDirectory) return null
  try {
    await fs.promises.access(pageDirectory)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null
  }
  if (!hasOnlyTrustedDirectories(root, args.organizationId, args.pageId)) return null

  try {
    const entries = await fs.promises.readdir(pageDirectory)
    const images = await Promise.all(entries.filter(isGeneratedImageFilename).map(async (filename) => {
      const filePath = resolveLandingPageImagePath({ ...args, root, filename })
      if (!filePath) return null
      const stat = await fs.promises.lstat(filePath)
      return trustedRegularFile(stat) && stat.size <= MAX_LANDING_PAGE_IMAGE_BYTES
        ? { filename, size: stat.size }
        : null
    }))
    return images.filter((image): image is { filename: string; size: number } => image !== null)
  } catch {
    return null
  }
}

/**
 * Count-only rollout preflight. It never returns tenant IDs, page IDs, paths,
 * or filenames, and it never follows links. A non-zero legacy/unsafe count is
 * a deployment blocker until the affected asset is converted or removed.
 */
export async function inventoryLandingPageImages(
  root = LANDING_PAGE_IMAGE_ROOT,
): Promise<LandingPageImageInventory> {
  const inventory: LandingPageImageInventory = {
    rootPresent: false,
    supported: 0,
    legacySvg: 0,
    unsupported: 0,
    unsafeLinks: 0,
    invalidDirectories: 0,
    untrustedDirectories: 0,
    runtimeRejected: 0,
    contentSha256: createHash('sha256').update('').digest('hex'),
  }
  const resolvedRoot = path.resolve(root)
  const eligibleDigests: string[] = []

  let rootStat: fs.Stats
  try {
    rootStat = await fs.promises.lstat(resolvedRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return inventory
    throw error
  }
  if (rootStat.isSymbolicLink()) {
    inventory.unsafeLinks += 1
    return inventory
  }
  if (!rootStat.isDirectory()) {
    inventory.invalidDirectories += 1
    return inventory
  }
  inventory.rootPresent = true
  if (!trustedDirectory(rootStat)) inventory.untrustedDirectories += 1

  const organizations = await fs.promises.readdir(resolvedRoot, { withFileTypes: true })
  for (const organization of organizations) {
    if (organization.isSymbolicLink()) {
      inventory.unsafeLinks += 1
      continue
    }
    if (!organization.isDirectory() || !isUuid(organization.name)) {
      inventory.invalidDirectories += 1
      continue
    }
    const organizationDirectory = path.join(resolvedRoot, organization.name)
    const organizationStat = await fs.promises.lstat(organizationDirectory)
    if (!trustedDirectory(organizationStat)) inventory.untrustedDirectories += 1
    const pages = await fs.promises.readdir(organizationDirectory, { withFileTypes: true })
    for (const page of pages) {
      if (page.isSymbolicLink()) {
        inventory.unsafeLinks += 1
        continue
      }
      if (!page.isDirectory() || !isUuid(page.name)) {
        inventory.invalidDirectories += 1
        continue
      }
      const pageDirectory = path.join(organizationDirectory, page.name)
      const pageStat = await fs.promises.lstat(pageDirectory)
      if (!trustedDirectory(pageStat)) inventory.untrustedDirectories += 1
      const assets = await fs.promises.readdir(pageDirectory, { withFileTypes: true })
      for (const asset of assets) {
        if (asset.isSymbolicLink()) {
          inventory.unsafeLinks += 1
        } else if (!asset.isFile()) {
          inventory.unsupported += 1
        } else if (isGeneratedImageFilename(asset.name)) {
          const eligible = await readLandingPageImage({
            root: resolvedRoot,
            organizationId: organization.name,
            pageId: page.name,
            filename: asset.name,
          })
          if (eligible) {
            inventory.supported += 1
            const contentDigest = createHash('sha256').update(eligible.buffer).digest('hex')
            eligibleDigests.push(`${organization.name}/${page.name}/${asset.name}:${contentDigest}`)
          } else inventory.runtimeRejected += 1
        } else if (LEGACY_SVG_FILENAME_RE.test(asset.name)) {
          inventory.legacySvg += 1
        } else {
          inventory.unsupported += 1
        }
      }
    }
  }
  inventory.contentSha256 = createHash('sha256')
    .update(eligibleDigests.sort().join('\n'))
    .digest('hex')
  return inventory
}

export function landingPageImageResponse(
  asset: LandingPageImageAsset,
  filename: string,
): Response {
  const body = new Uint8Array(asset.buffer.byteLength)
  body.set(asset.buffer)
  return new Response(body, {
    headers: {
      'Content-Type': asset.contentType,
      'Content-Length': String(asset.size),
      'Content-Disposition': `inline; filename="${filename}"`,
      // Publication can be revoked at any time, so browsers and intermediary
      // caches must re-authorize every request against the current page row.
      'Cache-Control': 'private, no-store, max-age=0',
      'Pragma': 'no-cache',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
