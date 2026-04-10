export const metadata = { OPTIONS: { requireAuth: true }, POST: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import crypto from 'crypto'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

export async function POST(req: Request) {
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { courseId, studentName, studentEmail } = body

    if (!courseId || !studentName?.trim() || !studentEmail?.trim()) {
      return NextResponse.json({ ok: false, error: 'courseId, studentName, and studentEmail are required' }, { status: 400, headers: CORS_HEADERS })
    }

    // Get course
    const course = await knex('courses')
      .where('id', courseId)
      .where('is_published', true)
      .whereNull('deleted_at')
      .first()

    if (!course) return NextResponse.json({ ok: false, error: 'Course not found' }, { status: 404, headers: CORS_HEADERS })

    // If course is free, redirect to enrollment instead
    if (course.is_free || !course.price || Number(course.price) <= 0) {
      return NextResponse.json({ ok: false, error: 'This course is free — use the enrollment endpoint instead', isFree: true }, { status: 400, headers: CORS_HEADERS })
    }

    // Check if already enrolled
    const existing = await knex('course_enrollments')
      .where('course_id', courseId)
      .where('student_email', studentEmail.trim().toLowerCase())
      .where('status', 'active')
      .first()
    if (existing) {
      return NextResponse.json({ ok: false, error: 'Already enrolled', alreadyEnrolled: true }, { status: 409, headers: CORS_HEADERS })
    }

    // Get org's Stripe connection
    const stripeConnection = await knex('stripe_connections')
      .where('organization_id', course.organization_id)
      .where('is_active', true)
      .first()

    const stripeKey = process.env.STRIPE_SECRET_KEY
    if (!stripeKey || !stripeConnection?.stripe_account_id) {
      return NextResponse.json({ ok: false, error: 'Payment processing is not configured' }, { status: 400, headers: CORS_HEADERS })
    }

    const Stripe = (await import('stripe')).default
    const stripe = new Stripe(stripeKey, { apiVersion: '2024-12-18.acacia' as any })

    const origin = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

    // Pre-generate magic link token for post-payment redirect
    const magicToken = crypto.randomBytes(32).toString('hex')
    await knex('course_magic_tokens').insert({
      id: crypto.randomUUID(),
      organization_id: course.organization_id,
      email: studentEmail.trim().toLowerCase(),
      token: magicToken,
      expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // perpetual
      created_at: new Date(),
    })

    // Create Stripe Checkout session on the connected account
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: (course.currency || 'usd').toLowerCase(),
          product_data: {
            name: course.title,
            description: course.description || undefined,
          },
          unit_amount: Math.round(Number(course.price) * 100),
        },
        quantity: 1,
      }],
      customer_email: studentEmail.trim(),
      metadata: {
        type: 'course',
        courseId: course.id,
        studentName: studentName.trim(),
        studentEmail: studentEmail.trim().toLowerCase(),
        orgId: course.organization_id,
        tenantId: course.tenant_id,
        magicToken,
      },
      success_url: `${origin}/api/courses/student/verify?token=${magicToken}`,
      cancel_url: `${origin}/api/courses/public/${course.slug}`,
    }, { stripeAccount: stripeConnection.stripe_account_id })

    return NextResponse.json({ ok: true, data: { url: session.url } }, { headers: CORS_HEADERS })
  } catch (error) {
    console.error('[courses.checkout]', error)
    return NextResponse.json({ ok: false, error: 'Failed to create checkout' }, { status: 500, headers: CORS_HEADERS })
  }
}
