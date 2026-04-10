export const metadata = { GET: { requireAuth: true }, POST: { requireAuth: true } }

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
  {
    id: 'event-warmup',
    name: 'Event Warm-Up Series',
    description: 'Build excitement before your event with a 3-email series: anticipation, prep tips, and a day-before reminder.',
    category: 'Events',
    triggerType: 'tag_added',
    triggerConfig: { tagSlug: 'event-registered' },
    steps: [
      {
        stepOrder: 1,
        stepType: 'email',
        config: {
          subject: "You're in! Here's what to expect",
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>You're officially registered -- exciting! Here's a quick preview of what's in store:</p>
<p>We've designed this event to be packed with value. Whether you're a beginner or experienced, you'll walk away with actionable takeaways you can use right away.</p>
<p>Keep an eye on your inbox -- we'll send you a prep guide before the event so you can get the most out of it.</p>
<p><b>See you there!</b></p>`,
        },
      },
      { stepOrder: 2, stepType: 'wait', config: { delay: 3, unit: 'days' } },
      {
        stepOrder: 3,
        stepType: 'email',
        config: {
          subject: 'How to prepare for the event',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>The event is coming up and we want to make sure you're set up for success. Here's how to prepare:</p>
<p><b>1.</b> Write down 2-3 specific questions you'd like answered<br/>
<b>2.</b> Block off the full time in your calendar (no multitasking!)<br/>
<b>3.</b> Find a quiet spot with good internet if joining virtually</p>
<p>The more prepared you are, the more you'll get out of it. Reply to this email if you have any questions beforehand.</p>`,
        },
      },
      { stepOrder: 4, stepType: 'wait', config: { delay: 3, unit: 'days' } },
      {
        stepOrder: 5,
        stepType: 'email',
        config: {
          subject: "Tomorrow's the day!",
          bodyHtml: `<p>Hi {{firstName}},</p>
<p><b>Quick reminder -- the event is tomorrow!</b></p>
<p>We're really looking forward to having you there. Everything is set and ready to go.</p>
<p>If you haven't already, save the event link and set a reminder so you don't miss the start. The best stuff happens right at the beginning.</p>
<p>See you tomorrow!</p>`,
        },
      },
    ],
  },
  {
    id: 'post-event-conversion',
    name: 'Post-Event Conversion',
    description: 'Turn event attendees into customers with a replay, social proof, and a limited-time offer over 7 days.',
    category: 'Events',
    triggerType: 'tag_added',
    triggerConfig: { tagSlug: 'event-attended' },
    steps: [
      {
        stepOrder: 1,
        stepType: 'email',
        config: {
          subject: 'Thanks for attending! Here\'s the replay',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>Thanks for showing up -- it was great having you there!</p>
<p>As promised, here's the replay and any resources we mentioned during the event. Feel free to share it with anyone who might find it valuable.</p>
<p>We'd love to hear your biggest takeaway. Just hit reply and let us know!</p>`,
        },
      },
      { stepOrder: 2, stepType: 'wait', config: { delay: 2, unit: 'days' } },
      {
        stepOrder: 3,
        stepType: 'email',
        config: {
          subject: 'What attendees are saying',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>We've been getting amazing feedback from the event. Here's what a few attendees had to say:</p>
<p><i>"This was exactly what I needed. Clear, actionable, and no fluff."</i></p>
<p><i>"I've already implemented one of the strategies and I'm seeing results."</i></p>
<p>If you want to take things further, we'd love to help. Reply to this email and let's chat about your next steps.</p>`,
        },
      },
      { stepOrder: 4, stepType: 'wait', config: { delay: 3, unit: 'days' } },
      {
        stepOrder: 5,
        stepType: 'email',
        config: {
          subject: 'Special offer for attendees (expires soon)',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>Because you showed up and invested your time, we want to offer you something special.</p>
<p>For the next 48 hours, you can access our program at an <b>exclusive attendee discount</b>. This is only available to people who were at the event.</p>
<p>If you've been on the fence, this is your sign. Reply to this email or click below to grab your spot before the offer expires.</p>
<p><b>Let's keep the momentum going!</b></p>`,
        },
      },
    ],
  },
  {
    id: 'proposal-follow-up',
    name: 'Proposal Follow-Up',
    description: 'Follow up on a sent proposal with a check-in, value reinforcement, and a final nudge.',
    category: 'Sales',
    triggerType: 'tag_added',
    triggerConfig: { tagSlug: 'proposal-sent' },
    steps: [
      { stepOrder: 1, stepType: 'wait', config: { delay: 3, unit: 'days' } },
      {
        stepOrder: 2,
        stepType: 'email',
        config: {
          subject: 'Quick follow-up on the proposal',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>I wanted to check in on the proposal I sent over. I know things get busy, so no pressure at all.</p>
<p>If you have any questions or want to adjust anything, I'm happy to hop on a quick call. I want to make sure the scope and pricing feel right for you.</p>
<p>Just hit reply and let me know what you're thinking!</p>`,
        },
      },
      { stepOrder: 3, stepType: 'wait', config: { delay: 4, unit: 'days' } },
      {
        stepOrder: 4,
        stepType: 'email',
        config: {
          subject: 'Why clients choose to work with us',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>While you're reviewing the proposal, I wanted to share a few reasons our clients love working with us:</p>
<p><b>Clear communication</b> -- you'll always know what's happening and what's next.<br/>
<b>Results-focused</b> -- everything we do is tied to measurable outcomes.<br/>
<b>Flexible approach</b> -- we adapt to your needs, not the other way around.</p>
<p>If this sounds like what you're looking for, I'd love to chat more. Just reply or grab a time on my calendar.</p>`,
        },
      },
      { stepOrder: 5, stepType: 'wait', config: { delay: 5, unit: 'days' } },
      {
        stepOrder: 6,
        stepType: 'email',
        config: {
          subject: 'Should I close this out?',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>I haven't heard back on the proposal and I completely understand if the timing isn't right.</p>
<p>I'm doing some housekeeping on my pipeline -- should I keep this open or close it out for now? Either way is totally fine.</p>
<p>If you'd like to revisit it later, just let me know and we can pick it back up whenever you're ready. No hard feelings either way.</p>`,
        },
      },
    ],
  },
  {
    id: 'client-onboarding',
    name: 'Client Onboarding',
    description: 'Onboard new clients with a welcome, getting-started guide, and first check-in over 10 days.',
    category: 'Customer Success',
    triggerType: 'deal_stage_changed',
    triggerConfig: { stage: 'Won' },
    steps: [
      {
        stepOrder: 1,
        stepType: 'email',
        config: {
          subject: 'Welcome! Let\'s get you set up',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p><b>Welcome aboard!</b> We're thrilled to officially be working together.</p>
<p>Here's what happens next:</p>
<p><b>1.</b> We'll send you a quick onboarding form to gather a few details<br/>
<b>2.</b> You'll get access to your dashboard and resources<br/>
<b>3.</b> We'll schedule our kickoff call to align on goals and timeline</p>
<p>In the meantime, reply to this email if you have any questions. We're here to make this as smooth as possible.</p>`,
        },
      },
      { stepOrder: 2, stepType: 'wait', config: { delay: 3, unit: 'days' } },
      {
        stepOrder: 3,
        stepType: 'email',
        config: {
          subject: 'Your getting-started guide',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>We put together a quick guide to help you hit the ground running. Here are the first things to do:</p>
<p><b>Complete your profile</b> -- this helps us personalize your experience.<br/>
<b>Explore the dashboard</b> -- poke around and see what's available.<br/>
<b>Bookmark our help center</b> -- answers to common questions are just a click away.</p>
<p>If you get stuck on anything, don't hesitate to reach out. We're just an email away.</p>`,
        },
      },
      { stepOrder: 4, stepType: 'wait', config: { delay: 7, unit: 'days' } },
      {
        stepOrder: 5,
        stepType: 'email',
        config: {
          subject: 'How\'s your first week going?',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>It's been about a week since we started working together and I wanted to check in.</p>
<p><b>How's everything going so far?</b> Is there anything that's been confusing or that you wish worked differently? Your honest feedback helps us serve you better.</p>
<p>I also want to make sure you're getting value from day one. If there's a quick win we can help you with, let's make it happen.</p>
<p>Just reply to this email -- I read every response.</p>`,
        },
      },
    ],
  },
  {
    id: 'webinar-replay',
    name: 'Webinar No-Show Recovery',
    description: 'Recover webinar no-shows with the replay link, key takeaways, and a conversion offer.',
    category: 'Events',
    triggerType: 'tag_added',
    triggerConfig: { tagSlug: 'webinar-no-show' },
    steps: [
      {
        stepOrder: 1,
        stepType: 'email',
        config: {
          subject: 'You missed it -- but here\'s the replay',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>We noticed you couldn't make it to the webinar -- no worries! Life happens.</p>
<p>The good news: we recorded the whole thing. <b>Watch the replay at your convenience</b> and you won't miss a thing.</p>
<p>Fair warning: the replay will only be available for a limited time, so don't wait too long!</p>`,
        },
      },
      { stepOrder: 2, stepType: 'wait', config: { delay: 2, unit: 'days' } },
      {
        stepOrder: 3,
        stepType: 'email',
        config: {
          subject: 'Top 3 takeaways from the webinar',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>In case you haven't had a chance to watch the full replay, here are the <b>top 3 takeaways</b>:</p>
<p><b>1.</b> The single biggest mistake most people make (and the easy fix)<br/>
<b>2.</b> A framework you can implement this week for immediate results<br/>
<b>3.</b> The #1 question attendees asked -- and the answer surprised everyone</p>
<p>Want the full picture? The replay is still available. Watch it before it expires!</p>`,
        },
      },
      { stepOrder: 4, stepType: 'wait', config: { delay: 3, unit: 'days' } },
      {
        stepOrder: 5,
        stepType: 'email',
        config: {
          subject: 'Last chance: replay expires tomorrow',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>Just a heads up -- the <b>webinar replay comes down tomorrow</b>.</p>
<p>If you've been meaning to watch it, now's the time. Attendees told us it was one of the most valuable sessions we've done.</p>
<p>Plus, we mentioned a special offer during the webinar that's still available for replay viewers. Don't miss out!</p>`,
        },
      },
    ],
  },
  {
    id: 'testimonial-request',
    name: 'Testimonial Collection',
    description: 'Collect testimonials from happy clients with a warm ask, a simple prompt, and a thank-you.',
    category: 'Growth',
    triggerType: 'tag_added',
    triggerConfig: { tagSlug: 'happy-client' },
    steps: [
      { stepOrder: 1, stepType: 'wait', config: { delay: 1, unit: 'days' } },
      {
        stepOrder: 2,
        stepType: 'email',
        config: {
          subject: 'Would you share your experience?',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>I'm so glad things are going well! Your success is the best part of what we do.</p>
<p>I have a small favor to ask: <b>would you be willing to share a quick testimonial</b> about your experience? It would mean the world to us and help others who are in the same position you were.</p>
<p>It doesn't have to be long -- even 2-3 sentences would be amazing. Just reply to this email with your thoughts!</p>`,
        },
      },
      { stepOrder: 3, stepType: 'wait', config: { delay: 4, unit: 'days' } },
      {
        stepOrder: 4,
        stepType: 'email',
        config: {
          subject: 'Quick and easy -- just answer these 3 questions',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>I know writing a testimonial from scratch can feel daunting, so here are <b>3 simple questions</b> to make it easy:</p>
<p><b>1.</b> What was your biggest challenge before working with us?<br/>
<b>2.</b> What specific result or change have you seen?<br/>
<b>3.</b> What would you say to someone considering working with us?</p>
<p>Just reply with your answers -- we'll take care of the rest. Thank you!</p>`,
        },
      },
    ],
  },
  {
    id: 'abandoned-cart',
    name: 'Abandoned Cart Recovery',
    description: 'Recover potential sales when someone starts but doesn\'t complete a purchase. 3-email nudge series.',
    category: 'Sales',
    triggerType: 'tag_added',
    triggerConfig: { tagSlug: 'cart-abandoned' },
    steps: [
      { stepOrder: 1, stepType: 'wait', config: { delay: 1, unit: 'hours' } },
      {
        stepOrder: 2,
        stepType: 'email',
        config: {
          subject: 'Did you forget something?',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>We noticed you started a purchase but didn't finish. No worries -- your cart is saved and waiting for you.</p>
<p>If you ran into any issues or have questions, just reply to this email. We're here to help!</p>
<p><b>Ready to complete your purchase?</b> Click below to pick up where you left off.</p>`,
        },
      },
      { stepOrder: 3, stepType: 'wait', config: { delay: 1, unit: 'days' } },
      {
        stepOrder: 4,
        stepType: 'email',
        config: {
          subject: 'Your cart is waiting',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>Just a friendly reminder -- you have items waiting in your cart. Here's what our customers love about it:</p>
<p><b>Quick setup</b> -- get started in minutes, not hours.<br/>
<b>Full support</b> -- we're here every step of the way.<br/>
<b>Risk-free</b> -- satisfaction guaranteed.</p>
<p>Complete your purchase today and start seeing results right away.</p>`,
        },
      },
      { stepOrder: 5, stepType: 'wait', config: { delay: 2, unit: 'days' } },
      {
        stepOrder: 6,
        stepType: 'email',
        config: {
          subject: 'Last call -- special offer inside',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>We don't want you to miss out. To sweeten the deal, here's an <b>exclusive discount</b> just for you.</p>
<p>This offer expires in 24 hours, so if you've been thinking about it, now's the perfect time to take action.</p>
<p>If you have any questions at all, hit reply -- we're happy to help you decide.</p>`,
        },
      },
    ],
  },
  {
    id: 'seasonal-promo',
    name: 'Seasonal Promotion',
    description: 'Run a time-limited promotion with a teaser, launch announcement, and last-chance urgency email.',
    category: 'Marketing',
    triggerType: 'manual',
    triggerConfig: {},
    steps: [
      {
        stepOrder: 1,
        stepType: 'email',
        config: {
          subject: 'Something exciting is coming...',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>We've been working on something special and you're going to be the first to know about it.</p>
<p><b>Stay tuned</b> -- in a couple of days, we're launching an exclusive offer that you won't want to miss. We're keeping the details under wraps for now, but trust us, it's going to be good.</p>
<p>Keep an eye on your inbox!</p>`,
        },
      },
      { stepOrder: 2, stepType: 'wait', config: { delay: 2, unit: 'days' } },
      {
        stepOrder: 3,
        stepType: 'email',
        config: {
          subject: "It's here! Our biggest offer of the season",
          bodyHtml: `<p>Hi {{firstName}},</p>
<p><b>The wait is over!</b> Our special promotion is officially live.</p>
<p>For a limited time, you can take advantage of our best pricing of the season. This is our way of saying thank you for being part of our community.</p>
<p>Here's what's included and why now is the perfect time to jump in. Don't wait too long -- this offer has a deadline.</p>
<p><b>Grab your spot before it fills up!</b></p>`,
        },
      },
      { stepOrder: 4, stepType: 'wait', config: { delay: 4, unit: 'days' } },
      {
        stepOrder: 5,
        stepType: 'email',
        config: {
          subject: 'Final hours: offer ends tonight',
          bodyHtml: `<p>Hi {{firstName}},</p>
<p>This is it -- our promotion <b>ends tonight at midnight</b>.</p>
<p>If you've been on the fence, this is your last chance to lock in the special pricing. After tonight, it goes back to regular price.</p>
<p>We don't do promotions like this often, so we'd hate for you to miss out. Take action now and thank yourself later.</p>
<p><b>See you on the other side!</b></p>`,
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
