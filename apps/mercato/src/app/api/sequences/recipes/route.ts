import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import crypto from 'crypto'

type RecipeStep = {
  stepOrder: number
  stepType: 'email' | 'wait' | 'condition' | 'sms'
  config: Record<string, unknown>
}

type Recipe = {
  id: string
  name: string
  description: string
  category: string
  triggerType: string
  triggerConfig: Record<string, unknown>
  steps: RecipeStep[]
}

const RECIPES: Recipe[] = [
  {
    id: 'welcome-series',
    name: 'Welcome Series',
    description: 'Introduce new leads to your business with a 3-email welcome sequence that builds trust and drives action.',
    category: 'Onboarding',
    triggerType: 'tag_added',
    triggerConfig: { tagSlug: 'new-lead' },
    steps: [
      {
        stepOrder: 1,
        stepType: 'email',
        config: {
          subject: 'Welcome to {{businessName}}!',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>Welcome aboard! We're thrilled to have you here. Over the next few days, we'll share how we can help you achieve your goals.</p>
<p>In the meantime, feel free to reply to this email if you have any questions -- we read every message.</p>
<p><b>Talk soon!</b></p>`,
        },
      },
      { stepOrder: 2, stepType: 'wait', config: { delay: 2, unit: 'days' } },
      {
        stepOrder: 3,
        stepType: 'email',
        config: {
          subject: "Here's how we can help",
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>We wanted to share the three biggest ways our customers see results:</p>
<p><b>1. Save time</b> -- automate the busywork so you can focus on what matters.<br/>
<b>2. Grow revenue</b> -- close more deals with smarter follow-ups.<br/>
<b>3. Stay organized</b> -- everything in one place, nothing falls through the cracks.</p>
<p>Curious which one resonates most? Just hit reply and let us know.</p>`,
        },
      },
      { stepOrder: 4, stepType: 'wait', config: { delay: 3, unit: 'days' } },
      {
        stepOrder: 5,
        stepType: 'email',
        config: {
          subject: 'Ready to get started?',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>By now you've had a chance to learn a bit about us. The best next step? <b>Let's hop on a quick call</b> so we can understand your needs and show you exactly how we can help.</p>
<p>Book a time that works for you, or simply reply to this email and we'll set it up.</p>
<p>Looking forward to connecting!</p>`,
        },
      },
    ],
  },
  {
    id: 'follow-up-after-call',
    name: 'Follow-Up After Call',
    description: 'Automatically follow up after a sales call with a recap and a gentle check-in a few days later.',
    category: 'Sales',
    triggerType: 'manual',
    triggerConfig: {},
    steps: [
      { stepOrder: 1, stepType: 'wait', config: { delay: 1, unit: 'days' } },
      {
        stepOrder: 2,
        stepType: 'email',
        config: {
          subject: 'Great talking with you!',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>Thanks for taking the time to chat today -- it was great learning more about what you're working on.</p>
<p>As a quick recap, here are the next steps we discussed. If anything looks off or you have additional questions, don't hesitate to reach out.</p>
<p><b>Looking forward to the next conversation!</b></p>`,
        },
      },
      { stepOrder: 3, stepType: 'wait', config: { delay: 4, unit: 'days' } },
      {
        stepOrder: 4,
        stepType: 'email',
        config: {
          subject: 'Just checking in',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>I wanted to follow up on our recent conversation. Have you had a chance to think things over?</p>
<p>I'm happy to answer any questions or jump on another quick call if that would be helpful. No pressure at all -- just want to make sure you have everything you need.</p>
<p>Talk soon!</p>`,
        },
      },
    ],
  },
  {
    id: 'post-purchase-thank-you',
    name: 'Post-Purchase Thank You',
    description: 'Thank customers after a purchase and follow up to check satisfaction and request a review.',
    category: 'Customer Success',
    triggerType: 'invoice_paid',
    triggerConfig: {},
    steps: [
      {
        stepOrder: 1,
        stepType: 'email',
        config: {
          subject: 'Thank you for your purchase!',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>Thank you for your order! We truly appreciate your business and are excited to get you started.</p>
<p>Your purchase has been confirmed and you should have everything you need to get going. If you run into any issues or have questions, our team is here to help -- just reply to this email.</p>
<p><b>Enjoy!</b></p>`,
        },
      },
      { stepOrder: 2, stepType: 'wait', config: { delay: 5, unit: 'days' } },
      {
        stepOrder: 3,
        stepType: 'email',
        config: {
          subject: "How's everything going?",
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>It's been a few days since your purchase and we wanted to check in. How's everything going so far?</p>
<p>If you're enjoying your experience, we'd love it if you could <b>leave us a quick review</b> -- it helps others find us and means the world to our team.</p>
<p>And if something isn't right, please let us know so we can make it better. We're all ears.</p>`,
        },
      },
    ],
  },
  {
    id: 'win-back-reengagement',
    name: 'Win-Back / Re-engagement',
    description: 'Re-engage inactive contacts with a 3-email series featuring updates, a special offer, and urgency.',
    category: 'Retention',
    triggerType: 'manual',
    triggerConfig: {},
    steps: [
      {
        stepOrder: 1,
        stepType: 'email',
        config: {
          subject: 'We miss you!',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>It's been a while since we last connected, and we wanted to reach out. A lot has changed and we think you'll be impressed with what's new.</p>
<p>We've been working hard on improvements based on feedback from customers like you. <b>Here's a quick look at what's new:</b></p>
<p>We'd love to have you back. Take a look and let us know what you think!</p>`,
        },
      },
      { stepOrder: 2, stepType: 'wait', config: { delay: 5, unit: 'days' } },
      {
        stepOrder: 3,
        stepType: 'email',
        config: {
          subject: 'Special offer just for you',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>Because we value your loyalty, we've put together a <b>special offer just for you</b>. This is our way of saying thank you and welcoming you back.</p>
<p>Use this opportunity to pick up where you left off -- we've saved your preferences and everything is ready for you.</p>
<p>This offer won't last forever, so take advantage while you can!</p>`,
        },
      },
      { stepOrder: 4, stepType: 'wait', config: { delay: 7, unit: 'days' } },
      {
        stepOrder: 5,
        stepType: 'email',
        config: {
          subject: 'Last chance',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>This is a friendly reminder that your <b>special offer expires soon</b>. We don't want you to miss out.</p>
<p>If now isn't the right time, no worries at all. But if you've been thinking about coming back, this is the perfect moment to jump in.</p>
<p>We'd love to see you again. <b>Claim your offer before it's gone!</b></p>`,
        },
      },
    ],
  },
  {
    id: 'booking-confirmation-reminder',
    name: 'Booking Confirmation + Reminder',
    description: 'Send an instant booking confirmation and a reminder before the appointment. Set the reminder wait to 0 days for simplicity.',
    category: 'Appointments',
    triggerType: 'booking_created',
    triggerConfig: {},
    steps: [
      {
        stepOrder: 1,
        stepType: 'email',
        config: {
          subject: 'Your booking is confirmed!',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p><b>Great news -- your appointment is confirmed!</b> Here are the details:</p>
<p>Please check your booking confirmation for the exact date, time, and location or meeting link. If you need to reschedule, just reply to this email and we'll sort it out.</p>
<p>To make the most of our time together, here are a few things to prepare beforehand: have any relevant documents or questions ready so we can dive right in.</p>
<p>See you soon!</p>`,
        },
      },
      { stepOrder: 2, stepType: 'wait', config: { delay: 0, unit: 'days' } },
      {
        stepOrder: 3,
        stepType: 'email',
        config: {
          subject: 'Reminder: Your appointment is tomorrow',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>Just a quick reminder that your <b>appointment is coming up tomorrow</b>. We're looking forward to meeting with you!</p>
<p>If you need to make any changes, please let us know as soon as possible. Otherwise, we'll see you at the scheduled time.</p>
<p>See you then!</p>`,
        },
      },
    ],
  },
  {
    id: 'new-lead-nurture',
    name: 'New Lead Nurture',
    description: 'Warm up new form submissions with credibility, social proof, and a call-to-action over 10 days.',
    category: 'Lead Nurturing',
    triggerType: 'form_submit',
    triggerConfig: {},
    steps: [
      {
        stepOrder: 1,
        stepType: 'email',
        config: {
          subject: 'Thanks for reaching out!',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>Thanks for getting in touch! We received your inquiry and wanted to let you know that a real person is on it.</p>
<p>In the next few days, we'll share some helpful information about who we are and how we've helped businesses like yours. In the meantime, feel free to reply with any questions.</p>
<p><b>We're glad you're here!</b></p>`,
        },
      },
      { stepOrder: 2, stepType: 'wait', config: { delay: 2, unit: 'days' } },
      {
        stepOrder: 3,
        stepType: 'email',
        config: {
          subject: '3 things you should know about us',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>We thought you'd like to know a bit more about what makes us different:</p>
<p><b>1. We're trusted by hundreds of businesses</b> just like yours.<br/>
<b>2. Our customers see results fast</b> -- most are up and running in under a week.<br/>
<b>3. We stand behind our work</b> with dedicated support and a satisfaction guarantee.</p>
<p>Want to see it in action? Just reply and we'll set up a quick walkthrough.</p>`,
        },
      },
      { stepOrder: 4, stepType: 'wait', config: { delay: 3, unit: 'days' } },
      {
        stepOrder: 5,
        stepType: 'email',
        config: {
          subject: 'Customer success story',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>We love sharing real results. One of our customers recently told us:</p>
<p><i>"Since switching, we've saved 10+ hours a week on manual tasks and closed 30% more deals in the first quarter. The team loves how easy it is to use."</i></p>
<p>Stories like this are why we do what we do. <b>We'd love to help you write your own success story.</b></p>
<p>Interested? Let us know and we'll show you how to get started.</p>`,
        },
      },
      { stepOrder: 6, stepType: 'wait', config: { delay: 5, unit: 'days' } },
      {
        stepOrder: 7,
        stepType: 'email',
        config: {
          subject: "Let's connect",
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>Over the past week, we've shared a bit about who we are and how we help. Now we'd love to hear from you.</p>
<p><b>Let's book a quick 15-minute call</b> so we can understand your goals and show you exactly how we can help you hit them.</p>
<p>No sales pitch, no pressure -- just a conversation. Reply to this email or click the link below to pick a time that works for you.</p>
<p>Looking forward to it!</p>`,
        },
      },
    ],
  },
  {
    id: 'referral-request',
    name: 'Referral Request',
    description: 'Ask happy customers for referrals after a deal is won, with a gratitude email followed by a soft referral ask.',
    category: 'Growth',
    triggerType: 'deal_stage_changed',
    triggerConfig: { stage: 'Won' },
    steps: [
      { stepOrder: 1, stepType: 'wait', config: { delay: 7, unit: 'days' } },
      {
        stepOrder: 2,
        stepType: 'email',
        config: {
          subject: 'Glad we could help!',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>Now that things are up and running, we just wanted to say <b>thank you</b> for choosing to work with us. It's been a pleasure.</p>
<p>We're committed to making sure you get the most value possible. If there's ever anything you need -- big or small -- don't hesitate to reach out.</p>
<p>Here's to a great partnership!</p>`,
        },
      },
      { stepOrder: 3, stepType: 'wait', config: { delay: 7, unit: 'days' } },
      {
        stepOrder: 4,
        stepType: 'email',
        config: {
          subject: 'Know someone who could benefit?',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>We're so glad things are going well! If you know a friend, colleague, or business contact who could benefit from what we offer, <b>we'd really appreciate an introduction</b>.</p>
<p>You can simply forward this email or reply with their name and email -- we'll take it from there with a friendly, no-pressure outreach.</p>
<p>Referrals from happy customers like you are the best compliment we can receive. Thank you for thinking of us!</p>`,
        },
      },
    ],
  },
  {
    id: 'course-drip',
    name: 'Course Drip',
    description: 'Deliver course content over time with a welcome email, module unlock, and progress check-in.',
    category: 'Education',
    triggerType: 'manual',
    triggerConfig: {},
    steps: [
      {
        stepOrder: 1,
        stepType: 'email',
        config: {
          subject: 'Welcome to the course!',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p><b>Welcome!</b> We're excited to have you enrolled. Here's what you can expect:</p>
<p>Over the coming days, we'll deliver each module straight to your inbox. Take your time with each one -- there's no rush. The goal is to learn at your own pace and actually apply what you learn.</p>
<p>If you have questions along the way, just reply to any of these emails. We're here to help.</p>
<p><b>Let's get started!</b></p>`,
        },
      },
      { stepOrder: 2, stepType: 'wait', config: { delay: 3, unit: 'days' } },
      {
        stepOrder: 3,
        stepType: 'email',
        config: {
          subject: 'Module 1 is ready',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>Your first module is ready! This one covers the fundamentals -- the building blocks for everything that follows.</p>
<p><b>Click below to access Module 1</b> and start learning. We recommend setting aside about 20-30 minutes to go through it thoroughly.</p>
<p>Pro tip: take notes as you go. The best learners are the ones who engage actively with the material.</p>
<p>Enjoy the lesson!</p>`,
        },
      },
      { stepOrder: 4, stepType: 'wait', config: { delay: 5, unit: 'days' } },
      {
        stepOrder: 5,
        stepType: 'email',
        config: {
          subject: "How's the course going?",
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>Just checking in! By now you should have had a chance to go through Module 1. How's it going so far?</p>
<p>If you're finding it valuable, keep the momentum going -- the next modules build on what you've learned. If you're stuck or have questions, <b>reply to this email</b> and we'll help you out.</p>
<p>Remember, the most important thing is progress, not perfection. Keep at it!</p>`,
        },
      },
    ],
  },
]

export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  return NextResponse.json({ ok: true, data: RECIPES })
}

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const body = await req.json()
    const { recipeId } = body

    if (!recipeId) {
      return NextResponse.json({ ok: false, error: 'recipeId is required' }, { status: 400 })
    }

    const recipe = RECIPES.find(r => r.id === recipeId)
    if (!recipe) {
      return NextResponse.json({ ok: false, error: 'Recipe not found' }, { status: 404 })
    }

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const sequenceId = crypto.randomUUID()
    const now = new Date()

    await knex('sequences').insert({
      id: sequenceId,
      tenant_id: auth.tenantId,
      organization_id: auth.orgId,
      name: recipe.name,
      description: recipe.description,
      trigger_type: recipe.triggerType,
      trigger_config: Object.keys(recipe.triggerConfig).length > 0
        ? JSON.stringify(recipe.triggerConfig)
        : null,
      status: 'draft',
      created_at: now,
      updated_at: now,
    })

    const insertedSteps = []
    for (const step of recipe.steps) {
      const stepId = crypto.randomUUID()
      const stepRow = {
        id: stepId,
        sequence_id: sequenceId,
        step_order: step.stepOrder,
        step_type: step.stepType,
        config: JSON.stringify(step.config),
        created_at: now,
      }
      await knex('sequence_steps').insert(stepRow)
      insertedSteps.push({ ...stepRow, config: step.config })
    }

    return NextResponse.json({
      ok: true,
      data: {
        id: sequenceId,
        name: recipe.name,
        description: recipe.description,
        trigger_type: recipe.triggerType,
        trigger_config: recipe.triggerConfig,
        status: 'draft',
        steps: insertedSteps,
        created_at: now,
      },
    }, { status: 201 })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed to install recipe' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Sequences',
  summary: 'Sequence automation recipes',
  methods: {
    GET: { summary: 'List all available automation recipes', tags: ['Sequences'] },
    POST: { summary: 'Install a recipe as a new sequence', tags: ['Sequences'] },
  },
}
