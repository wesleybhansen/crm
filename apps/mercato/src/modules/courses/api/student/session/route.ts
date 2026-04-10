export const metadata = { GET: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { cookies } from 'next/headers'

export async function GET(req: Request) {
  try {
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

    // Get enrollments
    const enrollments = await knex('course_enrollments as ce')
      .join('courses as c', 'ce.course_id', 'c.id')
      .where('ce.student_email', session.email)
      .where('ce.organization_id', session.organization_id)
      .where('ce.status', 'active')
      .whereNull('c.deleted_at')
      .select('ce.id as enrollment_id', 'ce.course_id', 'ce.enrolled_at', 'ce.completed_at', 'c.title', 'c.slug', 'c.description', 'c.image_url')

    return NextResponse.json({
      ok: true,
      data: { email: session.email, organizationId: session.organization_id, enrollments },
    })
  } catch (error) {
    console.error('[courses.student.session]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
