
import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export const metadata = { POST: { requireAuth: false } }

/**
 * Classify email sentiment. Called internally when emails are received.
 * Can also be triggered by a cron to process unclassified emails.
 */
export async function POST(req: Request) {
  const secret = process.env.SEQUENCE_PROCESS_SECRET
  if (secret) {
    const authHeader = req.headers.get('authorization')
    if (authHeader !== `Bearer ${secret}`) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    }
  } else if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ ok: false, error: 'Not configured' }, { status: 500 })
  }

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Find unclassified inbound emails (no sentiment field yet)
    const emails = await knex('email_messages')
      .where('direction', 'inbound')
      .whereNull('sentiment')
      .orderBy('created_at', 'desc')
      .limit(20)

    if (emails.length === 0) {
      return NextResponse.json({ ok: true, processed: 0 })
    }

    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY
    if (!apiKey) {
      return NextResponse.json({ ok: true, processed: 0, note: 'AI not configured' })
    }

    let processed = 0

    for (const email of emails) {
      try {
        const bodyText = (email.body_text || email.body_html || '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .substring(0, 500)

        if (!bodyText || bodyText.length < 10) {
          await knex('email_messages').where('id', email.id).update({ sentiment: 'neutral' })
          processed++
          continue
        }

        const prompt = `Classify the sentiment of this email. Return ONLY one word: positive, neutral, negative, or urgent.

Rules:
- "negative" = complaints, frustration, disappointment, cancellation requests, anger
- "urgent" = time-sensitive requests, emergencies, escalations, deadlines mentioned
- "positive" = praise, thanks, satisfaction, enthusiasm, referrals
- "neutral" = informational, routine, questions, scheduling

Email:
"${bodyText}"

Sentiment:`

        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0, maxOutputTokens: 10 },
            }),
          }
        )

        const data = await res.json()
        const text = (data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim().toLowerCase()

        let sentiment = 'neutral'
        if (text.includes('negative')) sentiment = 'negative'
        else if (text.includes('urgent')) sentiment = 'urgent'
        else if (text.includes('positive')) sentiment = 'positive'

        await knex('email_messages').where('id', email.id).update({ sentiment })

        // If negative or urgent, log as a priority action item
        if (sentiment === 'negative' || sentiment === 'urgent') {
          const contact = email.contact_id
            ? await knex('customer_entities').where('id', email.contact_id).first()
            : null

          console.log(`[sentiment] ${sentiment.toUpperCase()}: email from ${contact?.display_name || email.from_address} — "${email.subject}"`)
        }

        processed++
      } catch (err) {
        console.error(`[sentiment] Failed to classify email ${email.id}:`, err)
        await knex('email_messages').where('id', email.id).update({ sentiment: 'neutral' })
        processed++
      }
    }

    return NextResponse.json({ ok: true, processed })
  } catch (error) {
    console.error('[ai.classify-sentiment]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'AI', summary: 'Classify email sentiment',
  methods: { POST: { summary: 'Classify sentiment of unprocessed inbound emails', tags: ['AI'] } },
}
