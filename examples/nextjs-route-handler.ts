// app/api/welcome/route.ts — Next.js App Router route handler.
// Env: MAILAT_URL, MAILAT_API_KEY, MAILAT_FROM (server-only, never NEXT_PUBLIC_).
import { Mailat, MailatError, MailatValidationError } from '@dublyo/mailat'

export const runtime = 'nodejs' // 'edge' works too: the client only needs fetch + Web Crypto

// Create the client lazily so `next build` does not need the env vars.
let client: Mailat | undefined
const mailat = () => (client ??= new Mailat())

export async function POST(request: Request): Promise<Response> {
  const { email, userId } = (await request.json()) as { email?: string; userId?: string }
  if (!email || !userId) return Response.json({ error: 'email and userId are required' }, { status: 400 })

  try {
    const sent = await mailat().send({
      to: email,
      subject: 'Welcome aboard',
      html: '<p>Thanks for signing up.</p>',
      text: 'Thanks for signing up.',
      tags: ['welcome'],
      metadata: { userId },
      // Same key for the same logical email: a double submit sends once.
      idempotencyKey: `welcome-${userId}`,
    })
    return Response.json({ id: sent.id, status: sent.status })
  } catch (err) {
    if (err instanceof MailatValidationError) return Response.json({ error: err.message }, { status: 400 })
    if (err instanceof MailatError) {
      console.error('mailat send failed', err.status, err.code, err.message)
      return Response.json({ error: 'Could not send email' }, { status: 502 })
    }
    throw err
  }
}
