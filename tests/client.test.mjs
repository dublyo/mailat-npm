import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  Mailat,
  MailatError,
  MailatAuthError,
  MailatValidationError,
  MailatNotFoundError,
  MailatConflictError,
  MailatRateLimitError,
  normalizeUrl,
} from '../dist/index.js'

const API_KEY = 'ue_test_0123456789abcdef'
const EMAIL_ID = '0b9e0f8c-6a7d-4c1e-9f61-3f6d2a1b7c55'
const TEMPLATE = {
  id: 7, uuid: '6f2b4c1a-2d3e-4f50-8a9b-0c1d2e3f4a5b', orgId: 1, name: 'Welcome', subject: 'Hi {{name}}',
  htmlBody: '<p>Hi {{name}}</p>', variables: ['name'], isActive: true, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
}

// ---------------------------------------------------------------------------
// A fake Mailat API that follows the real server's rules: Bearer API key,
// {code,message,data} envelope, Idempotency-Key 8-128 chars required on
// /emails and /emails/batch, same-key replay returns the same receipt and a
// changed body with a used key is a 409.
// ---------------------------------------------------------------------------
let server
let base
let requests = []
let script = [] // queued overrides: (req, body, res) => boolean (true = handled)
const receipts = new Map()

function send(res, status, payload, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
}
const ok = (res, data, message = 'success') => send(res, 200, { code: 0, message, data })
const fail = (res, status, message, headers) => send(res, status, { code: status, message }, headers)
const validKey = (k) => typeof k === 'string' && k.length >= 8 && k.length <= 128 && !/[\r\n]/.test(k)

function mailat(req, raw, res) {
  const url = new URL(req.url, 'http://x')
  const path = url.pathname
  if (req.headers.authorization !== `Bearer ${API_KEY}`) return fail(res, 401, 'Invalid, expired, or revoked API key')
  const body = raw ? JSON.parse(raw) : undefined
  const key = req.headers['idempotency-key']

  if (req.method === 'POST' && path === '/api/v1/emails') {
    if (body.idempotencyKey && key && body.idempotencyKey !== key) return fail(res, 400, 'header and body idempotency keys must match')
    if (!validKey(key ?? body.idempotencyKey)) return fail(res, 400, 'an Idempotency-Key of 8 to 128 characters is required')
    if (!body.from) return fail(res, 400, 'from is required')
    if (!body.subject) return fail(res, 400, 'subject is required')
    const prior = receipts.get(key)
    if (prior && prior.raw !== raw) return fail(res, 409, 'submission key was already used for different content')
    const receipt = prior?.receipt ?? { id: EMAIL_ID, messageId: '<abc@example.com>', status: body.scheduledFor ? 'scheduled' : 'queued', acceptedAt: '2026-10-08T10:00:00Z' }
    receipts.set(key, { raw, receipt })
    return ok(res, receipt, 'Email queued')
  }
  if (req.method === 'POST' && path === '/api/v1/emails/batch') {
    if (!validKey(key)) return fail(res, 400, 'an Idempotency-Key header of 8 to 128 characters is required')
    if (!Array.isArray(body.emails) || body.emails.length === 0) return fail(res, 400, 'At least one email required')
    return ok(res, {
      results: body.emails.map((e, index) =>
        e.to.includes('invalid')
          ? { index, status: 'failed', error: 'invalid recipient' }
          : { index, id: `id-${index}`, messageId: `<m${index}@x>`, status: 'queued' }),
    })
  }
  if (path === `/api/v1/emails/${EMAIL_ID}`) {
    if (req.method === 'GET') {
      return ok(res, { id: EMAIL_ID, messageId: '<abc@example.com>', from: 'a@example.com', to: ['b@example.com'], subject: 's', status: 'delivered', events: [], createdAt: '2026-10-08T10:00:00Z' })
    }
    if (req.method === 'DELETE') return ok(res, undefined, 'Email cancelled')
  }
  if (path.startsWith('/api/v1/emails/')) {
    if (req.method === 'DELETE') return fail(res, 400, 'email not found or cannot be cancelled')
    return fail(res, 404, 'email not found')
  }
  if (req.method === 'GET' && path === '/api/v1/templates') return ok(res, [TEMPLATE])
  if (req.method === 'GET' && path === `/api/v1/templates/${TEMPLATE.uuid}`) return ok(res, TEMPLATE)
  if (req.method === 'GET' && path.startsWith('/api/v1/templates/')) return fail(res, 404, 'template not found')
  return fail(res, 404, 'not found')
}

before(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, raw, body: raw ? JSON.parse(raw) : undefined })
      const override = script.shift()
      if (override && override(req, raw, res)) return
      mailat(req, raw, res)
    })
  })
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => {
  server.closeAllConnections?.()
  server.close()
})
beforeEach(() => {
  requests = []
  script = []
  receipts.clear()
})

const client = (opts = {}) => new Mailat({ url: base, apiKey: API_KEY, from: 'Support <support@example.com>', retryBaseDelayMs: 5, ...opts })

describe('send', () => {
  test('sends a display-name From as given, trimmed, and rejects line breaks', async () => {
    const c = client()
    await c.send({ to: 'a@example.com', subject: 's', text: 't', from: '"Billing, Inc" <billing@example.com>' })
    await c.send({ to: 'a@example.com', subject: 's', text: 't', from: ' plain@example.com ' })
    assert.equal(requests[0].body.from, '"Billing, Inc" <billing@example.com>')
    assert.equal(requests[1].body.from, 'plain@example.com')
    await assert.rejects(c.send({ to: 'a@example.com', subject: 's', text: 't', from: 'a@example.com\r\nBcc: x@y.z' }), /line break/)
    assert.equal(requests.length, 2)
  })

  test('posts to /api/v1/emails with auth, generated idempotency key and unwrapped data', async () => {
    const res = await client().send({ to: 'user@example.com', subject: 'Hello', text: 'Hi' })
    const r = requests[0]
    assert.deepEqual(res, { id: EMAIL_ID, messageId: '<abc@example.com>', status: 'queued', acceptedAt: '2026-10-08T10:00:00Z', idempotencyKey: r.headers['idempotency-key'] })
    assert.equal(requests.length, 1)
    assert.equal(r.method, 'POST')
    assert.equal(r.url, '/api/v1/emails')
    assert.equal(r.headers.authorization, `Bearer ${API_KEY}`)
    assert.equal(r.headers['content-type'], 'application/json')
    assert.match(r.headers['idempotency-key'], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.deepEqual(r.body, { from: 'Support <support@example.com>', to: ['user@example.com'], subject: 'Hello', text: 'Hi' })
  })

  test('each send gets a fresh key; an explicit key is sent in the header only', async () => {
    const c = client()
    await c.send({ to: 'a@example.com', subject: 's', text: 't' })
    await c.send({ to: 'a@example.com', subject: 's', text: 't' })
    assert.notEqual(requests[0].headers['idempotency-key'], requests[1].headers['idempotency-key'])

    await c.send({ to: 'a@example.com', subject: 's', text: 't', idempotencyKey: 'order-1234-welcome' })
    assert.equal(requests[2].headers['idempotency-key'], 'order-1234-welcome')
    assert.equal(requests[2].body.idempotencyKey, undefined)
    await c.send({ to: 'a@example.com', subject: 's', text: 't' }, { idempotencyKey: 'opt-key-0001' })
    assert.equal(requests[3].headers['idempotency-key'], 'opt-key-0001')
  })

  test('maps every field to the server DTO names', async () => {
    const when = new Date('2030-01-02T03:04:05.678Z')
    await client().send({
      from: 'Other <other@example.com>',
      to: ['a@example.com', 'b@example.com'],
      cc: 'c@example.com',
      bcc: ['d@example.com'],
      replyTo: 'reply@example.com',
      subject: 'Subject',
      html: '<b>x</b>',
      text: 'x',
      templateId: TEMPLATE.uuid,
      variables: { name: 'Ann' },
      attachments: [
        { name: 'a.txt', type: 'text/plain', content: new TextEncoder().encode('hello') },
        { name: 'b.txt', type: 'text/plain', content: 'aGk=' },
        { name: 'logo.png', type: 'image/png', content: new Uint8Array([1, 2, 3]).buffer, disposition: 'inline', cid: 'logo' },
        { blobId: '5c3a2f10-0000-4000-8000-000000000001' },
      ],
      tags: ['welcome'],
      metadata: { userId: '42' },
      scheduledFor: when,
    })
    assert.deepEqual(requests[0].body, {
      from: 'Other <other@example.com>',
      to: ['a@example.com', 'b@example.com'],
      cc: ['c@example.com'],
      bcc: ['d@example.com'],
      replyTo: 'reply@example.com',
      subject: 'Subject',
      html: '<b>x</b>',
      text: 'x',
      templateId: TEMPLATE.uuid,
      variables: { name: 'Ann' },
      attachments: [
        { name: 'a.txt', type: 'text/plain', content: Buffer.from('hello').toString('base64') },
        { name: 'b.txt', type: 'text/plain', content: 'aGk=' },
        { name: 'logo.png', type: 'image/png', content: 'AQID', disposition: 'inline', cid: 'logo' },
        { blobId: '5c3a2f10-0000-4000-8000-000000000001' },
      ],
      tags: ['welcome'],
      metadata: { userId: '42' },
      scheduledFor: '2030-01-02T03:04:05Z',
    })
  })

  test('validates locally before any request', async () => {
    const c = client()
    const cases = [
      [{ to: 'a@example.com', subject: 's', text: 't', idempotencyKey: 'short' }, /8 to 128/],
      [{ to: 'a@example.com', subject: 's', text: 't', idempotencyKey: 'x'.repeat(129) }, /8 to 128/],
      [{ to: 'a@example.com', subject: 's', text: 't', idempotencyKey: 'line\nbreak-key' }, /8 to 128/],
      [{ to: 'a@example.com', subject: 's', text: 't', idempotencyKey: 'Mailat:reserved' }, /reserved/],
      [{ to: [], subject: 's', text: 't' }, /recipient/],
      [{ to: 'a@example.com', subject: '', text: 't' }, /subject/],
      [{ to: 'a@example.com', subject: 's' }, /html, text, templateId/],
    ]
    for (const [email, pattern] of cases) {
      await assert.rejects(c.send(email), (e) => e instanceof MailatValidationError && pattern.test(e.message))
    }
    await assert.rejects(new Mailat({ url: base, apiKey: API_KEY }).send({ to: 'a@example.com', subject: 's', text: 't' }), /from is required/)
    assert.equal(requests.length, 0)
  })
})

describe('sendBatch', () => {
  test('sends one Idempotency-Key header, default from per item and keeps item keys', async () => {
    const res = await client().sendBatch(
      [
        { to: 'a@example.com', subject: 'one', text: '1' },
        { to: 'invalid', subject: 'two', text: '2', from: 'x@example.com', idempotencyKey: 'item-key-0002' },
      ],
      { idempotencyKey: 'batch-key-0001' },
    )
    assert.deepEqual(res.results, [
      { index: 0, id: 'id-0', messageId: '<m0@x>', status: 'queued' },
      { index: 1, status: 'failed', error: 'invalid recipient' },
    ])
    assert.equal(res.idempotencyKey, 'batch-key-0001')
    const r = requests[0]
    assert.equal(r.url, '/api/v1/emails/batch')
    assert.equal(r.headers['idempotency-key'], 'batch-key-0001')
    assert.deepEqual(r.body, {
      emails: [
        { from: 'Support <support@example.com>', to: ['a@example.com'], subject: 'one', text: '1' },
        { from: 'x@example.com', to: ['invalid'], subject: 'two', text: '2', idempotencyKey: 'item-key-0002' },
      ],
    })
  })

  test('generates a batch key and enforces 1..100 items and item key rules', async () => {
    const c = client()
    await c.sendBatch([{ to: 'a@example.com', subject: 's', text: 't' }])
    assert.ok(requests[0].headers['idempotency-key'].length >= 8)
    await assert.rejects(c.sendBatch([]), MailatValidationError)
    const many = Array.from({ length: 101 }, () => ({ to: 'a@example.com', subject: 's', text: 't' }))
    await assert.rejects(c.sendBatch(many), /between 1 and 100/)
    await assert.rejects(c.sendBatch([{ to: 'a@example.com', subject: 's', text: 't', idempotencyKey: 'tiny' }]), /emails\[0\]\.idempotencyKey/)
    await assert.rejects(c.sendBatch([{ to: 'a@example.com', subject: 's', text: 't' }], { idempotencyKey: 'mailat:batch' }), /reserved/)
    assert.equal(requests.length, 1)
  })
})

describe('returned idempotency keys', () => {
  test('send returns the generated key, and resending with it replays the same receipt', async () => {
    const c = client()
    const email = { to: 'a@example.com', subject: 's', text: 't' }
    const first = await c.send(email)
    assert.equal(first.idempotencyKey, requests[0].headers['idempotency-key'])
    const again = await c.send(email, { idempotencyKey: first.idempotencyKey })
    assert.equal(requests[1].headers['idempotency-key'], first.idempotencyKey)
    assert.equal(again.id, first.id)
    assert.equal((await c.send({ ...email, idempotencyKey: 'explicit-0001' })).idempotencyKey, 'explicit-0001')
  })

  test('sendBatch returns the generated key so unknown items can be retried with it', async () => {
    const c = client()
    const emails = [{ to: 'a@example.com', subject: 's', text: 't' }]
    script.push((req, raw, res) => (ok(res, { results: [{ index: 0, status: 'unknown', error: 'outcome unclear' }] }), true))
    const first = await c.sendBatch(emails)
    assert.equal(first.results[0].status, 'unknown')
    assert.match(first.idempotencyKey, /^[0-9a-f-]{36}$/)
    assert.equal(first.idempotencyKey, requests[0].headers['idempotency-key'])
    const retry = await c.sendBatch(emails, { idempotencyKey: first.idempotencyKey })
    assert.equal(requests[1].headers['idempotency-key'], first.idempotencyKey)
    assert.equal(requests[1].raw, requests[0].raw)
    assert.equal(retry.results[0].status, 'queued')
  })
})

describe('emails and templates', () => {
  test('emails.get returns the status; emails.cancel resolves', async () => {
    const c = client()
    const status = await c.emails.get(EMAIL_ID)
    assert.equal(status.status, 'delivered')
    assert.equal(await c.emails.cancel(EMAIL_ID), undefined)
    assert.deepEqual(requests.map((r) => `${r.method} ${r.url}`), [`GET /api/v1/emails/${EMAIL_ID}`, `DELETE /api/v1/emails/${EMAIL_ID}`])
  })

  test('404 → MailatNotFoundError; cancel of a sent email → MailatValidationError (server returns 400)', async () => {
    const c = client()
    await assert.rejects(c.emails.get('00000000-0000-4000-8000-000000000000'), (e) => {
      assert.ok(e instanceof MailatNotFoundError)
      assert.equal(e.status, 404)
      assert.equal(e.code, 'not_found')
      assert.equal(e.message, 'email not found')
      return true
    })
    await assert.rejects(c.emails.cancel('00000000-0000-4000-8000-000000000000'), MailatValidationError)
    assert.equal(requests.length, 2, '4xx errors are not retried')
  })

  test('ids are path-encoded', async () => {
    await assert.rejects(client().emails.get('../templates'), MailatNotFoundError)
    assert.equal(requests[0].url, '/api/v1/emails/..%2Ftemplates')
  })

  test('templates.list and templates.get', async () => {
    const c = client()
    assert.deepEqual(await c.templates.list(), [TEMPLATE])
    assert.deepEqual(await c.templates.get(TEMPLATE.uuid), TEMPLATE)
    await assert.rejects(c.templates.get('missing'), MailatNotFoundError)
    script.push((req, raw, res) => (ok(res, null), true))
    assert.deepEqual(await c.templates.list(), [], 'a null list becomes []')
  })
})

describe('errors', () => {
  test('401/403/400/409 map to typed errors and are not retried', async () => {
    await assert.rejects(new Mailat({ url: base, apiKey: 'ue_wrong', from: 'a@example.com' }).templates.list(), (e) => {
      assert.ok(e instanceof MailatAuthError)
      assert.equal(e.status, 401)
      assert.equal(e.code, 'unauthorized')
      assert.equal(e.message, 'Invalid, expired, or revoked API key')
      return true
    })
    script.push((req, raw, res) => (fail(res, 403, 'API key is not permitted for this operation'), true))
    await assert.rejects(client().templates.list(), (e) => e instanceof MailatAuthError && e.code === 'forbidden')
    script.push((req, raw, res) => (send(res, 400, { code: 400, message: 'bad', data: { field: 'to' } }), true))
    await assert.rejects(client().send({ to: 'a@example.com', subject: 's', text: 't' }), (e) => {
      assert.ok(e instanceof MailatValidationError)
      assert.deepEqual(e.details, { field: 'to' })
      return true
    })
    assert.equal(requests.length, 3)
  })

  test('reusing a key with different content → MailatConflictError (409)', async () => {
    const c = client()
    await c.send({ to: 'a@example.com', subject: 's', text: 'one' }, { idempotencyKey: 'same-key-123' })
    await c.send({ to: 'a@example.com', subject: 's', text: 'one' }, { idempotencyKey: 'same-key-123' })
    await assert.rejects(c.send({ to: 'a@example.com', subject: 's', text: 'two' }, { idempotencyKey: 'same-key-123' }), (e) => e instanceof MailatConflictError && e.status === 409)
    assert.equal(requests.length, 3)
  })

  test('picks up X-Request-Id when a proxy sets one; non-JSON 200 is invalid_response', async () => {
    script.push((req, raw, res) => (fail(res, 404, 'nope', { 'X-Request-Id': 'req-123' }), true))
    await assert.rejects(client().templates.get('x'), (e) => e.requestId === 'req-123')
    script.push((req, raw, res) => (res.writeHead(200, { 'Content-Type': 'text/html' }), res.end('<html>'), true))
    await assert.rejects(client().templates.list(), (e) => e instanceof MailatError && e.code === 'invalid_response' && e.status === 200)
  })

  test('non-envelope error body still produces a typed error', async () => {
    script.push((req, raw, res) => (res.writeHead(404), res.end('Not Found'), true))
    await assert.rejects(client().templates.list(), (e) => e instanceof MailatNotFoundError && /HTTP 404/.test(e.message))
  })
})

describe('retries', () => {
  test('5xx is retried up to 3 attempts with the SAME idempotency key and body', async () => {
    script.push((req, raw, res) => (fail(res, 503, 'Mail service is temporarily unavailable'), true))
    script.push((req, raw, res) => (fail(res, 502, 'bad gateway'), true))
    const res = await client().send({ to: 'a@example.com', subject: 's', text: 't' })
    assert.equal(res.id, EMAIL_ID)
    assert.equal(requests.length, 3)
    const keys = new Set(requests.map((r) => r.headers['idempotency-key']))
    assert.equal(keys.size, 1)
    assert.equal(new Set(requests.map((r) => r.raw)).size, 1)
  })

  test('gives up after 3 attempts with the last server error', async () => {
    for (let i = 0; i < 3; i++) script.push((req, raw, res) => (fail(res, 500, `boom ${i}`), true))
    await assert.rejects(client().templates.list(), (e) => e.status === 500 && e.code === 'server_error' && e.message === 'boom 2')
    assert.equal(requests.length, 3)
  })

  test('maxRetries: 0 disables retries', async () => {
    script.push((req, raw, res) => (fail(res, 503, 'down'), true))
    await assert.rejects(client({ maxRetries: 0 }).templates.list(), (e) => e.code === 'service_unavailable')
    assert.equal(requests.length, 1)
  })

  test('429 honours Retry-After', async () => {
    script.push((req, raw, res) => (fail(res, 429, 'API key request limit exceeded', { 'Retry-After': '1' }), true))
    const started = Date.now()
    await client({ retryBaseDelayMs: 0 }).send({ to: 'a@example.com', subject: 's', text: 't' }, { idempotencyKey: 'rate-limit-key' })
    assert.ok(Date.now() - started >= 950, `waited ${Date.now() - started}ms`)
    assert.equal(requests.length, 2)
    assert.equal(requests[1].headers['idempotency-key'], 'rate-limit-key')
  })

  test('429 exhausted → MailatRateLimitError with retryAfter; long Retry-After is not waited on', async () => {
    for (let i = 0; i < 3; i++) script.push((req, raw, res) => (fail(res, 429, 'slow down', { 'Retry-After': '0' }), true))
    await assert.rejects(client().templates.list(), (e) => e instanceof MailatRateLimitError && e.retryAfter === 0 && e.status === 429)
    assert.equal(requests.length, 3)

    requests = []
    script.push((req, raw, res) => (fail(res, 429, 'The monthly send quota is used up', { 'Retry-After': '3600' }), true))
    const started = Date.now()
    await assert.rejects(client().templates.list(), (e) => e instanceof MailatRateLimitError && e.retryAfter === 3600)
    assert.ok(Date.now() - started < 500)
    assert.equal(requests.length, 1)
  })

  test('network errors are retried with the same key', async () => {
    script.push((req) => (req.socket.destroy(), true))
    const res = await client().send({ to: 'a@example.com', subject: 's', text: 't' })
    assert.equal(res.id, EMAIL_ID)
    assert.equal(requests.length, 2)
    assert.equal(requests[0].headers['idempotency-key'], requests[1].headers['idempotency-key'])
  })

  test('persistent network failure → network_error', async () => {
    let calls = 0
    const fetch = async () => {
      calls++
      throw new TypeError('fetch failed')
    }
    await assert.rejects(client({ fetch }).templates.list(), (e) => e instanceof MailatError && e.code === 'network_error' && e.status === 0)
    assert.equal(calls, 3)
  })
})

describe('timeouts and abort', () => {
  test('per-attempt timeout → timeout error', async () => {
    script.push((req, raw, res) => (setTimeout(() => ok(res, []), 400), true))
    await assert.rejects(client({ timeoutMs: 50, maxRetries: 0 }).templates.list(), (e) => e.code === 'timeout')
  })

  test('a timed-out attempt is retried', async () => {
    script.push((req, raw, res) => (setTimeout(() => ok(res, []), 400), true))
    assert.deepEqual(await client({ timeoutMs: 100 }).templates.list(), [TEMPLATE])
    assert.equal(requests.length, 2)
  })

  test('user AbortSignal aborts immediately and is not retried', async () => {
    script.push((req, raw, res) => (setTimeout(() => ok(res, []), 400), true))
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 50)
    await assert.rejects(client().templates.list({ signal: ac.signal }), (e) => e.code === 'aborted')
    assert.equal(requests.length, 1)
    await assert.rejects(client().templates.list({ signal: AbortSignal.abort() }), (e) => e.code === 'aborted')
    assert.equal(requests.length, 1)
  })

  test('abort during the retry wait stops retrying', async () => {
    script.push((req, raw, res) => (fail(res, 429, 'wait', { 'Retry-After': '5' }), true))
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 100)
    const started = Date.now()
    await assert.rejects(client().templates.list({ signal: ac.signal }), (e) => e.code === 'aborted')
    assert.ok(Date.now() - started < 2000)
    assert.equal(requests.length, 1)
  })
})

describe('configuration', () => {
  test('URL normalisation', () => {
    assert.equal(normalizeUrl('https://mail.example.com'), 'https://mail.example.com/api/v1')
    assert.equal(normalizeUrl('https://mail.example.com/'), 'https://mail.example.com/api/v1')
    assert.equal(normalizeUrl('https://mail.example.com/api/v1'), 'https://mail.example.com/api/v1')
    assert.equal(normalizeUrl('https://mail.example.com/api/v1/'), 'https://mail.example.com/api/v1')
    assert.equal(normalizeUrl(' https://Mail.Example.com:8443/mailat// '), 'https://mail.example.com:8443/mailat/api/v1')
    assert.equal(normalizeUrl('http://localhost:8080'), 'http://localhost:8080/api/v1')
    assert.equal(normalizeUrl('http://127.0.0.1:3000/api/v1'), 'http://127.0.0.1:3000/api/v1')
    assert.equal(normalizeUrl('http://[::1]:3000'), 'http://[::1]:3000/api/v1')
    assert.equal(normalizeUrl('http://api.localhost'), 'http://api.localhost/api/v1')
    for (const bad of ['http://mail.example.com', 'ftp://mail.example.com', 'mail.example.com', 'https://u:p@mail.example.com', 'https://mail.example.com/?a=1', 'https://mail.example.com/#x', 'http://localhost.evil.com']) {
      assert.throws(() => normalizeUrl(bad), (e) => e instanceof MailatError && e.code === 'config_error', bad)
    }
    assert.equal(new Mailat({ url: 'https://mail.example.com/', apiKey: 'k' }).baseUrl, 'https://mail.example.com/api/v1')
  })

  test('reads MAILAT_URL / MAILAT_API_KEY / MAILAT_FROM; options win', async () => {
    const saved = { ...process.env }
    try {
      process.env.MAILAT_URL = base
      process.env.MAILAT_API_KEY = API_KEY
      process.env.MAILAT_FROM = 'Env <env@example.com>'
      const c = new Mailat({ retryBaseDelayMs: 5 })
      assert.equal(c.baseUrl, `${base}/api/v1`)
      assert.equal(c.from, 'Env <env@example.com>')
      await c.send({ to: 'a@example.com', subject: 's', text: 't' })
      assert.equal(requests[0].body.from, 'Env <env@example.com>')
      assert.equal(requests[0].headers.authorization, `Bearer ${API_KEY}`)
      assert.equal(new Mailat({ from: 'Opt <o@example.com>' }).from, 'Opt <o@example.com>')
      delete process.env.MAILAT_API_KEY
      assert.throws(() => new Mailat(), /API key is required/)
      delete process.env.MAILAT_URL
      assert.throws(() => new Mailat({ apiKey: 'k' }), /URL is required/)
    } finally {
      for (const k of ['MAILAT_URL', 'MAILAT_API_KEY', 'MAILAT_FROM']) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    }
  })

  test('refuses to run in a browser unless dangerouslyAllowBrowser', () => {
    globalThis.window = { document: {} }
    try {
      assert.throws(() => new Mailat({ url: 'https://mail.example.com', apiKey: 'k' }), /refuses to run in a browser/)
      assert.ok(new Mailat({ url: 'https://mail.example.com', apiKey: 'k', dangerouslyAllowBrowser: true }))
    } finally {
      delete globalThis.window
    }
    // A `window` without a DOM (e.g. some workers/SSR shims) is not a browser.
    globalThis.window = {}
    try {
      assert.ok(new Mailat({ url: 'https://mail.example.com', apiKey: 'k' }))
    } finally {
      delete globalThis.window
    }
  })

  test('refuses dedicated and shared browser Web Workers, but not service-worker scopes', () => {
    const opts = { url: 'https://mail.example.com', apiKey: 'k' }
    for (const name of ['DedicatedWorkerGlobalScope', 'SharedWorkerGlobalScope']) {
      globalThis[name] = function () {}
      try {
        assert.throws(() => new Mailat(opts), /refuses to run in a browser/, name)
        assert.ok(new Mailat({ ...opts, dangerouslyAllowBrowser: true }))
      } finally {
        delete globalThis[name]
      }
    }
    globalThis.ServiceWorkerGlobalScope = function () {} // Cloudflare Workers expose this
    try {
      assert.ok(new Mailat(opts))
    } finally {
      delete globalThis.ServiceWorkerGlobalScope
    }
  })

  test('User-Agent is sent on servers but not in browser mode (not in the server CORS allow-list)', async () => {
    const seen = []
    const fetch = async (input, init) => {
      seen.push(init.headers)
      return new Response(JSON.stringify({ code: 0, message: 'success', data: [] }))
    }
    await new Mailat({ url: 'https://mail.example.com', apiKey: 'k', fetch }).templates.list()
    assert.match(seen[0]['User-Agent'], /^mailat-js\//)
    globalThis.window = { document: {} }
    try {
      await new Mailat({ url: 'https://mail.example.com', apiKey: 'k', fetch, dangerouslyAllowBrowser: true }).templates.list()
    } finally {
      delete globalThis.window
    }
    assert.equal(seen[1]['User-Agent'], undefined)
    assert.deepEqual(Object.keys(seen[1]).sort(), ['Accept', 'Authorization'])
  })

  test('an API key with control or non-ASCII characters is rejected without echoing it', () => {
    for (const apiKey of ['sk_live_SECRET\u0000x', 'sk_live_SECRET\u007fx', 'sk_live_SECRET\u00e9', 'sk_live SECRET', 'sk_live_SECRET\n']) {
      assert.throws(
        () => new Mailat({ url: 'https://mail.example.com', apiKey }),
        (e) => e instanceof MailatError && e.code === 'config_error' && !String(e).includes('SECRET') && !e.message.includes('SECRET'),
      )
    }
  })

  test('network_error messages never include the raw fetch message (which may quote headers)', async () => {
    const fetch = async (input, init) => {
      throw new TypeError(`Headers.append: "${init.headers.Authorization}" is an invalid header value.`)
    }
    await assert.rejects(client({ fetch, maxRetries: 0 }).templates.list(), (e) => {
      assert.equal(e.code, 'network_error')
      assert.ok(!String(e).includes(API_KEY), String(e))
      assert.ok(!e.message.includes(API_KEY))
      assert.match(e.message, /TypeError/)
      assert.ok(e.cause instanceof TypeError) // detail still available for debugging
      return true
    })
  })

  test('invalid timeouts fall back to the default instead of aborting every attempt', async () => {
    for (const timeoutMs of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 40]) {
      assert.deepEqual(await client({ timeoutMs, maxRetries: 0 }).templates.list(), [TEMPLATE], String(timeoutMs))
      assert.deepEqual(await client({ maxRetries: 0 }).templates.list({ timeoutMs }), [TEMPLATE], `per-request ${timeoutMs}`)
    }
  })

  test('custom fetch is called as a plain function with the full URL', async () => {
    let seen
    const fetch = function (input, init) {
      seen = { self: this, input, init }
      return Promise.resolve(new Response(JSON.stringify({ code: 0, message: 'success', data: [] })))
    }
    await new Mailat({ url: 'https://mail.example.com', apiKey: 'k', fetch }).templates.list()
    assert.equal(seen.input, 'https://mail.example.com/api/v1/templates')
    assert.equal(seen.init.method, 'GET')
    assert.equal(seen.self, undefined)
  })
})
