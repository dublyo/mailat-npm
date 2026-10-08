export type MailatErrorCode =
  | 'validation_error'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'server_error'
  | 'service_unavailable'
  | 'http_error'
  | 'network_error'
  | 'timeout'
  | 'aborted'
  | 'invalid_response'
  | 'config_error'
  | 'webhook_verification_failed'

export interface MailatErrorInit {
  status?: number
  code: MailatErrorCode
  requestId?: string
  /** Extra data from the API error envelope, if any (e.g. field errors). */
  details?: unknown
  cause?: unknown
}

/** Base class for every error this package throws. */
export class MailatError extends Error {
  /** HTTP status, or 0 when no response was received. */
  readonly status: number
  readonly code: MailatErrorCode
  readonly requestId?: string
  readonly details?: unknown

  constructor(message: string, init: MailatErrorInit) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause })
    this.name = new.target.name
    this.status = init.status ?? 0
    this.code = init.code
    if (init.requestId !== undefined) this.requestId = init.requestId
    if (init.details !== undefined) this.details = init.details
  }
}

/**
 * 401 (bad/expired/revoked key) or 403 (key lacks the scope, or the key owner
 * is a mailbox account). Rejected senders are 400 MailatValidationError.
 */
export class MailatAuthError extends MailatError {}

/** 400/422: the request was rejected; fix it before retrying. */
export class MailatValidationError extends MailatError {}

/** 404: the email or template does not exist (or is not visible to this key). */
export class MailatNotFoundError extends MailatError {}

/** 409: the idempotency key was already used with different content. */
export class MailatConflictError extends MailatError {}

/** 429: rate limit or quota hit. `retryAfter` is in seconds when the server sent it. */
export class MailatRateLimitError extends MailatError {
  readonly retryAfter?: number
  constructor(message: string, init: MailatErrorInit & { retryAfter?: number }) {
    super(message, init)
    if (init.retryAfter !== undefined) this.retryAfter = init.retryAfter
  }
}

/** The webhook signature, timestamp or payload failed verification. */
export class MailatWebhookVerificationError extends MailatError {
  constructor(message: string) {
    super(message, { code: 'webhook_verification_failed' })
  }
}
