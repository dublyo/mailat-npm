/** Options for `new Mailat()`. Every field falls back to an environment variable. */
export interface MailatOptions {
  /** Instance origin, e.g. `https://mail.example.com`. `/api/v1` is appended. Env: `MAILAT_URL`. */
  url?: string
  /** API key (`ue_...`). Env: `MAILAT_API_KEY`. */
  apiKey?: string
  /** Default sender: `support@example.com` or with a display name, `Support <support@example.com>`. Env: `MAILAT_FROM`. */
  from?: string
  /** Per-attempt timeout in milliseconds. Default 30000. */
  timeoutMs?: number
  /** Retries after the first attempt (0-2). Default 2, so at most 3 attempts. */
  maxRetries?: number
  /** Base delay for exponential backoff in milliseconds. Default 500. */
  retryBaseDelayMs?: number
  /** Custom fetch implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch
  /** Allow use in a browser page. This exposes your API key to every visitor. */
  dangerouslyAllowBrowser?: boolean
}

/** Per-call options. */
export interface RequestOptions {
  /** Abort the request (and any pending retry). */
  signal?: AbortSignal
  /** Override the client's per-attempt timeout for this call. */
  timeoutMs?: number
}

export interface SendOptions extends RequestOptions {
  /** Idempotency key (8-128 characters). Overrides `email.idempotencyKey`. */
  idempotencyKey?: string
}

export interface BatchOptions extends RequestOptions {
  /** Whole-batch idempotency key (8-128 characters). Generated when omitted. */
  idempotencyKey?: string
}

export interface Attachment {
  /** File name shown to the recipient. */
  name?: string
  /** MIME type, e.g. `application/pdf`. */
  type?: string
  /** File content: base64 string or raw bytes (encoded for you). */
  content?: string | Uint8Array | ArrayBuffer
  /** An upload already stored on the Mailat instance (instead of `content`). */
  blobId?: string
  /** `attachment` (default) or `inline`. */
  disposition?: 'attachment' | 'inline'
  /** Content-ID for inline images referenced as `cid:...` in HTML. */
  cid?: string
  size?: number
}

export interface SendEmailInput {
  to: string | string[]
  /** Required by the API. When `templateId` is set, the template's subject is used instead. */
  subject: string
  /** Defaults to the client's `from`. */
  from?: string
  cc?: string | string[]
  bcc?: string | string[]
  replyTo?: string
  html?: string
  text?: string
  /** Template UUID; the template's subject, HTML and text are rendered with `variables`. */
  templateId?: string
  variables?: Record<string, string>
  attachments?: Attachment[]
  tags?: string[]
  metadata?: Record<string, string>
  /** Future send time (Date or RFC 3339 string). */
  scheduledFor?: Date | string
  /** Idempotency key (8-128 characters). For `send` it goes in the header; in a batch it is the item key. */
  idempotencyKey?: string
}

export interface SendEmailResponse {
  id: string
  messageId: string
  status: string
  acceptedAt: string
  /** The Idempotency-Key that was sent (yours, or the one generated for you). */
  idempotencyKey: string
}

export interface BatchEmailResult {
  index: number
  id?: string
  messageId?: string
  /** `queued`/`scheduled`/... on success, `failed` for a rejected item, `unknown` when the outcome is unclear. */
  status: string
  error?: string
}

export interface BatchSendResponse {
  results: BatchEmailResult[]
  /**
   * The batch Idempotency-Key that was sent (yours, or the one generated for
   * you). Resend the same emails with this key to retry `unknown` items safely.
   */
  idempotencyKey: string
}

export interface DeliveryEvent {
  id: number
  emailId: number
  eventType: string
  timestamp: string
  details?: string
  ipAddress?: string
  userAgent?: string
}

export interface EmailStatus {
  id: string
  messageId: string
  from: string
  to: string[]
  subject: string
  status: string
  events: DeliveryEvent[]
  createdAt: string
  sentAt?: string
  deliveredAt?: string
}

export interface Template {
  id: number
  uuid: string
  orgId: number
  name: string
  description?: string
  subject: string
  htmlBody: string
  textBody?: string
  variables: string[]
  isActive: boolean
  createdAt: string
  updatedAt: string
}

/** Every event type Mailat delivers to webhooks. */
export type WebhookEventType =
  | 'email.sent'
  | 'email.delivered'
  | 'email.bounced'
  | 'email.complained'
  | 'email.failed'
  | 'email.unknown'
  | 'email.received'
  | 'contact.subscribed'
  | 'campaign.started'
  | 'campaign.paused'
  | 'campaign.cancelled'
  | 'campaign.sent'
  | 'webhook.test'
  | 'automation.webhook'

/**
 * Data of `email.*` delivery events. `from`, `to` and `subject` are present on
 * `email.sent`/`email.failed`/`email.unknown` only. Bounce and complaint events
 * carry `messageUuid` (look the recipients up with `emails.get`), or for
 * campaign mail `recipient` and `campaignUuid`.
 */
export interface EmailEventData {
  messageUuid?: string
  identityId?: number
  status?: string
  messageId?: string
  providerMessageId?: string
  from?: string
  to?: string[]
  subject?: string
  /** `email.bounced`: SES bounce type, e.g. `Permanent` or `Transient`. */
  bounceType?: string
  /** `email.complained`: feedback type reported by the mailbox provider. */
  complaintType?: string
  /** Campaign bounces/complaints: the recipient address. */
  recipient?: string
  /** Campaign bounces/complaints: the campaign UUID. */
  campaignUuid?: string
  [key: string]: unknown
}

export interface EmailReceivedData {
  messageUuid?: string
  identityId?: number
  from?: string
  to?: string[]
  subject?: string
  folder?: string
  inReplyTo?: string
  hasAttachments?: boolean
  [key: string]: unknown
}

export interface ContactSubscribedData {
  contact_id?: string
  email?: string
  list_id?: string
  form_id?: string
  confirmation_mode?: string
  [key: string]: unknown
}

export interface CampaignEventData {
  [key: string]: unknown
}

export interface WebhookTestData {
  test?: boolean
  [key: string]: unknown
}

export interface WebhookEventDataMap {
  'email.sent': EmailEventData
  'email.delivered': EmailEventData
  'email.bounced': EmailEventData
  'email.complained': EmailEventData
  'email.failed': EmailEventData
  'email.unknown': EmailEventData
  'email.received': EmailReceivedData
  'contact.subscribed': ContactSubscribedData
  'campaign.started': CampaignEventData
  'campaign.paused': CampaignEventData
  'campaign.cancelled': CampaignEventData
  'campaign.sent': CampaignEventData
  'webhook.test': WebhookTestData
  /** Sent only to an automation's own trigger target; the payload is defined by the automation. */
  'automation.webhook': Record<string, unknown>
}

/** The signed envelope Mailat posts to webhook endpoints. Narrow on `type`. */
export type WebhookEvent = {
  [K in WebhookEventType]: {
    version: string
    /** Stable event id; deduplicate on it (replays keep the same id). */
    id: string
    type: K
    createdAt: string
    data: WebhookEventDataMap[K]
  }
}[WebhookEventType]

export interface VerifyWebhookOptions {
  /** Maximum clock difference in seconds. Default 300 (same as Mailat). */
  toleranceSeconds?: number
  /** Override "now" (unix seconds or Date), mainly for tests. */
  now?: number | Date
}
