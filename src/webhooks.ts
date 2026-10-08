import { getCrypto, timingSafeEqual, toBytes, toHex } from './crypto.js'
import { MailatWebhookVerificationError } from './errors.js'
import type { VerifyWebhookOptions, WebhookEvent } from './types.js'

const DEFAULT_TOLERANCE_SECONDS = 300

/** Header names Mailat sets on every webhook delivery. */
export const WEBHOOK_SIGNATURE_HEADER = 'X-Webhook-Signature'
export const WEBHOOK_ID_HEADER = 'X-Webhook-ID'

function parseSignature(header: string): { stamp: string; digest: string } | null {
  // Mirrors eventoutbox.Verify: only `t` and `v1`, each exactly once.
  let stamp = ''
  let digest = ''
  const seen = new Set<string>()
  for (const part of header.split(',')) {
    const trimmed = part.trim()
    const eq = trimmed.indexOf('=')
    if (eq < 0) return null
    const key = trimmed.slice(0, eq)
    const value = trimmed.slice(eq + 1)
    if (seen.has(key)) return null
    seen.add(key)
    if (key === 't') stamp = value
    else if (key === 'v1') digest = value
    else return null
  }
  return { stamp, digest }
}

async function hmacHex(secret: string, message: Uint8Array): Promise<string> {
  const c = await getCrypto()
  const key = await c.subtle.importKey('raw', toBytes(secret) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return toHex(await c.subtle.sign('HMAC', key, message as BufferSource))
}

/** Compute a Mailat signature header (`t=<unix>,v1=<hex>`). Useful for tests. */
export async function signWebhook(rawBody: string | Uint8Array | ArrayBuffer, secret: string, timestamp: number): Promise<string> {
  const stamp = String(Math.floor(timestamp))
  return `t=${stamp},v1=${await hmacHex(secret, concat(toBytes(stamp + '.'), toBytes(rawBody)))}`
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

/**
 * Verify a Mailat webhook and return the parsed event.
 *
 * Pass the exact raw request body (before any JSON parsing), the
 * `X-Webhook-Signature` header and the webhook secret. Throws
 * `MailatWebhookVerificationError` on any mismatch; the payload is parsed only
 * after the signature checks out.
 */
export async function verifyWebhook(
  rawBody: string | Uint8Array | ArrayBuffer,
  signatureHeader: string | null | undefined,
  secret: string,
  options: VerifyWebhookOptions = {},
): Promise<WebhookEvent> {
  if (!secret) throw new MailatWebhookVerificationError('Webhook secret is required')
  if (!signatureHeader) throw new MailatWebhookVerificationError('Missing X-Webhook-Signature header')
  if (typeof rawBody !== 'string' && !(rawBody instanceof Uint8Array) && !(rawBody instanceof ArrayBuffer)) {
    throw new MailatWebhookVerificationError('Raw body must be a string, Uint8Array or ArrayBuffer (do not pass parsed JSON)')
  }
  const parsed = parseSignature(signatureHeader)
  if (!parsed) throw new MailatWebhookVerificationError('Malformed signature header')
  const { stamp, digest } = parsed
  const timestamp = /^[0-9]+$/.test(stamp) ? Number(stamp) : NaN
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || String(timestamp) !== stamp || digest.length !== 64) {
    throw new MailatWebhookVerificationError('Malformed signature header')
  }
  let tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS
  if (!(tolerance > 0)) tolerance = DEFAULT_TOLERANCE_SECONDS
  const now = options.now instanceof Date ? options.now.getTime() / 1000 : options.now ?? Date.now() / 1000
  if (Math.abs(now - timestamp) > tolerance) {
    throw new MailatWebhookVerificationError('Webhook timestamp is outside the allowed tolerance')
  }
  const expected = await hmacHex(secret, concat(toBytes(stamp + '.'), toBytes(rawBody)))
  if (!timingSafeEqual(expected, digest)) throw new MailatWebhookVerificationError('Webhook signature does not match')

  let event: unknown
  try {
    event = JSON.parse(typeof rawBody === 'string' ? rawBody : new TextDecoder().decode(toBytes(rawBody)))
  } catch {
    throw new MailatWebhookVerificationError('Webhook body is not valid JSON')
  }
  const e = event as Partial<WebhookEvent> | null
  if (!e || typeof e !== 'object' || typeof e.id !== 'string' || typeof e.type !== 'string' || typeof e.data !== 'object' || e.data === null) {
    throw new MailatWebhookVerificationError('Webhook body is not a Mailat event envelope')
  }
  return event as WebhookEvent
}

/** Namespace exposed as `Mailat.webhooks` and `mailat.webhooks`. */
export const webhooks = {
  verify: verifyWebhook,
  sign: signWebhook,
  signatureHeader: WEBHOOK_SIGNATURE_HEADER,
  idHeader: WEBHOOK_ID_HEADER,
} as const
