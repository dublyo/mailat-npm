# mailat (Go)

A small Go client for sending email through a self-hosted [Mailat](https://mailat.co) instance. It uses only the standard library and needs Go 1.22 or newer.

Mailat is a free, open-source (MIT) email platform built on Amazon SES. Product, docs and managed hosting: [mailat.co](https://mailat.co). Source: [github.com/dublyo/mailat](https://github.com/dublyo/mailat).

```sh
go get github.com/dublyo/mailat-npm/go
```

```go
import mailat "github.com/dublyo/mailat-npm/go"
```

## Setup

```go
client, err := mailat.New(mailat.Config{
	URL:    "https://mail.example.com",   // instance origin; "/api/v1" is appended
	APIKey: os.Getenv("MAILAT_API_KEY"),
	From:   "support@example.com",         // default sender
})
```

Or read `MAILAT_URL`, `MAILAT_API_KEY` and `MAILAT_FROM` from the environment:

```go
client, err := mailat.NewFromEnv()
```

| Config field | Default | Notes |
|---|---|---|
| `URL` | required | HTTPS is required. Plain `http` works only for localhost. A URL that already ends in `/api/v1` is accepted. |
| `APIKey` | required | Sent as `Authorization: Bearer <key>`. |
| `From` | empty | Used when `Email.From` is empty. |
| `HTTPClient` | `&http.Client{}` | Bring your own transport or proxy. The client uses a copy with redirects turned off, so the API key is never forwarded to another scheme or host; a 3xx comes back as `*mailat.Error`. |
| `Timeout` | 30s | Applies to each HTTP attempt. Use the `ctx` you pass in to limit the whole call, retries included. |
| `MaxRetries` | 2 (3 attempts in total) | `0` means the default (2). Use `-1` (any negative value) to turn retries off. This differs from the JS client, where `maxRetries: 0` disables retries. |

### API key scopes

| Method | Endpoint | Scope |
|---|---|---|
| `Send` | `POST /api/v1/emails` | `email:send` |
| `SendBatch` | `POST /api/v1/emails/batch` | `email:send` |
| `GetEmail` | `GET /api/v1/emails/:id` | `email:read` |
| `CancelEmail` | `DELETE /api/v1/emails/:id` | `email:manage` |
| `ListTemplates`, `GetTemplate` | `GET /api/v1/templates[/:uuid]` | `templates:read` |

An API key acts as its owner. An owner or admin may send from any free address on the organization's verified domains. That excludes another user's mailbox, its `+tag` variants and its aliases. The owner also needs at least one identity of their own on that domain.

## Sending

```go
res, err := client.Send(ctx, mailat.Email{
	To:      []string{"user@example.org"},
	Subject: "Welcome",
	HTML:    "<p>Hello!</p>",
	Text:    "Hello!",
	// Optional: Cc, Bcc, ReplyTo, Attachments, Tags, Metadata, ScheduledFor,
	// TemplateID + Variables, From, IdempotencyKey
})
fmt.Println(res.ID, res.Status) // "queued"
```

Template send: set `TemplateID` (the template UUID) and `Variables`. The server requires `Subject` even when you use a template.

Attachments carry base64 `Content`, or a `BlobID` that references an upload already stored on the Mailat instance (set one, not both):

```go
Attachments: []mailat.Attachment{
	{Name: "invoice.pdf", Type: "application/pdf", Content: base64.StdEncoding.EncodeToString(pdf)},
	{BlobID: "0b6f1d3e-8a2c-4c55-9f1e-2d7b9a4c1e00"},
}
```

`From` may be a bare address or `"Support <support@example.com>"`; the display name is sent as given. Requires a Mailat server from October 2026 or later (commit `89a348b`); older servers accept a bare address only.

### Batch

```go
out, err := client.SendBatch(ctx, []mailat.Email{e1, e2}, &mailat.BatchOptions{IdempotencyKey: "newsletter-2026-10-08"})
for _, r := range out.Results {
	if r.Status == "failed" { log.Println(r.Index, r.Error) }
}
```

A batch holds 1 to 100 emails, and each item succeeds or fails on its own. When an item has `Email.IdempotencyKey` set, that value is sent as the item's key. When it is empty, the server derives a key from the batch key and the item's position.

### Status, cancel, templates

```go
st, err := client.GetEmail(ctx, res.ID)  // st.Status, st.Events
err = client.CancelEmail(ctx, res.ID)    // only scheduled, unsent emails
list, err := client.ListTemplates(ctx)
tpl, err := client.GetTemplate(ctx, "template-uuid")
```

## Idempotency and retries

Every send includes an `Idempotency-Key` of 8 to 128 characters. If you don't set one, the client generates a random UUIDv4 and returns it as `res.IdempotencyKey`. Every retry reuses the same key and the same body, so Mailat never sends the message twice. Keys starting with `mailat:` are reserved.

If you might call `Send` again for the same logical message, for example from a job retry, pass a deterministic key such as `"order-1234-receipt"`. Reusing a key with different content returns a 409 (`mailat.IsConflict`).

The client retries 429 responses, 5xx responses and network errors. It waits for the time given in `Retry-After` when the server sends one (capped at 60s). Otherwise it uses exponential backoff with jitter. Cancelling `ctx` stops the retries.

## Errors

API failures return `*mailat.Error`:

```go
var e *mailat.Error
if errors.As(err, &e) {
	log.Println(e.Status, e.Code, e.Message, e.RetryAfter)
}
mailat.IsAuth(err)       // 401 / 403
mailat.IsRateLimit(err)  // 429
mailat.IsValidation(err) // 400 / 422, or rejected locally (errors.Is(err, mailat.ErrInvalidRequest))
mailat.IsNotFound(err)   // 404
mailat.IsConflict(err)   // 409 idempotency key reused with different content
```

## Webhooks

Mailat signs each delivery with `X-Webhook-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>` and sends the event ID in `X-Webhook-ID`. Verify the raw body before you trust any of it:

```go
func handler(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	ev, err := mailat.VerifyWebhook(body, r.Header.Get(mailat.SignatureHeader), os.Getenv("MAILAT_WEBHOOK_SECRET"), 5*time.Minute)
	if err != nil {
		http.Error(w, "invalid signature", http.StatusUnauthorized)
		return
	}
	switch ev.Type {
	case mailat.EventEmailDelivered:
		// ev.Data["messageUuid"] ...
	case mailat.EventEmailBounced, mailat.EventEmailComplained:
		// Mailat already suppresses the address. These events carry no "to":
		// transactional mail has ev.Data["messageUuid"] (look it up with
		// client.GetEmail), campaign mail has ev.Data["recipient"] and
		// ev.Data["campaignUuid"]. Also ev.Data["bounceType"] / ["complaintType"].
	}
	w.WriteHeader(http.StatusNoContent)
}
```

A tolerance of `0` or less means 5 minutes. Redeliveries reuse the same event `ID`, so deduplicate on it. `ErrInvalidSignature`, `ErrSignatureExpired` and `ErrInvalidPayload` tell you why verification failed. `SignWebhook` produces signatures identical to the server's, which is useful when you test your handler.

Event types: `email.sent`, `email.delivered`, `email.bounced`, `email.complained`, `email.failed`, `email.unknown`, `email.received`, `contact.subscribed`, `campaign.started|paused|cancelled|sent`, `webhook.test` (`EventWebhookTest`, sent only by the Test button) and `automation.webhook` (sent only to an automation's own trigger target). Only `email.sent`, `email.failed` and `email.unknown` carry `from`, `to` and `subject`.

## Development

```sh
gofmt -l . && go vet ./... && go test -race ./...
```

The tests use `httptest` servers and never contact a real Mailat instance.

License: MIT
