# Changelog

All notable changes to this project are documented here. The npm package and
the Go module share version numbers (`v1.0.0` for npm, `go/v1.0.0` for Go).

## 1.0.1 - 2026-10-08

- Package page links to [mailat.co](https://mailat.co): homepage, description and an "About Mailat" note in the README. No code changes.

## 1.0.0 - 2026-10-08

First release.

### JavaScript (`@dublyo/mailat`)

- `new Mailat({ url, apiKey, from })`, or `new Mailat()` reading `MAILAT_URL`, `MAILAT_API_KEY` and `MAILAT_FROM`.
- `send` and `sendBatch` (1 to 100 emails, results per item), both returning the `idempotencyKey` they used, with attachments (bytes, base64 or `blobId`), templates (`templateId` + `variables`), tags, metadata and scheduled sends.
- `emails.get` (status and delivery events) and `emails.cancel` (scheduled emails).
- `templates.list` and `templates.get`.
- An `Idempotency-Key` on every send (generated when not given). Retries on network errors, timeouts, 5xx and 429 (honours `Retry-After`), at most 3 attempts with the same key.
- Typed errors: `MailatError`, `MailatAuthError`, `MailatValidationError`, `MailatNotFoundError`, `MailatConflictError`, `MailatRateLimitError`, `MailatWebhookVerificationError`.
- `Mailat.webhooks.verify` / `verifyWebhook`: HMAC-SHA256 with Web Crypto, constant-time compare, timestamp tolerance, typed events. `signWebhook` for tests.
- `from` accepts a display name (`Name <addr>`), sent as given (needs Mailat `89a348b` or later).
- Refuses to run in a browser page or browser Web Worker unless `dangerouslyAllowBrowser: true`; no `User-Agent` header in browser mode (not in Mailat's CORS allow-list).
- API keys with control/non-ASCII characters are rejected without being echoed; network errors never copy the runtime's message (which can quote headers) into `message`.
- ESM + CommonJS + types, zero runtime dependencies, Node.js 18+, edge runtimes, Bun and Deno.

### Go (`github.com/dublyo/mailat-npm/go`)

- `New` / `NewFromEnv`, `Send`, `SendBatch`, `GetEmail`, `CancelEmail`, `ListTemplates`, `GetTemplate`, `VerifyWebhook`, `SignWebhook`.
- Same idempotency, retry and error rules as the JavaScript client (except `MaxRetries: 0` means the default; use `-1` to disable). Local build/decode failures are not retried. Redirects are never followed, so the key cannot be forwarded. Attachments by `BlobID`. Standard library only, Go 1.22+.
