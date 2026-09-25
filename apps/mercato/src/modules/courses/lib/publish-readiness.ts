/* A course may only go live once it has something to teach. Publishing an
 * empty course put a public page online that advertised "0 lessons across
 * 0 modules", so the update route checks the saved lesson count before it
 * flips is_published on. Relative imports only. */

type KnexLike = (table: string) => any

export const COURSE_NEEDS_LESSONS_ERROR =
  'Add at least one lesson before publishing. Your course page will list your lessons, so it needs something to show.'

export const COURSE_NEEDS_LESSONS_CODE = 'course_has_no_lessons'

/** Returns the reason publishing is blocked, or null when the course can go live. */
export function publishBlockReason(lessonCount: number): string | null {
  if (!Number.isFinite(lessonCount) || lessonCount < 1) return COURSE_NEEDS_LESSONS_ERROR
  return null
}

/** Counts the lessons saved under a course's modules. */
export async function countCourseLessons(knex: KnexLike, courseId: string): Promise<number> {
  const rows = await knex('course_lessons')
    .join('course_modules', 'course_lessons.module_id', 'course_modules.id')
    .where('course_modules.course_id', courseId)
    .count('course_lessons.id as count')
  const raw = Array.isArray(rows) ? rows[0]?.count : undefined
  const n = Number(raw ?? 0)
  return Number.isFinite(n) ? n : 0
}
