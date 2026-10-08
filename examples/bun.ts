// Bun: `bun add @dublyo/mailat`, then `bun run bun.ts`. Bun loads .env, so
// MAILAT_URL / MAILAT_API_KEY / MAILAT_FROM are picked up automatically.
import { Mailat } from '@dublyo/mailat'

const mailat = new Mailat()

Bun.serve({
  port: 3000,
  async fetch(request) {
    if (request.method !== 'POST') return new Response('not found', { status: 404 })
    const { to } = (await request.json()) as { to: string }
    const sent = await mailat.send({ to, subject: 'Hello from Bun', text: 'It works.' })
    return Response.json({ id: sent.id })
  },
})
