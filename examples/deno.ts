// Deno: deno run --allow-net --allow-env deno.ts
import { Mailat } from 'npm:@dublyo/mailat'

const mailat = new Mailat({
  url: Deno.env.get('MAILAT_URL'),
  apiKey: Deno.env.get('MAILAT_API_KEY'),
  from: Deno.env.get('MAILAT_FROM'),
})

Deno.serve(async (request) => {
  if (request.method !== 'POST') return new Response('not found', { status: 404 })
  const { to } = (await request.json()) as { to: string }
  const sent = await mailat.send({ to, subject: 'Hello from Deno', text: 'It works.' })
  return Response.json({ id: sent.id })
})
