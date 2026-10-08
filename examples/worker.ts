// Cloudflare Worker: send + webhook. No nodejs_compat flag needed.
// wrangler secret put MAILAT_API_KEY ; wrangler secret put MAILAT_WEBHOOK_SECRET
// [vars] MAILAT_URL = "https://mail.example.com", MAILAT_FROM = "noreply@example.com"
import { Mailat, MailatError } from '@dublyo/mailat'

interface Env {
  MAILAT_URL: string
  MAILAT_API_KEY: string
  MAILAT_FROM: string
  MAILAT_WEBHOOK_SECRET: string
}

interface Ctx {
  waitUntil(promise: Promise<unknown>): void
}

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'POST' && url.pathname === '/webhooks/mailat') {
      try {
        const event = await Mailat.webhooks.verify(await request.text(), request.headers.get('x-webhook-signature'), env.MAILAT_WEBHOOK_SECRET)
        ctx.waitUntil(Promise.resolve(console.log('mailat event', event.type, event.id)))
        return new Response(null, { status: 204 })
      } catch {
        return new Response('invalid signature', { status: 401 })
      }
    }

    if (request.method === 'POST' && url.pathname === '/send') {
      // Workers have no process.env: pass the settings explicitly.
      const mailat = new Mailat({ url: env.MAILAT_URL, apiKey: env.MAILAT_API_KEY, from: env.MAILAT_FROM })
      const { to } = (await request.json()) as { to: string }
      try {
        const sent = await mailat.send({ to, subject: 'Hello from a Worker', text: 'It works.' })
        return Response.json(sent)
      } catch (err) {
        const status = err instanceof MailatError && err.status ? err.status : 502
        return Response.json({ error: (err as Error).message }, { status })
      }
    }

    return new Response('not found', { status: 404 })
  },
}
