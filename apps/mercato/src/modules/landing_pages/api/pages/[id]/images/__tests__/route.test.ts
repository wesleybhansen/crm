import { queryOne } from '@/lib/db'
import {
  listLandingPageImages,
  readLandingPageImage,
  writeLandingPageImage,
} from '@/modules/landing_pages/services/landing-page-image-storage'

jest.mock('@/lib/db', () => ({ queryOne: jest.fn() }))
jest.mock('@/modules/landing_pages/services/landing-page-image-storage', () => {
  const actual = jest.requireActual('@/modules/landing_pages/services/landing-page-image-storage')
  return {
    ...actual,
    listLandingPageImages: jest.fn(),
    readLandingPageImage: jest.fn(),
    writeLandingPageImage: jest.fn(),
  }
})

import { GET as getImage, metadata as publicImageMetadata } from '../[filename]/route'
import {
  GET as listImages,
  POST as uploadImage,
  metadata as imageCollectionMetadata,
} from '../route'

const organizationA = '11111111-1111-4111-8111-111111111111'
const organizationB = '22222222-2222-4222-8222-222222222222'
const pageId = '33333333-3333-4333-8333-333333333333'
const filename = '44444444-4444-4444-8444-444444444444.png'
const mockQueryOne = jest.mocked(queryOne)
const mockReadImage = jest.mocked(readLandingPageImage)
const mockListImages = jest.mocked(listLandingPageImages)
const mockWriteImage = jest.mocked(writeLandingPageImage)

const auth = (orgId: string) => ({
  sub: '55555555-5555-4555-8555-555555555555',
  tenantId: '66666666-6666-4666-8666-666666666666',
  orgId,
  roles: [],
}) as any

function request(
  path = `/api/landing_pages/pages/${pageId}/images/${filename}`,
  clientIp?: string,
): Request {
  return new Request(`http://localhost${path}`, {
    headers: clientIp ? { 'x-real-ip': clientIp } : undefined,
  })
}

describe('landing-page image tenant and publication boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockReadImage.mockResolvedValue({
      buffer: Buffer.from('image'),
      contentType: 'image/png',
      size: 5,
    })
    mockListImages.mockResolvedValue([{ filename, size: 5 }])
    mockWriteImage.mockResolvedValue(true)
  })

  it('declares edit/view permissions while leaving published assets publicly addressable', () => {
    expect(imageCollectionMetadata.POST.requireFeatures).toEqual(['landing_pages.edit'])
    expect(imageCollectionMetadata.GET.requireFeatures).toEqual(['landing_pages.view'])
    expect(imageCollectionMetadata.GET.requireAuth).toBe(true)
    expect(publicImageMetadata.GET.requireAuth).toBe(false)
  })

  it('does not let authentication bypass the public-only draft boundary', async () => {
    mockQueryOne.mockResolvedValue({ organization_id: organizationA, status: 'draft' })

    const response = await getImage(request(), {
      params: Promise.resolve({ id: pageId, filename }),
      auth: auth(organizationB),
    } as any)

    expect(response.status).toBe(404)
    expect(mockReadImage).not.toHaveBeenCalled()
  })

  it('serves a published asset publicly from only its database-owned organization path', async () => {
    mockQueryOne.mockResolvedValue({
      organization_id: organizationA,
      status: 'published',
      image_is_published: true,
    })

    const response = await getImage(request(), {
      params: Promise.resolve({ id: pageId, filename }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(mockReadImage).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: organizationA,
      pageId,
      filename,
    }))
    expect(mockQueryOne).toHaveBeenCalledWith(
      expect.not.stringContaining('landing_page_variants'),
      [pageId, filename],
    )
    expect(mockQueryOne.mock.calls[0]?.[0]).toContain(
      "'/api/pages/' || lp.id::text || '/images?file='",
    )
  })

  it('serves an owned draft asset through only the feature-guarded route', async () => {
    mockQueryOne.mockResolvedValue({ organization_id: organizationA, status: 'draft' })

    const response = await listImages(
      request(`/api/landing_pages/pages/${pageId}/images?file=${filename}`),
      { params: Promise.resolve({ id: pageId }), auth: auth(organizationA) },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0')

    const listing = await listImages(
      request(`/api/landing_pages/pages/${pageId}/images`),
      { params: Promise.resolve({ id: pageId }), auth: auth(organizationA) },
    )
    const listingBody = await listing.json()
    expect(listing.status).toBe(200)
    expect(listingBody.data[0].url).toBe(
      `/api/landing_pages/pages/${pageId}/images?file=${filename}`,
    )
    expect(listingBody.data[0].publicUrl).toBe(
      `/api/landing_pages/pages/${pageId}/images/${filename}`,
    )
  })

  it('serves only active same-owner A/B assets when A/B is enabled', async () => {
    mockQueryOne
      .mockResolvedValueOnce({
        organization_id: organizationA,
        status: 'published',
        image_is_published: false,
      })
      .mockResolvedValueOnce({ image_is_published: true })

    const response = await getImage(request(), {
      params: Promise.resolve({ id: pageId, filename }),
    })

    expect(response.status).toBe(200)
    const variantSql = mockQueryOne.mock.calls[1]?.[0]
    expect(variantSql).toContain('lp.ab_enabled = true')
    expect(variantSql).toContain('variant.organization_id = lp.organization_id')
    expect(variantSql).toContain('variant.tenant_id = lp.tenant_id')
    expect(variantSql).toContain("variant.status = 'active'")
  })

  it('fails closed when the optional A/B schema is not provisioned', async () => {
    mockQueryOne
      .mockResolvedValueOnce({
        organization_id: organizationA,
        status: 'published',
        image_is_published: false,
      })
      .mockRejectedValueOnce(Object.assign(new Error('missing relation'), { code: '42P01' }))

    const response = await getImage(request(), {
      params: Promise.resolve({ id: pageId, filename }),
    })

    expect(response.status).toBe(404)
    expect(mockReadImage).not.toHaveBeenCalled()
  })

  it('rejects encoded traversal before a database or filesystem lookup', async () => {
    const response = await getImage(request(), {
      params: Promise.resolve({ id: pageId, filename: '../../secret.png' }),
    })

    expect(response.status).toBe(404)
    expect(mockQueryOne).not.toHaveBeenCalled()
    expect(mockReadImage).not.toHaveBeenCalled()
  })

  it('keeps the administrative image listing scoped to the authenticated organization', async () => {
    mockQueryOne.mockResolvedValue({ organization_id: organizationA, status: 'published' })

    const response = await listImages(
      request(`/api/landing_pages/pages/${pageId}/images`),
      { params: Promise.resolve({ id: pageId }), auth: auth(organizationB) },
    )

    expect(response.status).toBe(404)
    expect(mockListImages).not.toHaveBeenCalled()
  })

  it('ignores the user filename and writes a verified image under a generated path', async () => {
    mockQueryOne.mockResolvedValue({ organization_id: organizationA, status: 'draft' })
    const form = new FormData()
    form.set('file', new File([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ], '../../escape.svg', { type: 'image/png' }))

    const response = await uploadImage(new Request(
      `http://localhost/api/landing_pages/pages/${pageId}/images`,
      { method: 'POST', body: form },
    ), {
      params: Promise.resolve({ id: pageId }),
      auth: auth(organizationA),
    })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.filename).toMatch(/^[0-9a-f-]{36}\.png$/)
    expect(body.data.url).toBe(
      `/api/landing_pages/pages/${pageId}/images?file=${body.data.filename}`,
    )
    expect(body.data.publicUrl).toBe(
      `/api/landing_pages/pages/${pageId}/images/${body.data.filename}`,
    )
    expect(body.data.filename).not.toContain('escape')
    expect(mockWriteImage).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: organizationA,
      pageId,
      filename: body.data.filename,
      buffer: expect.any(Buffer),
    }))

    const draftRead = await listImages(request(body.data.url), {
      params: Promise.resolve({ id: pageId }),
      auth: auth(organizationA),
    })
    expect(draftRead.status).toBe(200)
    expect(mockReadImage).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: organizationA,
      pageId,
      filename: body.data.filename,
    }))
  })

  it('re-authorizes every public request so unpublishing revokes the image immediately', async () => {
    mockQueryOne
      .mockResolvedValueOnce({
        organization_id: organizationA,
        status: 'published',
        image_is_published: true,
      })
      .mockResolvedValueOnce({ organization_id: organizationA, status: 'draft' })

    const published = await getImage(request(), {
      params: Promise.resolve({ id: pageId, filename }),
    })
    const unpublished = await getImage(request(), {
      params: Promise.resolve({ id: pageId, filename }),
    })

    expect(published.status).toBe(200)
    expect(published.headers.get('cache-control')).toContain('no-store')
    expect(unpublished.status).toBe(404)
    expect(mockQueryOne).toHaveBeenCalledTimes(2)
  })

  it('revokes a replaced asset while the page itself remains published', async () => {
    mockQueryOne
      .mockResolvedValueOnce({
        organization_id: organizationA,
        status: 'published',
        image_is_published: true,
      })
      .mockResolvedValueOnce({
        organization_id: organizationA,
        status: 'published',
        image_is_published: false,
      })
      .mockResolvedValueOnce(null)

    const beforeReplacement = await getImage(request(), {
      params: Promise.resolve({ id: pageId, filename }),
    })
    const afterReplacement = await getImage(request(), {
      params: Promise.resolve({ id: pageId, filename }),
    })

    expect(beforeReplacement.status).toBe(200)
    expect(afterReplacement.status).toBe(404)
    expect(mockReadImage).toHaveBeenCalledTimes(1)
  })

  it('does not share one small rate-limit bucket across all assets on a page', async () => {
    mockQueryOne.mockResolvedValue({
      organization_id: organizationA,
      status: 'published',
      image_is_published: true,
    })
    const responses: Response[] = []
    for (let index = 1; index <= 61; index += 1) {
      const imageFilename = `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}.png`
      responses.push(await getImage(
        request(`/api/landing_pages/pages/${pageId}/images/${imageFilename}`, '192.0.2.10'),
        { params: Promise.resolve({ id: pageId, filename: imageFilename }) },
      ))
    }

    expect(responses.every((response) => response.status === 200)).toBe(true)
  })

  it('still bounds repeated reads of one public asset', async () => {
    mockQueryOne.mockResolvedValue({
      organization_id: organizationA,
      status: 'published',
      image_is_published: true,
    })
    let response: Response | null = null
    for (let index = 0; index < 61; index += 1) {
      response = await getImage(request(undefined, '198.51.100.20'), {
        params: Promise.resolve({ id: pageId, filename }),
      })
    }

    expect(response?.status).toBe(429)
  })
})
