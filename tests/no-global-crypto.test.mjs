// Node 18 has no global `crypto`; the package must fall back to node:crypto.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'

Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true })
const { Mailat, verifyWebhook } = await import('../dist/index.js')

test('webhook verification and key generation work without globalThis.crypto', async () => {
  assert.equal(globalThis.crypto, undefined)
  const body = '{"version":"1","id":"e1","type":"email.sent","createdAt":"2026-10-08T10:00:00Z","data":{}}'
  const t = Math.floor(Date.now() / 1000)
  const sig = `t=${t},v1=${createHmac('sha256', 'sec').update(`${t}.${body}`).digest('hex')}`
  assert.equal((await verifyWebhook(body, sig, 'sec')).id, 'e1')

  let key
  const fetch = async (_url, init) => {
    key = init.headers['Idempotency-Key']
    return new Response(JSON.stringify({ code: 0, message: 'Email queued', data: { id: 'x' } }))
  }
  await new Mailat({ url: 'https://mail.example.com', apiKey: 'ue_k', from: 'a@example.com', fetch }).send({ to: 'b@example.com', subject: 's', text: 't' })
  assert.match(key, /^[0-9a-f-]{36}$/)
})
