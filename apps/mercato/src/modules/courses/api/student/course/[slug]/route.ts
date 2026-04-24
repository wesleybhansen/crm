export const metadata = { GET: { requireAuth: false } }

import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { cookies } from 'next/headers'

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const cookieStore = await cookies()
    const sessionToken = cookieStore.get('course_session')?.value

    if (!sessionToken) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 })

    const session = await knex('course_student_sessions')
      .where('session_token', sessionToken)
      .where('expires_at', '>', new Date())
      .first()
    if (!session) return NextResponse.json({ ok: false, error: 'Session expired' }, { status: 401 })

    // Get course
    const course = await knex('courses')
      .where('slug', slug)
      .where('is_published', true)
      .whereNull('deleted_at')
      .first()
    if (!course) return NextResponse.json({ ok: false, error: 'Course not found' }, { status: 404 })

    // Verify enrollment
    const enrollment = await knex('course_enrollments')
      .where('student_email', session.email)
      .where('course_id', course.id)
      .where('status', 'active')
      .first()
    if (!enrollment) return NextResponse.json({ ok: false, error: 'Not enrolled' }, { status: 403 })

    // Get modules + lessons
    const modules = await knex('course_modules')
      .where('course_id', course.id)
      .orderBy('sort_order')

    const allLessons = await knex('course_lessons')
      .whereIn('module_id', modules.map((m: any) => m.id))
      .orderBy('sort_order')

    // Get progress
    const progress = await knex('lesson_progress')
      .where('enrollment_id', enrollment.id)
      .whereNotNull('completed_at')
    const completedIds = new Set(progress.map((p: any) => p.lesson_id))

    // Build response with drip enforcement
    const enrolledAt = new Date(enrollment.enrolled_at)
    const now = new Date()

    const modulesWithLessons = modules.map((mod: any) => {
      const lessons = allLessons
        .filter((l: any) => l.module_id === mod.id)
        .map((l: any) => {
          const dripDays = l.drip_days || 0
          const unlockDate = new Date(enrolledAt.getTime() + dripDays * 24 * 60 * 60 * 1000)
          const isLocked = dripDays > 0 && unlockDate > now

          return {
            id: l.id,
            title: l.title,
            contentType: l.content_type,
            description: l.description || null,
            content: isLocked ? null : l.content,
            videoUrl: isLocked ? null : l.video_url,
            fileUrl: isLocked ? null : (l.file_url || null),
            durationMinutes: l.duration_minutes,
            isFreePreview: l.is_free_preview,
            isCompleted: completedIds.has(l.id),
            isLocked,
            unlockDate: isLocked ? unlockDate.toISOString() : null,
          }
        })

      return { id: mod.id, title: mod.title, description: mod.description, lessons }
    })

    const totalLessons = allLessons.length
    const completedCount = progress.length

    return NextResponse.json({
      ok: true,
      data: {
        course: { id: course.id, title: course.title, description: course.description, imageUrl: course.image_url },
        enrollmentId: enrollment.id,
        modules: modulesWithLessons,
        progress: { totalLessons, completedCount, percentage: totalLessons > 0 ? Math.round((completedCount / totalLessons) * 100) : 0 },
      },
    })
  } catch (error) {
    console.error('[courses.student.course]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
