import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { Mailat, verifyWebhook, signWebhook, MailatWebhookVerificationError, MailatError } from '../dist/index.js'

// Independent reference implementation (node:crypto), same algorithm as
// Mailat's Go eventoutbox.Sign: HMAC-SHA256(secret, "<t>." + rawBody).
function refSign(body, secret, t) {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.`).update(body).digest('hex')}`
}

// Produced by running Mailat's eventoutbox.Sign (copied verbatim) under Go.
const GO_VECTORS = [
  {
    body: '{"version":"1","id":"8a1f3c2e-0000-4000-8000-000000000001","type":"email.delivered","createdAt":"2026-10-08T10:00:00Z","data":{"messageUuid":"b7c1e0d2-0000-4000-8000-000000000002","status":"delivered"}}',
    secret: 'whsec_test_secret',
    t: 1791367200,
    signature: 't=1791367200,v1=e2f9526173bdf6f67744b244a7d8d9e0399581755066281071884f5c49a37b8a',
  },
  {
    body: '{"version":"1","id":"evt-2","type":"contact.subscribed","createdAt":"2026-10-08T10:00:00Z","data":{"email":"café@example.com"}}',
    secret: 's3cr3t-with-unicode-ü',
    t: 1700000000,
    signature: 't=1700000000,v1=a8bc1a97ffe09e68f7b88997b86371ded2a9d5347aed779d5ca887c5129aefcd',
  },
  { body: '', secret: 'k', t: 1, signature: 't=1,v1=37c39ff90c9eaf98b76f1cf1a38399fa408e930f34e04a5179d0dc6489fe9c78' },
]

const SECRET = 'whsec_unit_test'
const NOW = 1791367200
const EVENT = {
  version: '1',
  id: '3f1c0a9e-1111-4000-8000-0000000000aa',
  type: 'email.bounced',
  createdAt: '2026-10-08T10:00:00Z',
  data: { messageUuid: 'b7c1e0d2-0000-4000-8000-000000000002', status: 'bounced', to: ['x@example.com'] },
}
const BODY = JSON.stringify(EVENT)

async function rejects(promise, pattern) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof MailatWebhookVerificationError, `expected verification error, got ${err}`)
    assert.ok(err instanceof MailatError)
    assert.equal(err.code, 'webhook_verification_failed')
    if (pattern) assert.match(err.message, pattern)
    return true
  })
}

test('Go reference vectors match both signWebhook and node:crypto', async () => {
  for (const v of GO_VECTORS) {
    assert.equal(refSign(v.body, v.secret, v.t), v.signature)
    assert.equal(await signWebhook(v.body, v.secret, v.t), v.signature)
  }
})

test('verifies Go-signed vectors that are valid JSON events', async () => {
  for (const v of GO_VECTORS.slice(0, 2)) {
    const event = await verifyWebhook(v.body, v.signature, v.secret, { now: v.t + 10 })
    assert.deepEqual(event, JSON.parse(v.body))
  }
})

test('returns the typed event for a valid signature (string, Uint8Array, ArrayBuffer bodies)', async () => {
  const sig = refSign(BODY, SECRET, NOW)
  const bytes = new TextEncoder().encode(BODY)
  for (const body of [BODY, bytes, bytes.buffer.slice(0)]) {
    const event = await verifyWebhook(body, sig, SECRET, { now: NOW })
    assert.equal(event.type, 'email.bounced')
    assert.equal(event.id, EVENT.id)
    assert.deepEqual(event.data, EVENT.data)
  }
})

test('Mailat.webhooks.verify, instance webhooks.verify and verifyWebhook are the same', async () => {
  const sig = refSign(BODY, SECRET, NOW)
  const client = new Mailat({ url: 'https://mail.example.com', apiKey: 'ue_test' })
  assert.equal(Mailat.webhooks.verify, verifyWebhook)
  assert.equal(client.webhooks.verify, verifyWebhook)
  assert.equal(Mailat.webhooks.signatureHeader, 'X-Webhook-Signature')
  const event = await Mailat.webhooks.verify(BODY, sig, SECRET, { now: new Date(NOW * 1000) })
  assert.equal(event.id, EVENT.id)
})

test('rejects a tampered body, wrong secret and a re-serialised body', async () => {
  const sig = refSign(BODY, SECRET, NOW)
  await rejects(verifyWebhook(BODY.replace('bounced', 'delivered'), sig, SECRET, { now: NOW }), /does not match/)
  await rejects(verifyWebhook(BODY, sig, SECRET + 'x', { now: NOW }), /does not match/)
  await rejects(verifyWebhook(JSON.stringify(EVENT, null, 2), sig, SECRET, { now: NOW }), /does not match/)
})

test('enforces the timestamp tolerance (default 300s, inclusive) in both directions', async () => {
  const sig = refSign(BODY, SECRET, NOW)
  assert.ok(await verifyWebhook(BODY, sig, SECRET, { now: NOW + 300 }))
  assert.ok(await verifyWebhook(BODY, sig, SECRET, { now: NOW - 300 }))
  await rejects(verifyWebhook(BODY, sig, SECRET, { now: NOW + 301 }), /tolerance/)
  await rejects(verifyWebhook(BODY, sig, SECRET, { now: NOW - 301 }), /tolerance/)
  await rejects(verifyWebhook(BODY, sig, SECRET, { now: NOW + 31, toleranceSeconds: 30 }), /tolerance/)
  assert.ok(await verifyWebhook(BODY, sig, SECRET, { now: NOW + 3000, toleranceSeconds: 3600 }))
  // Non-positive tolerance falls back to the default, like the Go server.
  assert.ok(await verifyWebhook(BODY, sig, SECRET, { now: NOW + 200, toleranceSeconds: 0 }))
})

test('uses the real clock by default', async () => {
  const now = Math.floor(Date.now() / 1000)
  assert.ok(await verifyWebhook(BODY, refSign(BODY, SECRET, now), SECRET))
  await rejects(verifyWebhook(BODY, refSign(BODY, SECRET, now - 3600), SECRET), /tolerance/)
})

test('rejects malformed signature headers exactly like the Go verifier', async () => {
  const digest = refSign(BODY, SECRET, NOW).split(',v1=')[1]
  const bad = [
    '',
    'garbage',
    `v1=${digest}`, // no timestamp
    `t=${NOW}`, // no digest
    `t=${NOW},t=${NOW},v1=${digest}`, // duplicate t
    `t=${NOW},v1=${digest},v1=${digest}`, // duplicate v1
    `t=${NOW},v1=${digest},v0=abc`, // unknown key
    `t=0${NOW},v1=${digest}`, // non-canonical timestamp
    `t=+${NOW},v1=${digest}`,
    `t=0,v1=${digest}`,
    `t=${NOW},v1=${digest.slice(1)}`, // wrong length
    `t=${NOW},v1=${digest.toUpperCase()}`, // Go compares lowercase hex exactly
  ]
  for (const header of bad) {
    await rejects(verifyWebhook(BODY, header, SECRET, { now: NOW }))
  }
  // Order and surrounding whitespace do not matter.
  assert.ok(await verifyWebhook(BODY, ` v1=${digest} , t=${NOW} `, SECRET, { now: NOW }))
})

test('rejects missing header, missing secret and parsed (non-raw) bodies', async () => {
  const sig = refSign(BODY, SECRET, NOW)
  await rejects(verifyWebhook(BODY, null, SECRET, { now: NOW }), /Missing/)
  await rejects(verifyWebhook(BODY, undefined, SECRET, { now: NOW }), /Missing/)
  await rejects(verifyWebhook(BODY, sig, '', { now: NOW }), /secret/)
  await rejects(verifyWebhook(EVENT, sig, SECRET, { now: NOW }), /Raw body/)
})

test('never parses the payload before verifying; rejects signed non-events', async () => {
  const notJson = 'not json'
  await rejects(verifyWebhook(notJson, refSign(notJson, SECRET, NOW), SECRET, { now: NOW }), /not valid JSON/)
  const notEvent = '{"hello":"world"}'
  await rejects(verifyWebhook(notEvent, refSign(notEvent, SECRET, NOW), SECRET, { now: NOW }), /envelope/)
  // An invalid signature on invalid JSON reports the signature, not the JSON.
  await rejects(verifyWebhook(notJson, refSign('other', SECRET, NOW), SECRET, { now: NOW }), /does not match/)
})
