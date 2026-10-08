// Plain Node.js (18+): every method in one place.
// MAILAT_URL=https://mail.example.com MAILAT_API_KEY=ue_... MAILAT_FROM=noreply@example.com node node-script.js
import { Mailat, MailatRateLimitError } from '@dublyo/mailat'

const mailat = new Mailat()

async function main(): Promise<void> {
  // One email
  const sent = await mailat.send({ to: 'user@example.org', subject: 'Hello', text: 'Hi there' })
  console.log(sent.id, sent.status)

  // Template email (subject is still required by the API)
  const templates = await mailat.templates.list()
  const welcome = templates.find((t) => t.name === 'Welcome')
  if (welcome) {
    const tpl = await mailat.templates.get(welcome.uuid)
    await mailat.send({ to: 'user@example.org', subject: tpl.subject, templateId: tpl.uuid, variables: { name: 'Ada' } })
  }

  // Scheduled email, then cancel it
  const later = await mailat.send({
    to: 'user@example.org',
    subject: 'Reminder',
    text: 'Your trial ends tomorrow.',
    scheduledFor: new Date(Date.now() + 24 * 60 * 60 * 1000),
  })
  await mailat.emails.cancel(later.id)

  // Status and delivery events
  const status = await mailat.emails.get(sent.id)
  console.log(status.status, status.events.map((e) => e.eventType))

  // Batch: each item succeeds or fails on its own
  const batch = await mailat.sendBatch(
    [
      { to: 'a@example.org', subject: 'News', text: 'Hello A' },
      { to: 'b@example.org', subject: 'News', text: 'Hello B' },
    ],
    { idempotencyKey: 'newsletter-2026-10-08' },
  )
  for (const r of batch.results) if (r.status === 'failed') console.warn(r.index, r.error)
}

main().catch((err) => {
  if (err instanceof MailatRateLimitError) console.error('rate limited, retry after', err.retryAfter, 's')
  else console.error(err)
  process.exitCode = 1
})
