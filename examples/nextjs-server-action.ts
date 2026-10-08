// app/contact/actions.ts — Next.js server action.
// Use it from a form: <form action={sendContact}>...</form>
'use server'

import { Mailat, MailatError } from '@dublyo/mailat'

let client: Mailat | undefined
const mailat = () => (client ??= new Mailat())

export type ContactState = { ok: boolean; message: string }

export async function sendContact(_prev: ContactState | null, formData: FormData): Promise<ContactState> {
  const email = String(formData.get('email') ?? '').trim()
  const message = String(formData.get('message') ?? '').trim()
  if (!email || !message) return { ok: false, message: 'Email and message are required.' }

  try {
    await mailat().send({
      to: 'support@example.com',
      replyTo: email, // hitting Reply in your inbox answers the visitor
      subject: `Contact form: ${email}`,
      text: message,
      tags: ['contact-form'],
    })
    return { ok: true, message: 'Thanks, we will get back to you.' }
  } catch (err) {
    if (err instanceof MailatError) console.error('mailat', err.code, err.message)
    return { ok: false, message: 'Sending failed, please try again.' }
  }
}
