import { publishBlockReason, countCourseLessons, COURSE_NEEDS_LESSONS_ERROR } from '../publish-readiness'

describe('publishBlockReason', () => {
  it('blocks a course with no lessons', () => {
    expect(publishBlockReason(0)).toBe(COURSE_NEEDS_LESSONS_ERROR)
  })

  it('blocks nonsense counts', () => {
    expect(publishBlockReason(Number.NaN)).toBe(COURSE_NEEDS_LESSONS_ERROR)
    expect(publishBlockReason(-1)).toBe(COURSE_NEEDS_LESSONS_ERROR)
  })

  it('allows a course with at least one lesson', () => {
    expect(publishBlockReason(1)).toBeNull()
    expect(publishBlockReason(12)).toBeNull()
  })

  it('uses plain copy with no em dashes', () => {
    expect(COURSE_NEEDS_LESSONS_ERROR).not.toMatch(/—/)
  })
})

describe('countCourseLessons', () => {
  function knexReturning(rows: unknown) {
    const calls: Array<[string, unknown[]]> = []
    const q: any = {
      join: (...a: unknown[]) => { calls.push(['join', a]); return q },
      where: (...a: unknown[]) => { calls.push(['where', a]); return q },
      count: async (...a: unknown[]) => { calls.push(['count', a]); return rows },
    }
    const knex = (table: string) => { calls.push(['table', [table]]); return q }
    return { knex, calls }
  }

  it('counts lessons across the course modules', async () => {
    const { knex, calls } = knexReturning([{ count: '3' }])
    await expect(countCourseLessons(knex, 'course-1')).resolves.toBe(3)
    expect(calls).toContainEqual(['table', ['course_lessons']])
    expect(calls).toContainEqual(['where', ['course_modules.course_id', 'course-1']])
  })

  it('treats an empty result as zero', async () => {
    const { knex } = knexReturning([])
    await expect(countCourseLessons(knex, 'course-1')).resolves.toBe(0)
  })
})
