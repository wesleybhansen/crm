import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  ensureLandingPageImageDirectory,
  inventoryLandingPageImages,
  LANDING_PAGE_IMAGE_ROOT_ENV,
  readLandingPageImage,
  resolveLandingPageImageRoot,
  resolveLandingPageImagePath,
  verifiedImageExtension,
  writeLandingPageImage,
} from '@/modules/landing_pages/services/landing-page-image-storage'
import {
  normalizeLandingPageImagePreviewUrls,
  normalizeLegacyLandingPageImageUrls,
} from '@/modules/landing_pages/services/landing-page-image-urls'

const organizationId = '11111111-1111-4111-8111-111111111111'
const pageId = '22222222-2222-4222-8222-222222222222'
const filename = '33333333-3333-4333-8333-333333333333.png'

describe('landing-page image storage security', () => {
  it('accepts only a generated image name beneath exact UUID ownership directories', () => {
    const root = '/srv/crm/uploads/page-images'
    expect(resolveLandingPageImagePath({ root, organizationId, pageId, filename })).toBe(
      path.join(root, organizationId, pageId, filename),
    )
    expect(resolveLandingPageImagePath({
      root,
      organizationId,
      pageId,
      filename: '../../outside.png',
    })).toBeNull()
    expect(resolveLandingPageImagePath({
      root,
      organizationId,
      pageId: '../other-page',
      filename,
    })).toBeNull()
  })

  it('verifies image magic bytes instead of trusting the caller MIME type', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(verifiedImageExtension('image/png', png)).toBe('png')
    expect(verifiedImageExtension('image/png', Buffer.from('<script>'))).toBeNull()
    expect(verifiedImageExtension('image/svg+xml', Buffer.from('<svg/>'))).toBeNull()
  })

  it('rejects a generated-looking filename when any owned directory is a symlink', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-page-images-')))
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-page-images-outside-')))
    try {
      fs.mkdirSync(path.join(root, organizationId), { recursive: true })
      fs.writeFileSync(path.join(outside, filename), Buffer.from('not reachable'))
      fs.symlinkSync(outside, path.join(root, organizationId, pageId), 'dir')

      await expect(readLandingPageImage({ root, organizationId, pageId, filename })).resolves.toBeNull()
      expect(ensureLandingPageImageDirectory({ root, organizationId, pageId })).toBeNull()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('writes and asynchronously reads only a verified file in app-owned directories', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-page-images-')))
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    try {
      await expect(writeLandingPageImage({
        root,
        organizationId,
        pageId,
        filename,
        buffer: png,
      })).resolves.toBe(true)

      await expect(readLandingPageImage({
        root,
        organizationId,
        pageId,
        filename,
      })).resolves.toEqual({ buffer: png, contentType: 'image/png', size: png.length })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rewrites only generated relative legacy URLs and leaves third-party URLs untouched', () => {
    const legacyPath = `/api/pages/${pageId}/images/${filename}`
    const legacyQuery = `/api/landing_pages/pages/${pageId}/images?file=${filename}`
    const legacyShortQuery = `/api/pages/${pageId}/images?file=${filename}`
    const current = `/api/landing_pages/pages/${pageId}/images/${filename}`
    const thirdParty = `https://cdn.example.test/api/pages/${pageId}/images/${filename}`

    expect(normalizeLegacyLandingPageImageUrls(
      `<img src="${legacyPath}"><img src='${legacyQuery}'><img src="${legacyShortQuery}"><img src="${thirdParty}">`,
    )).toBe(`<img src="${current}"><img src='${current}'><img src="${current}"><img src="${thirdParty}">`)

    const privatePreview = `/api/landing_pages/pages/${pageId}/images?file=${filename}`
    expect(normalizeLandingPageImagePreviewUrls(
      `<img src="${legacyPath}"><img src='${current}'><img src="${thirdParty}">`,
    )).toBe(`<img src="${privatePreview}"><img src='${privatePreview}'><img src="${thirdParty}">`)
  })

  it('pins the production image root outside the Next.js standalone cwd', () => {
    const persistedRoot = '/app/apps/mercato/storage/attachments/landingPageImages'
    expect(resolveLandingPageImageRoot({
      [LANDING_PAGE_IMAGE_ROOT_ENV]: persistedRoot,
    }, '/app/apps/mercato/.mercato/next/standalone/apps/mercato')).toBe(persistedRoot)

    const repositoryRoot = fs.existsSync(path.join(process.cwd(), 'Dockerfile'))
      ? process.cwd()
      : path.resolve(process.cwd(), '..', '..')
    const dockerfile = fs.readFileSync(path.join(repositoryRoot, 'Dockerfile'), 'utf8')
    const compose = fs.readFileSync(path.join(repositoryRoot, 'docker-compose.prod.yml'), 'utf8')
    expect(dockerfile).toContain(`${LANDING_PAGE_IMAGE_ROOT_ENV}=${persistedRoot}`)
    expect(compose).toContain(`${LANDING_PAGE_IMAGE_ROOT_ENV}: ${persistedRoot}`)
    expect(compose).toContain('attachments_storage:/app/apps/mercato/storage')
  })

  it('counts legacy SVGs without exposing identifiers so rollout can fail closed', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-page-images-')))
    const legacySvg = '44444444-4444-4444-8444-444444444444.svg'
    try {
      const directory = ensureLandingPageImageDirectory({ root, organizationId, pageId })
      expect(directory).not.toBeNull()
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      fs.writeFileSync(path.join(directory!, filename), png)
      fs.writeFileSync(path.join(directory!, legacySvg), Buffer.from('<svg/>'))

      await expect(inventoryLandingPageImages(root)).resolves.toEqual(expect.objectContaining({
        supported: 1,
        legacySvg: 1,
        unsupported: 0,
        unsafeLinks: 0,
        invalidDirectories: 0,
        untrustedDirectories: 0,
        runtimeRejected: 0,
        contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('blocks rollout when a supported-looking file fails runtime byte validation', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-page-images-')))
    try {
      const directory = ensureLandingPageImageDirectory({ root, organizationId, pageId })
      fs.writeFileSync(path.join(directory!, filename), Buffer.from('<script>'))

      await expect(inventoryLandingPageImages(root)).resolves.toEqual(expect.objectContaining({
        supported: 0,
        runtimeRejected: 1,
      }))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects group/world-writable image files at runtime and in rollout inventory', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-page-images-')))
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    try {
      await expect(writeLandingPageImage({
        root,
        organizationId,
        pageId,
        filename,
        buffer: png,
      })).resolves.toBe(true)
      fs.chmodSync(path.join(root, organizationId, pageId, filename), 0o666)

      await expect(readLandingPageImage({ root, organizationId, pageId, filename })).resolves.toBeNull()
      await expect(inventoryLandingPageImages(root)).resolves.toEqual(expect.objectContaining({
        supported: 0,
        runtimeRejected: 1,
      }))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports a missing inventory root instead of treating it as authoritative emptiness', async () => {
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-page-images-')))
    try {
      await expect(inventoryLandingPageImages(path.join(parent, 'missing'))).resolves.toEqual(
        expect.objectContaining({ rootPresent: false, supported: 0 }),
      )
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })
})
