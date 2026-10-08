# @dublyo/mailat

Send email from your app through your own [Mailat](https://github.com/dublyo/mailat) instance. You need three settings: the instance URL, an API key and a default From address.

- Zero runtime dependencies. ESM, CommonJS and TypeScript types are all included.
- Runs anywhere `fetch` exists: Node.js 18+, Next.js (Node and Edge), Nuxt/Nitro, Express, Cloudflare Workers, Bun and Deno.
- Every send carries an `Idempotency-Key`, so retries can never send the same email twice.
- Verifies webhook signatures with Web Crypto and returns typed events.
- A Go module with the same features lives in [`go/`](go/README.md).

```sh
npm install @dublyo/mailat
```

## Contents

- [Quick start](#quick-start)
- [Create an API key in Mailat](#create-an-api-key-in-mailat)
- [Which From addresses you can use](#which-from-addresses-you-can-use)
- [Where replies go](#where-replies-go)
- [API](#api)
- [Errors](#errors)
- [Retries and idempotency](#retries-and-idempotency)
- [Webhooks](#webhooks)
- [Framework recipes](#framework-recipes)
- [Go](#go)
- [Security notes](#security-notes)

## Quick start

Set three environment variables on your server:

```sh
MAILAT_URL=https://mail.example.com        # your Mailat instance (the client appends /api/v1)
MAILAT_API_KEY=ue_xxxxxxxxxxxxxxxxxxxx     # created on the API page in Mailat
MAILAT_FROM=noreply@example.com            # default sender on one of your verified domains
```

Then send:

```ts
import { Mailat } from '@dublyo/mailat'

const mailat = new Mailat() // reads MAILAT_URL, MAILAT_API_KEY, MAILAT_FROM

const { id, status } = await mailat.send({
  to: 'user@example.org',
  subject: 'Welcome',
  html: '<p>Thanks for signing up.</p>',
  text: 'Thanks for signing up.',
})
// status is "queued"; delivery happens in the background
```

You can also pass the settings in code. Options take priority over the environment:

```ts
const mailat = new Mailat({
  url: 'https://mail.example.com',
  apiKey: process.env.MAILAT_API_KEY,
  from: 'noreply@example.com',
})
```

| Option | Default | Notes |
|---|---|---|
| `url` | `MAILAT_URL` | Instance origin. `https://x`, `https://x/` and `https://x/api/v1` all work. HTTPS is required; plain `http://` is accepted only for `localhost` and `127.0.0.1`. |
| `apiKey` | `MAILAT_API_KEY` | Sent as `Authorization: Bearer <key>`. |
| `from` | `MAILAT_FROM` | Used when an email has no `from`. |
| `timeoutMs` | `30000` | Per attempt. `0`, negative or non-finite values fall back to the default; values above 2147483647 are capped. |
| `maxRetries` | `2` | Retries after the first attempt (0 to 2; larger values are capped at 2), so at most 3 attempts. `0` turns retries off. Note: in the Go client `MaxRetries: 0` means the default; use `-1` there. |
| `retryBaseDelayMs` | `500` | Base for exponential backoff. |
| `fetch` | `globalThis.fetch` | Supply your own fetch, for example for a proxy or for tests. |
| `dangerouslyAllowBrowser` | `false` | See [Security notes](#security-notes). |

## Create an API key in Mailat

1. Sign in to your Mailat instance as the organization owner or an admin.
2. Open **API** in the sidebar and click **Create API Key**.
3. Give the key a name and select these permissions:
   - **Send Email** (`email:send`) is required for `send` and `sendBatch`.
   - **Read Templates** (`templates:read`) is needed for `templates.list`, `templates.get` and for picking template IDs.
   - Optional: **Read Email** (`email:read`) for `emails.get`, and **Manage Email** (`email:manage`) for `emails.cancel`.
4. Copy the key right away. Mailat shows it only once. Store it in `MAILAT_API_KEY`.

A key acts as the user who created it. If a key lacks a scope, calls that need it fail with `403` (`MailatAuthError`, code `forbidden`).

| Method | Endpoint | Scope |
|---|---|---|
| `send` | `POST /api/v1/emails` | `email:send` |
| `sendBatch` | `POST /api/v1/emails/batch` | `email:send` |
| `emails.get` | `GET /api/v1/emails/:id` | `email:read` |
| `emails.cancel` | `DELETE /api/v1/emails/:id` | `email:manage` |
| `templates.list` / `templates.get` | `GET /api/v1/templates[/:uuid]` | `templates:read` |

## Which From addresses you can use

The API checks the From address against the key's owner:

- The domain must be added to Mailat, verified and active (and verified in SES when Mailat sends through SES).
- An owner or admin key may send as **any free address** on the organization's verified domains, such as `noreply@`, `billing@` or `alerts@`. The address does not need its own mailbox.
- The key owner must have **at least one identity of their own** on that domain.
- A key **cannot** send as another user's mailbox, that mailbox's `+tag` variants (`anna+news@`) or its aliases. These are rejected with `400 that From address belongs to another user`.
- Identities with sending turned off are rejected (`sending is disabled for this identity`).

`from` may be a bare address or include a display name, such as `Support <support@example.com>`; recipients then see "Support". Requires a Mailat server from October 2026 or later (commit `89a348b`); older servers accept a bare address only.

A rejected From address raises `MailatValidationError` (HTTP 400) with the server's message.

## Where replies go

Replies go to `replyTo` when you set it, otherwise to the From address.

- Sending from a free address such as `noreply@` that has no mailbox? Set `replyTo` to an address someone reads, for example `support@example.com`.
- If receiving is set up for the domain in Mailat and the reply address belongs to a mailbox, the reply lands in that mailbox. It also triggers an `email.received` webhook, so your app can react to replies.
- A contact form usually sets `replyTo` to the visitor's address, so clicking Reply in your inbox answers them (see [the server action recipe](#server-action)).

## API

### `mailat.send(email, options?)`

Sends one email and returns `{ id, messageId, status, acceptedAt }`. `id` is the email UUID, which you pass to `emails.get` and `emails.cancel`.

```ts
await mailat.send({
  to: ['a@example.org', 'b@example.org'], // string or string[]
  cc: 'manager@example.org',
  bcc: 'archive@example.com',
  from: 'billing@example.com',            // default: the client's `from`
  replyTo: 'support@example.com',
  subject: 'Your invoice',                // required (also with templates)
  html: '<p>Invoice attached.</p>',
  text: 'Invoice attached.',
  attachments: [
    { name: 'invoice.pdf', type: 'application/pdf', content: pdfBytes }, // Uint8Array, ArrayBuffer or base64 string
    { name: 'logo.png', type: 'image/png', content: logoBase64, disposition: 'inline', cid: 'logo' }, // <img src="cid:logo">
  ],
  tags: ['invoice'],
  metadata: { orderId: '1234' },          // string values
  scheduledFor: new Date(Date.now() + 3600_000), // Date or RFC 3339 string
  idempotencyKey: 'invoice-1234',         // 8-128 chars; see "Retries and idempotency"
})
```

Rules the client checks before sending, so you get a fast `MailatValidationError` without a request:

- `from` (or a default), `subject` and at least one recipient in `to`, `cc` or `bcc` are required.
- You need at least one of `html`, `text`, `templateId` or `attachments`.
- `idempotencyKey` must be 8 to 128 characters without line breaks and must not start with `mailat:` (reserved).

The second argument takes `{ idempotencyKey?, signal?, timeoutMs? }`.

### Templates

Build templates in Mailat, then send them by UUID with variables:

```ts
const templates = await mailat.templates.list()       // Template[]
const tpl = await mailat.templates.get('7c0e...uuid')  // { uuid, name, subject, htmlBody, textBody, variables, ... }

await mailat.send({
  to: 'user@example.org',
  subject: tpl.subject,          // the API requires a subject; the template's subject is rendered
  templateId: tpl.uuid,
  variables: { name: 'Ada', plan: 'Pro' },
})
```

### `mailat.sendBatch(emails, options?)`

Sends 1 to 100 emails in one request. Each item succeeds or fails on its own:

```ts
const { results, idempotencyKey } = await mailat.sendBatch(
  [
    { to: 'a@example.org', subject: 'News', text: 'Hello A' },
    { to: 'b@example.org', subject: 'News', text: 'Hello B', idempotencyKey: 'news-2026-10-b' },
  ],
  { idempotencyKey: 'news-2026-10' }, // whole-batch key; generated when omitted
)

for (const r of results) {
  if (r.status === 'failed') console.warn(`item ${r.index} rejected: ${r.error}`)
  else if (r.status === 'unknown') console.warn(`item ${r.index} unclear; resend the same batch with key ${idempotencyKey}`)
  else console.log(`item ${r.index} -> ${r.id} (${r.status})`)
}
```

The batch key goes in the `Idempotency-Key` header. An item's own `idempotencyKey` is sent as that item's key. Items without one get a key the server derives from the batch key and the item's position, so retrying the same batch with the same key is safe. The response includes the `idempotencyKey` that was used (the generated one if you did not pass one), so you can always retry `unknown` items by resending the identical batch with that key. `send()` returns its key the same way.

### `mailat.emails.get(id)` and `mailat.emails.cancel(id)`

```ts
const email = await mailat.emails.get(id)
// { id, messageId, from, to, subject, status, events: [{ eventType, timestamp, ... }], createdAt, sentAt?, deliveredAt? }

await mailat.emails.cancel(id) // only for scheduled emails that have not been sent yet
```

Cancelling an email that was already sent, or that does not exist, fails with `400 email not found or cannot be cancelled` (`MailatValidationError`). An ID that is not a UUID also fails with 400.

### Per-call options

Every method accepts `{ signal?: AbortSignal, timeoutMs?: number }`:

```ts
await mailat.emails.get(id, { signal: AbortSignal.timeout(5000) })
```

Aborting also stops any pending retry.

## Errors

Every error the package throws is a `MailatError` with these fields:

| Field | Meaning |
|---|---|
| `status` | HTTP status, or `0` when no response arrived |
| `code` | `validation_error`, `unauthorized`, `forbidden`, `not_found`, `conflict`, `rate_limited`, `server_error`, `service_unavailable`, `http_error`, `network_error`, `timeout`, `aborted`, `invalid_response`, `config_error`, `webhook_verification_failed` |
| `message` | The server's message, such as `sender domain not verified for your organization` |
| `requestId` | `X-Request-Id`, when a proxy in front of Mailat sets one |
| `details` | The `data` field of the error envelope, if any |

Subclasses let you branch with `instanceof`:

| Class | When |
|---|---|
| `MailatValidationError` | 400/422, or rejected locally before sending. Fix the request; retrying will not help. |
| `MailatAuthError` | 401 (bad, expired or revoked key) or 403 (missing scope) |
| `MailatNotFoundError` | 404 |
| `MailatConflictError` | 409: the idempotency key was already used with different content |
| `MailatRateLimitError` | 429, with `retryAfter` in seconds when the server sent `Retry-After` |
| `MailatWebhookVerificationError` | Webhook signature, timestamp or payload check failed |

```ts
import { MailatError, MailatAuthError, MailatRateLimitError, MailatValidationError } from '@dublyo/mailat'

try {
  await mailat.send(email)
} catch (err) {
  if (err instanceof MailatValidationError) return badRequest(err.message)
  if (err instanceof MailatAuthError) alertOps('Mailat key is invalid or missing a scope')
  if (err instanceof MailatRateLimitError) requeue(email, err.retryAfter)
  if (err instanceof MailatError) log(err.status, err.code, err.message)
  throw err
}
```

## Retries and idempotency

Mailat requires an `Idempotency-Key` (8 to 128 characters) on `POST /emails` and `POST /emails/batch`. The client always sends one: yours when you pass it, a random UUID otherwise. The key that was used comes back as `idempotencyKey` on the result of `send` and `sendBatch`, so you can resend the same request later with the same key.

The client retries:

- network errors and timeouts,
- `5xx` responses (Mailat answers `503` when the mail service is briefly unavailable),
- `429` responses. It waits for `Retry-After` when present (if that is longer than 60 seconds it throws instead of waiting); otherwise it uses exponential backoff with jitter.

That makes at most 3 attempts. Every retry reuses the same key and the same body, so Mailat processes the email at most once. `4xx` errors other than 429 are never retried.

A random key only protects the retries inside a single `send` call. If your own code may call `send` again for the same logical email (a job retry, a double-clicked button, a webhook handler that runs twice), pass a **deterministic key** built from your data:

```ts
await mailat.send({ to, subject, html, idempotencyKey: `order-${order.id}-receipt` })
```

Sending again with the same key and the same content returns the original result without sending again. The same key with different content fails with `409` (`MailatConflictError`).

## Webhooks

Mailat signs every webhook delivery:

```
X-Webhook-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>." + rawBody)>
X-Webhook-ID: <event id>
```

`Mailat.webhooks.verify` checks the signature against the **raw** request body, rejects timestamps more than 5 minutes off (change this with `toleranceSeconds`), compares in constant time, and only then parses the JSON. It returns a typed event or throws `MailatWebhookVerificationError`.

```ts
import { Mailat } from '@dublyo/mailat'

const event = await Mailat.webhooks.verify(rawBody, request.headers.get('x-webhook-signature'), process.env.MAILAT_WEBHOOK_SECRET!)
// also exported as verifyWebhook(rawBody, signature, secret, { toleranceSeconds: 300 })

switch (event.type) {
  case 'email.delivered': /* event.data.messageUuid */ break
  case 'email.bounced':
  case 'email.complained':
    // Mailat already adds these addresses to its own suppression list.
    // Transactional/mailbox mail: event.data.messageUuid -> (await mailat.emails.get(uuid)).to
    // Campaign mail: event.data.recipient and event.data.campaignUuid
    // Also: event.data.bounceType / event.data.complaintType
    break
  case 'email.received': /* a reply arrived: event.data.from, event.data.subject */ break
}
```

The event envelope is `{ version, id, type, createdAt, data }`. Event types:

- `email.sent`, `email.delivered`, `email.bounced`, `email.complained`, `email.failed`, `email.unknown`, `email.received`
- `contact.subscribed`
- `campaign.started`, `campaign.paused`, `campaign.cancelled`, `campaign.sent`
- `webhook.test` (sent only by the **Test** button)
- `automation.webhook` (sent only to an automation's own trigger target, with the same signature scheme)

Only `email.sent`, `email.failed` and `email.unknown` carry `from`, `to` and `subject`. Bounce and complaint events carry `messageUuid`, `providerMessageId`, `status` and `bounceType`/`complaintType`; campaign bounces and complaints carry `recipient` and `campaignUuid` instead of a message lookup.

Rules for webhook handlers:

- **Use the raw body.** Parsing the JSON and serialising it again changes the bytes, and the signature will not match. Each recipe below shows how to read the raw body in that framework.
- **Deduplicate on `event.id`.** Redeliveries and replays keep the same ID, which is also in `X-Webhook-ID`.
- **Answer quickly with a 2xx**, then do slow work in the background.
- Create the webhook in Mailat under **Settings → Integrations → Webhooks** and keep its signing secret in `MAILAT_WEBHOOK_SECRET`.

For tests, `Mailat.webhooks.sign(rawBody, secret, unixSeconds)` produces the same header Mailat sends.

## Framework recipes

The full files are in [`examples/`](examples/). All of them are type-checked in CI.

### Next.js (App Router)

Put `MAILAT_URL`, `MAILAT_API_KEY`, `MAILAT_FROM` and `MAILAT_WEBHOOK_SECRET` in `.env.local`. Never prefix them with `NEXT_PUBLIC_`.

#### Route handler

[`examples/nextjs-route-handler.ts`](examples/nextjs-route-handler.ts), saved as `app/api/welcome/route.ts`:

```ts
import { Mailat, MailatError, MailatValidationError } from '@dublyo/mailat'

export const runtime = 'nodejs' // 'edge' works too

// Create the client lazily so `next build` does not need the env vars.
let client: Mailat | undefined
const mailat = () => (client ??= new Mailat())

export async function POST(request: Request) {
  const { email, userId } = await request.json()
  try {
    const sent = await mailat().send({
      to: email,
      subject: 'Welcome aboard',
      html: '<p>Thanks for signing up.</p>',
      idempotencyKey: `welcome-${userId}`,
    })
    return Response.json({ id: sent.id, status: sent.status })
  } catch (err) {
    if (err instanceof MailatValidationError) return Response.json({ error: err.message }, { status: 400 })
    if (err instanceof MailatError) return Response.json({ error: 'Could not send email' }, { status: 502 })
    throw err
  }
}
```

#### Server action

[`examples/nextjs-server-action.ts`](examples/nextjs-server-action.ts), saved as `app/contact/actions.ts`:

```ts
'use server'
import { Mailat } from '@dublyo/mailat'

let client: Mailat | undefined
const mailat = () => (client ??= new Mailat())

export async function sendContact(_prev: unknown, formData: FormData) {
  const email = String(formData.get('email') ?? '')
  const message = String(formData.get('message') ?? '')
  await mailat().send({ to: 'support@example.com', replyTo: email, subject: `Contact form: ${email}`, text: message })
  return { ok: true, message: 'Thanks, we will get back to you.' }
}
```

Use it with `useActionState(sendContact, null)` and `<form action={formAction}>`.

#### Webhook route

[`examples/webhook-nextjs.ts`](examples/webhook-nextjs.ts), saved as `app/api/webhooks/mailat/route.ts`. Call `request.text()` and never `request.json()`:

```ts
import { Mailat, MailatWebhookVerificationError } from '@dublyo/mailat'

export async function POST(request: Request) {
  const rawBody = await request.text()
  try {
    const event = await Mailat.webhooks.verify(rawBody, request.headers.get('x-webhook-signature'), process.env.MAILAT_WEBHOOK_SECRET ?? '')
    // handle event.type ...
    return new Response(null, { status: 204 })
  } catch (err) {
    if (err instanceof MailatWebhookVerificationError) return new Response('invalid signature', { status: 401 })
    throw err
  }
}
```

### Nuxt (server routes)

`nuxt.config.ts`:

```ts
export default defineNuxtConfig({
  runtimeConfig: {
    // server-only (not under `public`); filled from NUXT_MAILAT_URL, NUXT_MAILAT_API_KEY, ...
    mailat: { url: '', apiKey: '', from: '', webhookSecret: '' },
  },
})
```

[`examples/nuxt-server-api.ts`](examples/nuxt-server-api.ts), saved as `server/api/welcome.post.ts`:

```ts
import { Mailat } from '@dublyo/mailat'

export default defineEventHandler(async (event) => {
  const { mailat: cfg } = useRuntimeConfig(event)
  const mailat = new Mailat({ url: cfg.url, apiKey: cfg.apiKey, from: cfg.from })
  const body = await readBody<{ email: string; userId: string }>(event)
  const sent = await mailat.send({
    to: body.email,
    subject: 'Welcome aboard',
    html: '<p>Thanks for signing up.</p>',
    idempotencyKey: `welcome-${body.userId}`,
  })
  return { id: sent.id }
})
```

[`examples/webhook-nuxt.ts`](examples/webhook-nuxt.ts), saved as `server/api/webhooks/mailat.post.ts`. Use `readRawBody` and never `readBody`:

```ts
import { Mailat, MailatWebhookVerificationError } from '@dublyo/mailat'

export default defineEventHandler(async (event) => {
  const { mailat: cfg } = useRuntimeConfig(event)
  const raw = await readRawBody(event, false) // exact bytes
  try {
    const ev = await Mailat.webhooks.verify(raw ?? '', getHeader(event, 'x-webhook-signature'), cfg.webhookSecret)
    // handle ev.type ...
    setResponseStatus(event, 204)
    return null
  } catch (err) {
    if (err instanceof MailatWebhookVerificationError) throw createError({ statusCode: 401, statusMessage: 'invalid signature' })
    throw err
  }
})
```

### Express

[`examples/express.ts`](examples/express.ts). Register the webhook route **before** `express.json()`, with `express.raw()`:

```ts
import express from 'express'
import { Mailat } from '@dublyo/mailat'

const mailat = new Mailat()
const app = express()

app.post('/webhooks/mailat', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const event = await Mailat.webhooks.verify(req.body, req.get('x-webhook-signature'), process.env.MAILAT_WEBHOOK_SECRET!)
    res.sendStatus(204)
  } catch {
    res.status(401).send('invalid signature')
  }
})

app.use(express.json())

app.post('/orders/:id/receipt', async (req, res) => {
  const sent = await mailat.send({
    to: req.body.email,
    subject: `Receipt for order ${req.params.id}`,
    html: '<p>Thanks!</p>',
    idempotencyKey: `receipt-${req.params.id}`,
  })
  res.json({ id: sent.id })
})
```

### Cloudflare Workers

[`examples/worker.ts`](examples/worker.ts). Workers have no `process.env`, so pass the bindings explicitly. No `nodejs_compat` flag is needed.

```ts
import { Mailat } from '@dublyo/mailat'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const mailat = new Mailat({ url: env.MAILAT_URL, apiKey: env.MAILAT_API_KEY, from: env.MAILAT_FROM })
    const sent = await mailat.send({ to: 'user@example.org', subject: 'Hello from a Worker', text: 'It works.' })
    return Response.json(sent)
  },
}
```

Store the key with `wrangler secret put MAILAT_API_KEY`. Webhooks work the same way: `await request.text()`, then `Mailat.webhooks.verify(...)`.

### Bun and Deno

Bun ([`examples/bun.ts`](examples/bun.ts)) loads `.env` automatically, so `new Mailat()` just works:

```ts
import { Mailat } from '@dublyo/mailat'
const mailat = new Mailat()
await mailat.send({ to: 'user@example.org', subject: 'Hello from Bun', text: 'It works.' })
```

Deno ([`examples/deno.ts`](examples/deno.ts)) runs with `--allow-net --allow-env`:

```ts
import { Mailat } from 'npm:@dublyo/mailat'
const mailat = new Mailat({
  url: Deno.env.get('MAILAT_URL'),
  apiKey: Deno.env.get('MAILAT_API_KEY'),
  from: Deno.env.get('MAILAT_FROM'),
})
```

### Plain Node.js

[`examples/node-script.ts`](examples/node-script.ts) calls every method once: send, template send, scheduled send and cancel, status, and batch.

CommonJS works too: `const { Mailat } = require('@dublyo/mailat')`.

## Go

The Go module offers the same features: send, batch, status, cancel, templates and webhook verification. It uses only the standard library.

```sh
go get github.com/dublyo/mailat-npm/go
```

```go
client, err := mailat.NewFromEnv()
res, err := client.Send(ctx, mailat.Email{To: []string{"user@example.org"}, Subject: "Hi", Text: "Hello"})
```

See [go/README.md](go/README.md) for the full guide and [examples/go/main.go](examples/go/main.go) for an HTTP server with a send route and a webhook route.

## Security notes

- **Server-side only.** An API key can send email as your domains. Never ship it to a browser, a mobile app or a `NEXT_PUBLIC_`/`VITE_`/Nuxt `public` variable. The constructor throws when it detects a browser page or a dedicated/shared browser Web Worker (Cloudflare Workers are fine). `dangerouslyAllowBrowser: true` turns that check off, but you should only do that for local tools that never reach other people.
- **Keep keys in environment variables or your platform's secret store** (Vercel/Netlify env, `wrangler secret`, Docker secrets). Do not commit them.
- **Use the narrowest scopes.** A sending service needs `email:send` and maybe `templates:read`. Set an expiry date and rotate keys from the API page.
- **HTTPS only.** The client refuses `http://` except for localhost, so the key never crosses the network in clear text.
- **Verify every webhook** before reading any field, and use the raw body. Unverified payloads are never parsed.
- **Keys are never echoed.** The constructor rejects a key with whitespace, control or non-ASCII characters without printing it, and network errors keep the runtime's raw message only in `error.cause`, so logging `error.message` cannot leak the key.
- **Mind header injection.** The client rejects line breaks in `from` and in idempotency keys, and the server validates every address.

## Development

```sh
npm ci
npm run typecheck && npm run typecheck:examples
npm test                      # builds with tsup, then runs node:test against a local fake Mailat server
cd go && go vet ./... && go test -race ./...
```

The tests never contact a real Mailat instance.

## License

[MIT](LICENSE) © Dublyo
