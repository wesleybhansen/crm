export const metadata = { GET: { requireAuth: true } }
export const openApi = { summary: '[filename]', methods: {} }
import * as fs from 'fs'
import * as path from 'path'

const UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'page-images')

export async function GET(req: Request, { params }: { params: Promise<{ id: string; filename: string }> }) {
  try {
    const { id: pageId, filename } = await params

    // Search across org directories for this file
    if (!fs.existsSync(UPLOAD_DIR)) return new Response('Not found', { status: 404 })

    const orgDirs = fs.readdirSync(UPLOAD_DIR)
    for (const orgDir of orgDirs) {
      const filePath = path.join(UPLOAD_DIR, orgDir, pageId, filename)
      if (fs.existsSync(filePath)) {
        const buffer = fs.readFileSync(filePath)
        const ext = filename.split('.').pop()?.toLowerCase() || ''
        const mimeTypes: Record<string, string> = {
          jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
          gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
        }
        return new Response(buffer, {
          headers: {
            'Content-Type': mimeTypes[ext] || 'application/octet-stream',
            'Cache-Control': 'public, max-age=31536000',
          },
        })
      }
    }

    return new Response('Not found', { status: 404 })
  } catch {
    return new Response('Error', { status: 500 })
  }
}
