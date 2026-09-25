import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

export const metadata = {
  // Called from a public funnel page by signed-out visitors.
  POST: { requireAuth: false },
}

// POST: Advance funnel to next step (called after form submission on a landing page)
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    await bootstrap()
    const { slug } = await params
    const body = await req.json()
    const { sid, stepId, email, name } = body

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const funnel = await knex('funnels').where('slug', slug).where('is_published', true).first()
    if (!funnel) return NextResponse.json({ ok: false, error: 'Funnel not found' }, { status: 404 })

    // Session and step are bound to THIS funnel (2026-09-25 review, M7): a
    // sid from another funnel must not be advanced or have its email set.
    const session = sid ? await knex('funnel_sessions').where('id', sid).where('funnel_id', funnel.id).first() : null
    if (!session) return NextResponse.json({ ok: false, error: 'Session not found' }, { status: 404 })

    // Update session with captured email/name
    const updates: Record<string, any> = { updated_at: new Date() }
    if (email?.trim()) updates.email = email.trim()
    await knex('funnel_sessions').where('id', session.id).update(updates)

    // Find current step
    const currentStep = stepId
      ? await knex('funnel_steps').where('id', stepId).where('funnel_id', funnel.id).first()
      : await knex('funnel_steps').where('id', session.current_step_id).where('funnel_id', funnel.id).first()

    if (!currentStep) return NextResponse.json({ ok: false, error: 'Current step not found' }, { status: 404 })

    // Find next step
    const nextStep = await knex('funnel_steps')
      .where('funnel_id', funnel.id)
      .where('step_order', '>', currentStep.step_order)
      .orderBy('step_order')
      .first()

    const baseUrl = process.env.APP_URL || 'http://localhost:3000'

    if (nextStep) {
      await knex('funnel_sessions').where('id', session.id).update({ current_step_id: nextStep.id })
      return NextResponse.json({
        ok: true,
        redirectUrl: `${baseUrl}/api/landing_pages/funnels/public/${slug}?step=${nextStep.id}&sid=${session.id}`,
      })
    }

    // No next step — funnel complete
    return NextResponse.json({
      ok: true,
      redirectUrl: `${baseUrl}/api/landing_pages/funnels/public/${slug}?step=thank_you&sid=${session.id}`,
    })
  } catch (error) {
    console.error('[funnel.advance]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
