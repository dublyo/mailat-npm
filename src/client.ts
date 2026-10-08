import { randomUUID, toBase64, toBytes } from './crypto.js'
import {
  MailatAuthError,
  MailatConflictError,
  MailatError,
  MailatNotFoundError,
  MailatRateLimitError,
  MailatValidationError,
  type MailatErrorCode,
} from './errors.js'
import type {
  Attachment,
  BatchOptions,
  BatchSendResponse,
  EmailStatus,
  MailatOptions,
  RequestOptions,
  SendEmailInput,
  SendEmailResponse,
  SendOptions,
  Template,
} from './types.js'
import { webhooks } from './webhooks.js'

export const VERSION = '1.0.0'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RETRIES = 2
const DEFAULT_RETRY_BASE_MS = 500
const MAX_BACKOFF_MS = 8_000
/** A Retry-After longer than this is surfaced as an error instead of waited on. */
const MAX_RETRY_AFTER_MS = 60_000
const MAX_BATCH = 100
/** setTimeout's ceiling; larger values are clamped to 1 ms by runtimes. */
const MAX_TIMEOUT_MS = 2_147_483_647

function clampTimeout(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(Math.ceil(value), MAX_TIMEOUT_MS) : fallback
}

/**
 * True in a browser page or a dedicated/shared browser Web Worker. Service
 * worker scopes are not checked, so Cloudflare Workers keep working.
 */
function inBrowser(): boolean {
  const g = globalThis as { window?: { document?: unknown }; DedicatedWorkerGlobalScope?: unknown; SharedWorkerGlobalScope?: unknown }
  if (typeof g.window !== 'undefined' && g.window !== null && typeof g.window.document !== 'undefined') return true
  return typeof g.DedicatedWorkerGlobalScope !== 'undefined' || typeof g.SharedWorkerGlobalScope !== 'undefined'
}

function env(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  const value = proc?.env?.[name]
  return value && value.trim() ? value.trim() : undefined
}

function configError(message: string): MailatError {
  return new MailatError(message, { code: 'config_error' })
}

function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h)
}

/**
 * Normalise an instance URL to its API root: `https://x`, `https://x/` and
 * `https://x/api/v1/` all become `https://x/api/v1`. HTTPS is required except
 * for localhost.
 */
export function normalizeUrl(input: string): string {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw configError(`Invalid Mailat URL: ${input}`)
  }
  if (url.username || url.password || url.search || url.hash) {
    throw configError('Mailat URL must not contain credentials, a query string or a fragment')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(url.hostname))) {
    throw configError('Mailat URL must use https:// (http:// is only allowed for localhost)')
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/, '')
  return `${url.origin}${path}/api/v1`
}

/** Mirrors the server's rule: 8-128 characters, no CR/LF, not the reserved `mailat:` prefix. */
export function validateIdempotencyKey(key: string, label = 'idempotencyKey'): void {
  if (typeof key !== 'string' || key.length < 8 || key.length > 128 || /[\r\n]/.test(key)) {
    throw new MailatValidationError(`${label} must be 8 to 128 characters without line breaks`, { code: 'validation_error' })
  }
  if (key.toLowerCase().startsWith('mailat:')) {
    throw new MailatValidationError(`${label} must not start with the reserved "mailat:" prefix`, { code: 'validation_error' })
  }
}

function list(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined
  return Array.isArray(value) ? value : [value]
}

/** The From as given (bare address or `Name <address>`), trimmed; the server parses and checks it. */
function senderAddress(value: string | undefined): string | undefined {
  const v = value?.trim()
  return v || undefined
}

function encodeAttachment(a: Attachment): Record<string, unknown> {
  const { content, ...rest } = a
  const out: Record<string, unknown> = { ...rest }
  if (content !== undefined) out.content = typeof content === 'string' ? content : toBase64(toBytes(content))
  return out
}

function formatSchedule(value: Date | string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new MailatValidationError('scheduledFor is an invalid Date', { code: 'validation_error' })
    return value.toISOString().replace(/\.\d{3}Z$/, 'Z')
  }
  return value
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError(signal!))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** A safe suffix naming the error class/code, never its message. */
function errName(err: unknown): string {
  const e = err as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | null
  const code = typeof e?.cause?.code === 'string' ? e.cause.code : typeof e?.code === 'string' ? e.code : undefined
  const name = typeof e?.name === 'string' ? e.name : undefined
  const parts = [name, code].filter((x): x is string => !!x && /^[\w.-]{1,64}$/.test(x))
  return parts.length ? ` (${parts.join(', ')})` : ''
}

function abortError(signal: AbortSignal): MailatError {
  return new MailatError('Request aborted', { code: 'aborted', cause: signal.reason })
}

/** Seconds from a Retry-After header (delta-seconds or HTTP date). */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  const date = Date.parse(trimmed)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, Math.ceil((date - Date.now()) / 1000))
}

interface Envelope {
  code?: number
  message?: string
  data?: unknown
}

function errorFor(status: number, message: string, requestId: string | undefined, details: unknown, retryAfter?: number): MailatError {
  const init = { status, requestId, details }
  if (status === 400 || status === 422) return new MailatValidationError(message, { ...init, code: 'validation_error' })
  if (status === 401) return new MailatAuthError(message, { ...init, code: 'unauthorized' })
  if (status === 403) return new MailatAuthError(message, { ...init, code: 'forbidden' })
  if (status === 404) return new MailatNotFoundError(message, { ...init, code: 'not_found' })
  if (status === 409) return new MailatConflictError(message, { ...init, code: 'conflict' })
  if (status === 429) return new MailatRateLimitError(message, { ...init, code: 'rate_limited', retryAfter })
  const code: MailatErrorCode = status === 503 ? 'service_unavailable' : status >= 500 ? 'server_error' : 'http_error'
  return new MailatError(message, { ...init, code })
}

interface InternalRequest {
  method: 'GET' | 'POST' | 'DELETE'
  path: string
  body?: unknown
  headers?: Record<string, string>
  options?: RequestOptions
}

export class Mailat {
  /** Webhook helpers; usable without a client: `await Mailat.webhooks.verify(...)`. */
  static readonly webhooks = webhooks
  readonly webhooks = webhooks

  /** The normalised API root, e.g. `https://mail.example.com/api/v1`. */
  readonly baseUrl: string
  /** Default sender used when an email has no `from`. */
  readonly from: string | undefined

  readonly emails: {
    /** `GET /emails/:id` (scope `email:read`). */
    get: (id: string, options?: RequestOptions) => Promise<EmailStatus>
    /** `DELETE /emails/:id` cancels a scheduled email (scope `email:manage`). */
    cancel: (id: string, options?: RequestOptions) => Promise<void>
  }

  readonly templates: {
    /** `GET /templates` (scope `templates:read`). */
    list: (options?: RequestOptions) => Promise<Template[]>
    /** `GET /templates/:uuid` (scope `templates:read`). */
    get: (uuid: string, options?: RequestOptions) => Promise<Template>
  }

  readonly #apiKey: string
  readonly #timeoutMs: number
  readonly #maxRetries: number
  readonly #retryBaseMs: number
  readonly #fetch: typeof fetch
  readonly #sendUserAgent: boolean

  constructor(options: MailatOptions = {}) {
    const browser = inBrowser()
    if (!options.dangerouslyAllowBrowser) {
      if (browser) {
        throw configError(
          'Mailat refuses to run in a browser because it would expose your API key. Call it from your server, or pass dangerouslyAllowBrowser: true if you understand the risk.',
        )
      }
    }
    const url = options.url ?? env('MAILAT_URL')
    const apiKey = options.apiKey ?? env('MAILAT_API_KEY')
    if (!url) throw configError('Mailat URL is required (pass `url` or set MAILAT_URL)')
    if (!apiKey) throw configError('Mailat API key is required (pass `apiKey` or set MAILAT_API_KEY)')
    // Printable ASCII only: anything else would make fetch throw an error whose
    // message echoes the whole Authorization header (and so the key).
    if (!/^[\x21-\x7e]+$/.test(apiKey)) throw configError('Mailat API key contains invalid characters (whitespace, control or non-ASCII)')
    this.baseUrl = normalizeUrl(url)
    this.#apiKey = apiKey
    this.from = options.from ?? env('MAILAT_FROM')
    this.#timeoutMs = clampTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS)
    // The server's CORS allow-list has no User-Agent, so a browser that honours
    // a script-set User-Agent (Firefox) would fail the preflight.
    this.#sendUserAgent = !browser
    this.#maxRetries = Math.max(0, Math.min(DEFAULT_MAX_RETRIES, Math.floor(options.maxRetries ?? DEFAULT_MAX_RETRIES)))
    this.#retryBaseMs = Math.max(0, options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_MS)
    const f = options.fetch ?? (globalThis.fetch as typeof fetch | undefined)
    if (typeof f !== 'function') throw configError('No fetch implementation available; pass `fetch` in the options')
    // Never call fetch as a method of this object (Workers/browsers throw "Illegal invocation").
    const custom = options.fetch
    this.#fetch = custom ? (input, init) => custom(input, init) : (input, init) => globalThis.fetch(input, init)

    this.emails = {
      get: (id, opts) => this.#request<EmailStatus>({ method: 'GET', path: `/emails/${encodeURIComponent(id)}`, options: opts }),
      cancel: async (id, opts) => {
        await this.#request<unknown>({ method: 'DELETE', path: `/emails/${encodeURIComponent(id)}`, options: opts })
      },
    }
    this.templates = {
      list: async (opts) => (await this.#request<Template[] | null>({ method: 'GET', path: '/templates', options: opts })) ?? [],
      get: (uuid, opts) => this.#request<Template>({ method: 'GET', path: `/templates/${encodeURIComponent(uuid)}`, options: opts }),
    }
  }

  /**
   * Send one email (`POST /emails`, scope `email:send`). An `Idempotency-Key`
   * is always sent (generated when you don't pass one) and reused across
   * retries, so a retried request never sends twice. The key used is returned
   * as `idempotencyKey`.
   */
  async send(email: SendEmailInput, options: SendOptions = {}): Promise<SendEmailResponse> {
    const key = options.idempotencyKey ?? email.idempotencyKey ?? (await randomUUID())
    validateIdempotencyKey(key)
    const body = this.#buildEmail(email, 'email')
    delete body.idempotencyKey // carried by the header; body and header must not disagree
    const res = await this.#request<Omit<SendEmailResponse, 'idempotencyKey'>>({ method: 'POST', path: '/emails', body, headers: { 'Idempotency-Key': key }, options })
    return { ...res, idempotencyKey: key }
  }

  /**
   * Send up to 100 emails in one call (`POST /emails/batch`). Each item gets
   * its own result; check `results[i].status` (`failed` items were rejected,
   * `unknown` items may be retried by resending the same batch with the
   * returned `idempotencyKey`).
   */
  async sendBatch(emails: SendEmailInput[], options: BatchOptions = {}): Promise<BatchSendResponse> {
    if (!Array.isArray(emails) || emails.length === 0 || emails.length > MAX_BATCH) {
      throw new MailatValidationError(`A batch must contain between 1 and ${MAX_BATCH} emails`, { code: 'validation_error' })
    }
    const key = options.idempotencyKey ?? (await randomUUID())
    validateIdempotencyKey(key)
    const items = emails.map((e, i) => {
      const item = this.#buildEmail(e, `emails[${i}]`)
      if (item.idempotencyKey !== undefined) validateIdempotencyKey(item.idempotencyKey as string, `emails[${i}].idempotencyKey`)
      return item
    })
    const res = await this.#request<{ results?: BatchSendResponse['results'] } | null>({
      method: 'POST',
      path: '/emails/batch',
      body: { emails: items },
      headers: { 'Idempotency-Key': key },
      options,
    })
    return { results: res?.results ?? [], idempotencyKey: key }
  }

  #buildEmail(email: SendEmailInput, label: string): Record<string, unknown> {
    if (!email || typeof email !== 'object') throw new MailatValidationError(`${label} must be an object`, { code: 'validation_error' })
    const from = senderAddress(email.from ?? this.from)
    if (!from) throw new MailatValidationError(`${label}: from is required (pass it or set a default from / MAILAT_FROM)`, { code: 'validation_error' })
    if (/[\r\n]/.test(from)) throw new MailatValidationError(`${label}: from contains a line break`, { code: 'validation_error' })
    if (!email.subject) throw new MailatValidationError(`${label}: subject is required`, { code: 'validation_error' })
    const to = list(email.to) ?? []
    const cc = list(email.cc)
    const bcc = list(email.bcc)
    if (to.length + (cc?.length ?? 0) + (bcc?.length ?? 0) === 0) {
      throw new MailatValidationError(`${label}: at least one recipient is required`, { code: 'validation_error' })
    }
    if (!email.html && !email.text && !email.templateId && !email.attachments?.length) {
      throw new MailatValidationError(`${label}: html, text, templateId or an attachment is required`, { code: 'validation_error' })
    }
    const out: Record<string, unknown> = {
      from,
      to,
      cc,
      bcc,
      replyTo: email.replyTo,
      subject: email.subject,
      html: email.html,
      text: email.text,
      templateId: email.templateId,
      variables: email.variables,
      attachments: email.attachments?.map(encodeAttachment),
      tags: email.tags,
      metadata: email.metadata,
      scheduledFor: email.scheduledFor === undefined ? undefined : formatSchedule(email.scheduledFor),
      idempotencyKey: email.idempotencyKey,
    }
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k]
    return out
  }

  async #request<T>(req: InternalRequest): Promise<T> {
    const userSignal = req.options?.signal
    const timeoutMs = clampTimeout(req.options?.timeoutMs, this.#timeoutMs)
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      Accept: 'application/json',
      ...req.headers,
    }
    if (this.#sendUserAgent) headers['User-Agent'] = `mailat-js/${VERSION}`
    let payload: string | undefined
    if (req.body !== undefined) {
      payload = JSON.stringify(req.body)
      headers['Content-Type'] = 'application/json'
    }
    const url = this.baseUrl + req.path

    for (let attempt = 0; ; attempt++) {
      if (userSignal?.aborted) throw abortError(userSignal)
      const canRetry = attempt < this.#maxRetries
      const controller = new AbortController()
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)
      const onAbort = () => controller.abort()
      userSignal?.addEventListener('abort', onAbort, { once: true })

      let response: Response
      let text: string
      try {
        response = await this.#fetch(url, { method: req.method, headers, body: payload, signal: controller.signal })
        text = await response.text()
      } catch (err) {
        if (userSignal?.aborted) throw abortError(userSignal)
        // The raw fetch message is kept only in `cause`: some runtimes quote
        // header values (including Authorization) in it.
        const error = timedOut
          ? new MailatError(`Request timed out after ${timeoutMs}ms`, { code: 'timeout', cause: err })
          : new MailatError(`Network error while calling Mailat${errName(err)}`, { code: 'network_error', cause: err })
        if (!canRetry) throw error
        await sleep(this.#backoff(attempt), userSignal)
        continue
      } finally {
        clearTimeout(timer)
        userSignal?.removeEventListener('abort', onAbort)
      }

      const requestId = response.headers.get('x-request-id') ?? undefined
      let envelope: Envelope | undefined
      if (text) {
        try {
          envelope = JSON.parse(text) as Envelope
        } catch {
          envelope = undefined
        }
      }

      if (response.ok) {
        if (!envelope || typeof envelope !== 'object') {
          throw new MailatError('Mailat returned a non-JSON response', { status: response.status, code: 'invalid_response', requestId, details: text.slice(0, 500) })
        }
        if (typeof envelope.code === 'number' && envelope.code !== 0) {
          throw errorFor(envelope.code >= 400 ? envelope.code : response.status, envelope.message || 'Request failed', requestId, envelope.data)
        }
        return envelope.data as T
      }

      const status = response.status
      const message = envelope?.message || `Mailat request failed with HTTP ${status}`
      const retryAfter = status === 429 ? parseRetryAfter(response.headers.get('retry-after')) : undefined
      const error = errorFor(status, message, requestId, envelope?.data, retryAfter)
      const retryable = status === 429 || status >= 500
      if (!retryable || !canRetry) throw error
      let delay = this.#backoff(attempt)
      if (status === 429 && retryAfter !== undefined) {
        if (retryAfter * 1000 > MAX_RETRY_AFTER_MS) throw error
        delay = retryAfter * 1000
      }
      await sleep(delay, userSignal)
    }
  }

  /** Exponential backoff with jitter: 50-100% of base * 2^attempt, capped. */
  #backoff(attempt: number): number {
    const exp = Math.min(MAX_BACKOFF_MS, this.#retryBaseMs * 2 ** attempt)
    return Math.round(exp / 2 + Math.random() * (exp / 2))
  }
}
