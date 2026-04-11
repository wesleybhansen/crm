export const metadata = { POST: { requireAuth: true }, GET: { requireAuth: true } }
export const openApi = { summary: 'images', methods: {} }
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { queryOne } from '@/lib/db'
import * as fs from 'fs'
import * as path from 'path'
import crypto from 'crypto'

const UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'page-images')
const MAX_SIZE = 10 * 1024 * 1024 // 10MB

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const { id: pageId } = await params

    const page = await queryOne('SELECT id FROM landing_pages WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL', [pageId, auth.orgId])
    if (!page) return NextResponse.json({ ok: false, error: 'Page not found' }, { status: 404 })

    const formData = await req.formData()
    const file = formData.get('file') as File | null
    if (!file) return NextResponse.json({ ok: false, error: 'No file provided' }, { status: 400 })

    if (file.size > MAX_SIZE) return NextResponse.json({ ok: false, error: 'File too large (max 10MB)' }, { status: 400 })

    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml']
    if (!allowedTypes.includes(file.type)) {
      return NextResponse.json({ ok: false, error: 'Invalid file type. Allowed: JPG, PNG, GIF, WebP, SVG' }, { status: 400 })
    }

    // Create upload directory
    const dir = path.join(UPLOAD_DIR, auth.orgId, pageId)
    fs.mkdirSync(dir, { recursive: true })

    // Generate filename
    const ext = file.name.split('.').pop() || 'png'
    const filename = `${crypto.randomUUID()}.${ext}`
    const filePath = path.join(dir, filename)

    // Write file
    const buffer = Buffer.from(await file.arrayBuffer())
    fs.writeFileSync(filePath, buffer)

    // Return public URL
    const imageUrl = `/api/pages/${pageId}/images/${filename}`

    return NextResponse.json({ ok: true, data: { url: imageUrl, filename, size: file.size, type: file.type } })
  } catch (error) {
    console.error('[pages.images.upload]', error)
    return NextResponse.json({ ok: false, error: 'Failed to upload' }, { status: 500 })
  }
}

// Serve uploaded images
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: pageId } = await params
    const url = new URL(req.url)
    const filename = url.searchParams.get('file')

    if (filename) {
      // Serve a specific file — find it across org directories
      const orgDirs = fs.existsSync(UPLOAD_DIR) ? fs.readdirSync(UPLOAD_DIR) : []
      for (const orgDir of orgDirs) {
        const filePath = path.join(UPLOAD_DIR, orgDir, pageId, filename)
        if (fs.existsSync(filePath)) {
          const buffer = fs.readFileSync(filePath)
          const ext = filename.split('.').pop()?.toLowerCase()
          const mimeTypes: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }
          return new Response(buffer, { headers: { 'Content-Type': mimeTypes[ext || ''] || 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000' } })
        }
      }
      return new Response('Not found', { status: 404 })
    }

    // List all images for this page
    const auth = await getAuthFromCookies()
    if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

    const dir = path.join(UPLOAD_DIR, auth.orgId, pageId)
    if (!fs.existsSync(dir)) return NextResponse.json({ ok: true, data: [] })

    const files = fs.readdirSync(dir).map(f => ({
      filename: f,
      url: `/api/pages/${pageId}/images?file=${f}`,
      size: fs.statSync(path.join(dir, f)).size,
    }))

    return NextResponse.json({ ok: true, data: files })
  } catch (error) {
    console.error('[pages.images.list]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
