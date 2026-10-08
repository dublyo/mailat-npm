// app/api/webhooks/mailat/route.ts — receive Mailat webhooks in Next.js.
// Env: MAILAT_WEBHOOK_SECRET (shown when you create the webhook in Mailat).
import { Mailat, MailatWebhookVerificationError } from '@dublyo/mailat'

export const runtime = 'nodejs'

export async function POST(request: Request): Promise<Response> {
  // Read the RAW body. Do not call request.json() first: re-serialised JSON
  // will not match the signature.
  const rawBody = await request.text()
  const signature = request.headers.get('x-webhook-signature')

  let event
  try {
    event = await Mailat.webhooks.verify(rawBody, signature, process.env.MAILAT_WEBHOOK_SECRET ?? '')
  } catch (err) {
    if (err instanceof MailatWebhookVerificationError) return new Response('invalid signature', { status: 401 })
    throw err
  }

  // Redeliveries keep the same event.id (also in the X-Webhook-ID header):
  // skip ids you have already processed.
  switch (event.type) {
    case 'email.delivered':
      console.log('delivered', event.data.messageUuid)
      break
    case 'email.bounced':
    case 'email.complained':
      // Mailat already suppresses these addresses itself. Bounce/complaint
      // events carry no `to`: transactional mail has messageUuid (look the
      // recipients up with mailat.emails.get), campaign mail has recipient.
      console.log(event.type, event.data.bounceType ?? event.data.complaintType, event.data.messageUuid ?? event.data.recipient)
      break
    case 'email.received':
      console.log('reply received from', event.data.from, 'subject', event.data.subject)
      break
    default:
      break
  }
  return new Response(null, { status: 204 })
}
