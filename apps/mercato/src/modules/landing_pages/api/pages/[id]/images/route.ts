export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['landing_pages.edit'] },
  GET: { requireAuth: true, requireFeatures: ['landing_pages.view'] },
}
export const openApi = { summary: 'images', methods: {} }

import { NextResponse } from 'next/server'
import { getAuthFromCookies, type AuthContext } from '@open-mercato/shared/lib/auth/server'
import crypto from 'crypto'
import { resolveLandingPageImageAccess } from '@/modules/landing_pages/services/landing-page-image-access'
import {
  LANDING_PAGE_IMAGE_ROOT,
  MAX_LANDING_PAGE_IMAGE_BYTES,
  isGeneratedImageFilename,
  landingPageImageResponse,
  listLandingPageImages,
  readLandingPageImage,
  verifiedImageExtension,
  writeLandingPageImage,
} from '@/modules/landing_pages/services/landing-page-image-storage'

type RouteContext = {
  params: Promise<{ id: string }>
  auth?: AuthContext | null
}

async function requestAuth(context: RouteContext): Promise<AuthContext | null> {
  if (Object.prototype.hasOwnProperty.call(context, 'auth')) return context.auth ?? null
  return await getAuthFromCookies()
}

export async function POST(req: Request, context: RouteContext) {
  const auth = await requestAuth(context)
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const { id: pageId } = await context.params
    const access = await resolveLandingPageImageAccess({
      pageId,
      authOrganizationId: auth.orgId,
      allowPublishedPublic: false,
    })
    if (!access) return NextResponse.json({ ok: false, error: 'Page not found' }, { status: 404 })

    const formData = await req.formData()
    const file = formData.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: 'No file provided' }, { status: 400 })
    }
    if (file.size <= 0 || file.size > MAX_LANDING_PAGE_IMAGE_BYTES) {
      return NextResponse.json({ ok: false, error: 'File must be between 1 byte and 10MB' }, { status: 400 })
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    const extension = verifiedImageExtension(file.type, buffer)
    if (!extension) {
      return NextResponse.json(
        { ok: false, error: 'Invalid image. Allowed: JPG, PNG, GIF, WebP' },
        { status: 400 },
      )
    }

    const filename = `${crypto.randomUUID()}.${extension}`
    const written = await writeLandingPageImage({
      root: LANDING_PAGE_IMAGE_ROOT,
      organizationId: access.organizationId,
      pageId,
      filename,
      buffer,
    })
    if (!written) throw new Error('Unsafe image write')

    const imageUrl = `/api/landing_pages/pages/${pageId}/images?file=${filename}`
    const publicUrl = `/api/landing_pages/pages/${pageId}/images/${filename}`
    return NextResponse.json({
      ok: true,
      data: { url: imageUrl, publicUrl, filename, size: buffer.length, type: file.type },
    })
  } catch (error) {
    console.error('[pages.images.upload]', error)
    return NextResponse.json({ ok: false, error: 'Failed to upload' }, { status: 500 })
  }
}

export async function GET(req: Request, context: RouteContext) {
  try {
    const { id: pageId } = await context.params
    const url = new URL(req.url)
    const filename = url.searchParams.get('file')
    const auth = await requestAuth(context)

    if (filename !== null) {
      if (!isGeneratedImageFilename(filename)) return new Response('Not found', { status: 404 })
      if (!auth?.orgId) return new Response('Not found', { status: 404 })
      const access = await resolveLandingPageImageAccess({
        pageId,
        authOrganizationId: auth.orgId,
        allowPublishedPublic: false,
      })
      if (!access) return new Response('Not found', { status: 404 })
      const asset = await readLandingPageImage({
        root: LANDING_PAGE_IMAGE_ROOT,
        organizationId: access.organizationId,
        pageId,
        filename,
      })
      return asset
        ? landingPageImageResponse(asset, filename)
        : new Response('Not found', { status: 404 })
    }

    if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    const access = await resolveLandingPageImageAccess({
      pageId,
      authOrganizationId: auth.orgId,
      allowPublishedPublic: false,
    })
    if (!access) return NextResponse.json({ ok: false, error: 'Page not found' }, { status: 404 })

    const images = await listLandingPageImages({
      root: LANDING_PAGE_IMAGE_ROOT,
      organizationId: access.organizationId,
      pageId,
    })
    if (images === null) throw new Error('Unsafe image directory')
    return NextResponse.json({
      ok: true,
      data: images.map((image) => ({
        ...image,
        url: `/api/landing_pages/pages/${pageId}/images?file=${image.filename}`,
        publicUrl: `/api/landing_pages/pages/${pageId}/images/${image.filename}`,
      })),
    })
  } catch (error) {
    console.error('[pages.images.list]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
