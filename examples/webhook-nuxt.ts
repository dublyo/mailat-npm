// server/api/webhooks/mailat.post.ts — receive Mailat webhooks in Nuxt.
import { Mailat, MailatWebhookVerificationError } from '@dublyo/mailat'

export default defineEventHandler(async (event) => {
  const { mailat: cfg } = useRuntimeConfig(event)
  // readRawBody(event, false) returns the exact bytes; never use readBody here.
  const raw = await readRawBody(event, false)
  const signature = getHeader(event, 'x-webhook-signature')

  try {
    const ev = await Mailat.webhooks.verify(raw ?? '', signature, cfg.webhookSecret)
    // Bounces carry messageUuid (transactional) or recipient (campaign), not `to`.
    if (ev.type === 'email.bounced') console.log('bounce', ev.data.bounceType, ev.data.messageUuid ?? ev.data.recipient)
    setResponseStatus(event, 204)
    return null
  } catch (err) {
    if (err instanceof MailatWebhookVerificationError) throw createError({ statusCode: 401, statusMessage: 'invalid signature' })
    throw err
  }
})
