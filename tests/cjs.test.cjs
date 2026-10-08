// The CommonJS build exposes the same API as the ESM build.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHmac } = require('node:crypto')
const pkg = require('../dist/index.cjs')

test('CJS build exports the public API', async () => {
  for (const name of ['Mailat', 'MailatError', 'MailatAuthError', 'MailatValidationError', 'MailatRateLimitError', 'MailatNotFoundError', 'MailatConflictError', 'verifyWebhook', 'normalizeUrl']) {
    assert.ok(pkg[name], `missing export ${name}`)
  }
  const c = new pkg.Mailat({ url: 'https://mail.example.com', apiKey: 'ue_k' })
  assert.equal(c.baseUrl, 'https://mail.example.com/api/v1')

  const body = '{"version":"1","id":"e1","type":"email.sent","createdAt":"2026-10-08T10:00:00Z","data":{}}'
  const t = Math.floor(Date.now() / 1000)
  const sig = `t=${t},v1=${createHmac('sha256', 'sec').update(`${t}.${body}`).digest('hex')}`
  const event = await pkg.Mailat.webhooks.verify(body, sig, 'sec')
  assert.equal(event.type, 'email.sent')
})
