// server/api/welcome.post.ts — Nuxt 3/4 server route (Nitro).
// nuxt.config.ts:
//   runtimeConfig: { mailat: { url: '', apiKey: '', from: '', webhookSecret: '' } }
// Env: NUXT_MAILAT_URL, NUXT_MAILAT_API_KEY, NUXT_MAILAT_FROM, NUXT_MAILAT_WEBHOOK_SECRET
import { Mailat, MailatError, MailatValidationError } from '@dublyo/mailat'

export default defineEventHandler(async (event) => {
  const { mailat: cfg } = useRuntimeConfig(event)
  const mailat = new Mailat({ url: cfg.url, apiKey: cfg.apiKey, from: cfg.from })

  const body = await readBody<{ email?: string; userId?: string }>(event)
  if (!body?.email || !body.userId) throw createError({ statusCode: 400, statusMessage: 'email and userId are required' })

  try {
    const sent = await mailat.send({
      to: body.email,
      subject: 'Welcome aboard',
      html: '<p>Thanks for signing up.</p>',
      idempotencyKey: `welcome-${body.userId}`,
    })
    return { id: sent.id, status: sent.status }
  } catch (err) {
    if (err instanceof MailatValidationError) throw createError({ statusCode: 400, statusMessage: err.message })
    if (err instanceof MailatError) throw createError({ statusCode: 502, statusMessage: 'Could not send email' })
    throw err
  }
})
