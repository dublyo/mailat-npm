// Express: send endpoint + webhook endpoint.
// Env: MAILAT_URL, MAILAT_API_KEY, MAILAT_FROM, MAILAT_WEBHOOK_SECRET
import express from 'express'
import { Mailat, MailatError, MailatWebhookVerificationError } from '@dublyo/mailat'

const mailat = new Mailat()
const app = express()

// Register the webhook route BEFORE express.json(), with a raw parser, so the
// body is the exact bytes Mailat signed.
app.post('/webhooks/mailat', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const event = await Mailat.webhooks.verify(req.body as Buffer, req.get('x-webhook-signature'), process.env.MAILAT_WEBHOOK_SECRET ?? '')
    console.log('mailat event', event.type, event.id)
    res.sendStatus(204)
  } catch (err) {
    if (err instanceof MailatWebhookVerificationError) return void res.status(401).send('invalid signature')
    res.sendStatus(500)
  }
})

app.use(express.json())

app.post('/orders/:id/receipt', async (req, res) => {
  const { email } = req.body as { email: string }
  try {
    const sent = await mailat.send({
      to: email,
      subject: `Receipt for order ${req.params.id}`,
      html: `<p>Thanks for order <b>${req.params.id}</b>.</p>`,
      idempotencyKey: `receipt-${req.params.id}`,
    })
    res.json({ id: sent.id })
  } catch (err) {
    const status = err instanceof MailatError && err.status >= 400 && err.status < 500 ? 400 : 502
    res.status(status).json({ error: err instanceof Error ? err.message : 'send failed' })
  }
})

app.listen(3000)
