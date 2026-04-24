export const metadata = { GET: { requireAuth: false }, POST: { requireAuth: false } }

import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { cookies } from 'next/headers'
import crypto from 'crypto'

async function getStudentSession(knex: any) {
  const cookieStore = await cookies()
  const token = cookieStore.get('course_session')?.value
  if (!token) return null
  return knex('course_student_sessions').where('session_token', token).where('expires_at', '>', new Date()).first()
}

// GET: Get progress for an enrollment
export async function GET(req: Request) {
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const session = await getStudentSession(knex)
    if (!session) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 })

    const url = new URL(req.url)
    const enrollmentId = url.searchParams.get('enrollmentId')
    if (!enrollmentId) return NextResponse.json({ ok: false, error: 'enrollmentId required' }, { status: 400 })

    // Verify enrollment belongs to this student
    const enrollment = await knex('course_enrollments')
      .where('id', enrollmentId)
      .where('student_email', session.email)
      .first()
    if (!enrollment) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })

    const progress = await knex('lesson_progress')
      .where('enrollment_id', enrollmentId)
      .whereNotNull('completed_at')

    // Get total lesson count
    const modules = await knex('course_modules').where('course_id', enrollment.course_id).pluck('id')
    const totalLessons = modules.length > 0
      ? await knex('course_lessons').whereIn('module_id', modules).count('* as count').first()
      : { count: 0 }

    return NextResponse.json({
      ok: true,
      data: {
        completedLessonIds: progress.map((p: any) => p.lesson_id),
        totalLessons: Number(totalLessons?.count || 0),
        completedCount: progress.length,
      },
    })
  } catch (error) {
    console.error('[courses.student.progress.get]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

// POST: Mark a lesson complete
export async function POST(req: Request) {
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const session = await getStudentSession(knex)
    if (!session) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 })

    const body = await req.json()
    const { enrollmentId, lessonId } = body

    // Verify enrollment
    const enrollment = await knex('course_enrollments')
      .where('id', enrollmentId)
      .where('student_email', session.email)
      .first()
    if (!enrollment) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })

    // Verify lesson is not drip-locked
    const lesson = await knex('course_lessons').where('id', lessonId).first()
    if (lesson?.drip_days && lesson.drip_days > 0) {
      const unlockDate = new Date(new Date(enrollment.enrolled_at).getTime() + lesson.drip_days * 24 * 60 * 60 * 1000)
      if (unlockDate > new Date()) {
        return NextResponse.json({ ok: false, error: 'Lesson not yet unlocked' }, { status: 403 })
      }
    }

    // Upsert progress
    const existing = await knex('lesson_progress')
      .where('enrollment_id', enrollmentId)
      .where('lesson_id', lessonId)
      .first()

    if (!existing) {
      await knex('lesson_progress').insert({
        id: crypto.randomUUID(),
        enrollment_id: enrollmentId,
        lesson_id: lessonId,
        completed_at: new Date(),
      })
    } else if (!existing.completed_at) {
      await knex('lesson_progress').where('id', existing.id).update({ completed_at: new Date() })
    }

    // Check if all lessons are complete
    const modules = await knex('course_modules').where('course_id', enrollment.course_id).pluck('id')
    const totalLessons = modules.length > 0
      ? Number((await knex('course_lessons').whereIn('module_id', modules).count('* as count').first())?.count || 0)
      : 0
    const completedCount = Number((await knex('lesson_progress').where('enrollment_id', enrollmentId).whereNotNull('completed_at').count('* as count').first())?.count || 0)

    if (totalLessons > 0 && completedCount >= totalLessons && !enrollment.completed_at) {
      await knex('course_enrollments').where('id', enrollmentId).update({ completed_at: new Date(), status: 'completed' })
    }

    return NextResponse.json({ ok: true, data: { completedCount, totalLessons } })
  } catch (error) {
    console.error('[courses.student.progress.post]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
