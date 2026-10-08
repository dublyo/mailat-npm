// Package mailat is a small, dependency-free client for sending email through
// a self-hosted Mailat instance (transactional API under /api/v1).
//
//	client, err := mailat.New(mailat.Config{
//		URL:    "https://mail.example.com",
//		APIKey: os.Getenv("MAILAT_API_KEY"),
//		From:   "support@example.com",
//	})
//	res, err := client.Send(ctx, mailat.Email{To: []string{"user@example.org"}, Subject: "Hi", Text: "Hello"})
package mailat

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	mrand "math/rand"
	"net"
	"net/http"
	"net/mail"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Version is the client version sent in the User-Agent header.
const Version = "1.0.0"

const (
	defaultTimeout    = 30 * time.Second
	defaultMaxRetries = 2 // 3 attempts in total
	maxBatchSize      = 100
	maxResponseBytes  = 10 << 20
	maxRetryWait      = 60 * time.Second
)

// ErrInvalidRequest is wrapped by errors the client returns before sending
// anything (missing recipients, bad idempotency key, invalid config, ...).
var ErrInvalidRequest = errors.New("mailat: invalid request")

// Config configures a Client. URL and APIKey are required.
type Config struct {
	// URL is the Mailat instance origin, e.g. https://mail.example.com.
	// A trailing /api/v1 is accepted. HTTPS is required except for localhost.
	URL string
	// APIKey is sent as "Authorization: Bearer <key>".
	APIKey string
	// From is the default sender used when Email.From is empty.
	From string
	// HTTPClient is used for requests (default: a new http.Client). The client
	// uses a copy with redirects disabled, so the API key is never forwarded
	// to another scheme, host or port; a 3xx response is returned as *Error.
	HTTPClient *http.Client
	// Timeout bounds each HTTP attempt (default 30s). The caller's context
	// bounds the whole call including retries.
	Timeout time.Duration
	// MaxRetries is the number of retries after the first attempt on 429,
	// 5xx and network errors. 0 means the default (2, i.e. 3 attempts);
	// a negative value (e.g. -1) disables retries. Note: this differs from
	// the JS client, where maxRetries: 0 disables retries.
	MaxRetries int
}

// Client talks to one Mailat instance. It is safe for concurrent use.
type Client struct {
	baseURL    string
	apiKey     string
	from       string
	http       *http.Client
	timeout    time.Duration
	maxRetries int

	// Test hooks.
	backoffBase time.Duration
	sleep       func(ctx context.Context, d time.Duration) error
}

// New validates cfg and returns a Client.
func New(cfg Config) (*Client, error) {
	base, err := normalizeURL(cfg.URL)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(cfg.APIKey) == "" {
		return nil, fmt.Errorf("%w: APIKey is required", ErrInvalidRequest)
	}
	if strings.ContainsAny(cfg.APIKey, "\r\n") {
		return nil, fmt.Errorf("%w: APIKey contains a line break", ErrInvalidRequest)
	}
	c := &Client{
		baseURL:     base,
		apiKey:      strings.TrimSpace(cfg.APIKey),
		from:        strings.TrimSpace(cfg.From),
		timeout:     cfg.Timeout,
		maxRetries:  cfg.MaxRetries,
		backoffBase: 500 * time.Millisecond,
		sleep:       sleepCtx,
	}
	hc := http.Client{}
	if cfg.HTTPClient != nil {
		hc = *cfg.HTTPClient
	}
	// Never follow redirects: Go would copy the Authorization header to a
	// same-host or subdomain target even over plain http or another port.
	hc.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	c.http = &hc
	if c.timeout <= 0 {
		c.timeout = defaultTimeout
	}
	switch {
	case c.maxRetries == 0:
		c.maxRetries = defaultMaxRetries
	case c.maxRetries < 0:
		c.maxRetries = 0
	}
	return c, nil
}

// NewFromEnv builds a Client from MAILAT_URL, MAILAT_API_KEY and MAILAT_FROM.
func NewFromEnv() (*Client, error) {
	return New(Config{URL: os.Getenv("MAILAT_URL"), APIKey: os.Getenv("MAILAT_API_KEY"), From: os.Getenv("MAILAT_FROM")})
}

func normalizeURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("%w: URL is required", ErrInvalidRequest)
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return "", fmt.Errorf("%w: URL must be an absolute http(s) URL", ErrInvalidRequest)
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("%w: URL must not contain credentials, a query or a fragment", ErrInvalidRequest)
	}
	if u.Scheme == "http" && !isLocalHost(u.Hostname()) {
		return "", fmt.Errorf("%w: URL must use https (http is allowed only for localhost)", ErrInvalidRequest)
	}
	path := strings.TrimRight(u.Path, "/")
	path = strings.TrimSuffix(path, "/api/v1")
	return u.Scheme + "://" + u.Host + strings.TrimRight(path, "/") + "/api/v1", nil
}

func isLocalHost(h string) bool {
	h = strings.ToLower(h)
	if h == "localhost" || strings.HasSuffix(h, ".localhost") {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

// ---------------------------------------------------------------- types

// Attachment is a file sent with the email: either inline base64 Content, or
// BlobID referencing an upload already stored on the Mailat instance (not both).
type Attachment struct {
	Name        string `json:"name,omitempty"`
	Type        string `json:"type,omitempty"`
	Content     string `json:"content,omitempty"`     // base64
	BlobID      string `json:"blobId,omitempty"`      // UUID of a compose upload or received attachment
	Disposition string `json:"disposition,omitempty"` // "attachment" or "inline"
	CID         string `json:"cid,omitempty"`         // Content-ID for inline images
}

// Email is one message. At least one of To/Cc/Bcc and one of HTML, Text,
// TemplateID or Attachments is required. Subject is required by the server.
type Email struct {
	From         string // defaults to Config.From; "support@example.com" or "Support <support@example.com>"
	To           []string
	Cc           []string
	Bcc          []string
	ReplyTo      string
	Subject      string
	HTML         string
	Text         string
	TemplateID   string            // template UUID
	Variables    map[string]string // template variables
	Attachments  []Attachment
	Tags         []string
	Metadata     map[string]string
	ScheduledFor *time.Time
	// IdempotencyKey (8-128 chars) makes retries safe. Send generates a
	// UUIDv4 when empty. In SendBatch it is the optional per-item key.
	IdempotencyKey string
}

type wireEmail struct {
	From           string            `json:"from"`
	To             []string          `json:"to,omitempty"`
	Cc             []string          `json:"cc,omitempty"`
	Bcc            []string          `json:"bcc,omitempty"`
	ReplyTo        string            `json:"replyTo,omitempty"`
	Subject        string            `json:"subject"`
	HTML           string            `json:"html,omitempty"`
	Text           string            `json:"text,omitempty"`
	TemplateID     string            `json:"templateId,omitempty"`
	Variables      map[string]string `json:"variables,omitempty"`
	Attachments    []Attachment      `json:"attachments,omitempty"`
	Tags           []string          `json:"tags,omitempty"`
	Metadata       map[string]string `json:"metadata,omitempty"`
	ScheduledFor   *string           `json:"scheduledFor,omitempty"`
	IdempotencyKey string            `json:"idempotencyKey,omitempty"`
}

// SendResult is returned by Send (status is usually "queued").
type SendResult struct {
	ID         string    `json:"id"`
	MessageID  string    `json:"messageId"`
	Status     string    `json:"status"`
	AcceptedAt time.Time `json:"acceptedAt"`
	// IdempotencyKey is the key that was used, so callers can log or reuse it.
	IdempotencyKey string `json:"-"`
}

// BatchOptions configures SendBatch.
type BatchOptions struct {
	// IdempotencyKey for the whole batch; generated when empty.
	IdempotencyKey string
}

// BatchItemResult is the outcome of one batch item.
type BatchItemResult struct {
	Index     int    `json:"index"`
	ID        string `json:"id,omitempty"`
	MessageID string `json:"messageId,omitempty"`
	Status    string `json:"status"`
	Error     string `json:"error,omitempty"`
}

// BatchResult is returned by SendBatch. Items can fail individually.
type BatchResult struct {
	Results        []BatchItemResult `json:"results"`
	IdempotencyKey string            `json:"-"`
}

// DeliveryEvent is one entry of an email's delivery history.
type DeliveryEvent struct {
	ID        int64     `json:"id"`
	EmailID   int64     `json:"emailId"`
	EventType string    `json:"eventType"`
	Timestamp time.Time `json:"timestamp"`
	Details   string    `json:"details,omitempty"`
	IPAddress string    `json:"ipAddress,omitempty"`
	UserAgent string    `json:"userAgent,omitempty"`
}

// EmailStatus is returned by GetEmail.
type EmailStatus struct {
	ID          string          `json:"id"`
	MessageID   string          `json:"messageId"`
	From        string          `json:"from"`
	To          []string        `json:"to"`
	Subject     string          `json:"subject"`
	Status      string          `json:"status"`
	Events      []DeliveryEvent `json:"events"`
	CreatedAt   time.Time       `json:"createdAt"`
	SentAt      *time.Time      `json:"sentAt,omitempty"`
	DeliveredAt *time.Time      `json:"deliveredAt,omitempty"`
}

// Template is a stored email template.
type Template struct {
	ID          int64     `json:"id"`
	UUID        string    `json:"uuid"`
	OrgID       int64     `json:"orgId"`
	Name        string    `json:"name"`
	Description string    `json:"description,omitempty"`
	Subject     string    `json:"subject"`
	HTMLBody    string    `json:"htmlBody"`
	TextBody    string    `json:"textBody,omitempty"`
	Variables   []string  `json:"variables"`
	IsActive    bool      `json:"isActive"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// ---------------------------------------------------------------- errors

// Error is returned for any non-success API response.
type Error struct {
	Status     int           // HTTP status
	Code       int           // "code" from the Mailat response envelope
	Message    string        // "message" from the envelope
	RequestID  string        // X-Request-Id response header, if any
	RetryAfter time.Duration // parsed Retry-After, if any
}

func (e *Error) Error() string {
	return fmt.Sprintf("mailat: %d %s", e.Status, e.Message)
}

func statusOf(err error) int {
	var e *Error
	if errors.As(err, &e) {
		return e.Status
	}
	return 0
}

// IsAuth reports an invalid/revoked key (401) or a missing scope (403).
func IsAuth(err error) bool { s := statusOf(err); return s == 401 || s == 403 }

// IsRateLimit reports a 429 response.
func IsRateLimit(err error) bool { return statusOf(err) == 429 }

// IsValidation reports a 400/422 response, or a request rejected locally.
func IsValidation(err error) bool {
	s := statusOf(err)
	return s == 400 || s == 422 || errors.Is(err, ErrInvalidRequest)
}

// IsNotFound reports a 404 response.
func IsNotFound(err error) bool { return statusOf(err) == 404 }

// IsConflict reports a 409: the idempotency key was already used for
// different content.
func IsConflict(err error) bool { return statusOf(err) == 409 }

// ---------------------------------------------------------------- API

// Send queues one email (POST /emails). Requires the email:send scope.
func (c *Client) Send(ctx context.Context, e Email) (*SendResult, error) {
	key := e.IdempotencyKey
	if key == "" {
		key = newUUID()
	}
	if err := validKey(key); err != nil {
		return nil, err
	}
	w, err := c.wire(e)
	if err != nil {
		return nil, err
	}
	// The key travels in the header only; the server requires header and
	// body keys to match when both are present.
	w.IdempotencyKey = ""
	var out SendResult
	if err := c.do(ctx, http.MethodPost, "/emails", w, key, &out); err != nil {
		return nil, err
	}
	out.IdempotencyKey = key
	return &out, nil
}

// SendBatch queues 1-100 emails (POST /emails/batch). Each Email's
// IdempotencyKey is sent as its per-item key; when empty the server derives
// one from the batch key. Requires the email:send scope.
func (c *Client) SendBatch(ctx context.Context, emails []Email, opts *BatchOptions) (*BatchResult, error) {
	if len(emails) == 0 || len(emails) > maxBatchSize {
		return nil, fmt.Errorf("%w: batch must contain between 1 and %d emails", ErrInvalidRequest, maxBatchSize)
	}
	key := ""
	if opts != nil {
		key = opts.IdempotencyKey
	}
	if key == "" {
		key = newUUID()
	}
	if err := validKey(key); err != nil {
		return nil, err
	}
	items := make([]wireEmail, len(emails))
	for i, e := range emails {
		w, err := c.wire(e)
		if err != nil {
			return nil, fmt.Errorf("email %d: %w", i, err)
		}
		if e.IdempotencyKey != "" {
			if err := validKey(e.IdempotencyKey); err != nil {
				return nil, fmt.Errorf("email %d: %w", i, err)
			}
		}
		items[i] = w
	}
	var out BatchResult
	if err := c.do(ctx, http.MethodPost, "/emails/batch", map[string]any{"emails": items}, key, &out); err != nil {
		return nil, err
	}
	out.IdempotencyKey = key
	return &out, nil
}

// GetEmail returns an email's status and delivery events (GET /emails/:id).
// Requires the email:read scope.
func (c *Client) GetEmail(ctx context.Context, id string) (*EmailStatus, error) {
	if strings.TrimSpace(id) == "" {
		return nil, fmt.Errorf("%w: email id is required", ErrInvalidRequest)
	}
	var out EmailStatus
	if err := c.do(ctx, http.MethodGet, "/emails/"+url.PathEscape(id), nil, "", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// CancelEmail cancels a scheduled email that has not been sent yet
// (DELETE /emails/:id). Requires the email:manage scope.
func (c *Client) CancelEmail(ctx context.Context, id string) error {
	if strings.TrimSpace(id) == "" {
		return fmt.Errorf("%w: email id is required", ErrInvalidRequest)
	}
	return c.do(ctx, http.MethodDelete, "/emails/"+url.PathEscape(id), nil, "", nil)
}

// ListTemplates returns the organization's templates (GET /templates).
// Requires the templates:read scope.
func (c *Client) ListTemplates(ctx context.Context) ([]Template, error) {
	out := []Template{}
	if err := c.do(ctx, http.MethodGet, "/templates", nil, "", &out); err != nil {
		return nil, err
	}
	if out == nil {
		out = []Template{}
	}
	return out, nil
}

// GetTemplate returns one template by UUID (GET /templates/:uuid).
// Requires the templates:read scope.
func (c *Client) GetTemplate(ctx context.Context, uuid string) (*Template, error) {
	if strings.TrimSpace(uuid) == "" {
		return nil, fmt.Errorf("%w: template uuid is required", ErrInvalidRequest)
	}
	var out Template
	if err := c.do(ctx, http.MethodGet, "/templates/"+url.PathEscape(uuid), nil, "", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ---------------------------------------------------------------- internals

func (c *Client) wire(e Email) (wireEmail, error) {
	from := strings.TrimSpace(e.From)
	if from == "" {
		from = c.from
	}
	if from == "" {
		return wireEmail{}, fmt.Errorf("%w: from is required (set Email.From or Config.From)", ErrInvalidRequest)
	}
	if strings.ContainsAny(from, "\r\n") {
		return wireEmail{}, fmt.Errorf("%w: from contains a line break", ErrInvalidRequest)
	}
	// A bare address or "Name <address>"; the server parses it the same way.
	if _, err := mail.ParseAddress(from); err != nil {
		return wireEmail{}, fmt.Errorf("%w: from is not a valid address: %v", ErrInvalidRequest, err)
	}
	if len(e.To)+len(e.Cc)+len(e.Bcc) == 0 {
		return wireEmail{}, fmt.Errorf("%w: at least one recipient (To, Cc or Bcc) is required", ErrInvalidRequest)
	}
	if strings.TrimSpace(e.Subject) == "" {
		return wireEmail{}, fmt.Errorf("%w: subject is required", ErrInvalidRequest)
	}
	if e.HTML == "" && e.Text == "" && e.TemplateID == "" && len(e.Attachments) == 0 {
		return wireEmail{}, fmt.Errorf("%w: HTML, Text, TemplateID or Attachments is required", ErrInvalidRequest)
	}
	for i, a := range e.Attachments {
		if a.Content != "" && a.BlobID != "" {
			return wireEmail{}, fmt.Errorf("%w: attachment %d: set Content or BlobID, not both", ErrInvalidRequest, i)
		}
		if a.Content == "" && a.BlobID == "" {
			return wireEmail{}, fmt.Errorf("%w: attachment %d: Content or BlobID is required", ErrInvalidRequest, i)
		}
	}
	w := wireEmail{
		From: from, To: e.To, Cc: e.Cc, Bcc: e.Bcc, ReplyTo: e.ReplyTo, Subject: e.Subject,
		HTML: e.HTML, Text: e.Text, TemplateID: e.TemplateID, Variables: e.Variables,
		Attachments: e.Attachments, Tags: e.Tags, Metadata: e.Metadata, IdempotencyKey: e.IdempotencyKey,
	}
	if e.ScheduledFor != nil {
		s := e.ScheduledFor.UTC().Format(time.RFC3339)
		w.ScheduledFor = &s
	}
	return w, nil
}

func validKey(key string) error {
	if len(key) < 8 || len(key) > 128 || strings.ContainsAny(key, "\r\n") {
		return fmt.Errorf("%w: idempotency key must be 8 to 128 characters without line breaks", ErrInvalidRequest)
	}
	if strings.HasPrefix(strings.ToLower(key), "mailat:") {
		return fmt.Errorf("%w: idempotency keys starting with \"mailat:\" are reserved", ErrInvalidRequest)
	}
	return nil
}

type envelope struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
}

// do performs one API call with retries. The same body and Idempotency-Key
// are sent on every attempt, so the server deduplicates retried sends.
func (c *Client) do(ctx context.Context, method, path string, body any, idemKey string, out any) error {
	var payload []byte
	if body != nil {
		var err error
		if payload, err = json.Marshal(body); err != nil {
			return fmt.Errorf("mailat: encode request: %w", err)
		}
	}
	for attempt := 0; ; attempt++ {
		err := c.attempt(ctx, method, path, payload, idemKey, out)
		if err == nil {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		var apiErr *Error
		isAPI := errors.As(err, &apiErr)
		var local *localError
		retryable := !errors.As(err, &local) && (!isAPI || apiErr.Status == 429 || apiErr.Status >= 500)
		if !retryable || attempt >= c.maxRetries {
			return err
		}
		wait := c.backoff(attempt)
		if isAPI && apiErr.RetryAfter > 0 {
			wait = apiErr.RetryAfter
		}
		if serr := c.sleep(ctx, wait); serr != nil {
			return serr
		}
	}
}

func (c *Client) attempt(ctx context.Context, method, path string, payload []byte, idemKey string, out any) error {
	actx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	var rd io.Reader
	if payload != nil {
		rd = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(actx, method, c.baseURL+path, rd)
	if err != nil {
		return &localError{fmt.Errorf("mailat: build request: %w", err)}
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "mailat-go/"+Version)
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if idemKey != "" {
		req.Header.Set("Idempotency-Key", idemKey)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("mailat: request failed: %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return fmt.Errorf("mailat: read response: %w", err)
	}
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		return &Error{Status: resp.StatusCode, Code: resp.StatusCode, Message: "unexpected redirect (not followed): check the Mailat URL", RequestID: resp.Header.Get("X-Request-Id")}
	}
	var env envelope
	jsonErr := json.Unmarshal(raw, &env)
	if resp.StatusCode >= 400 || (jsonErr == nil && env.Code != 0) {
		e := &Error{
			Status:     resp.StatusCode,
			Code:       env.Code,
			Message:    env.Message,
			RequestID:  resp.Header.Get("X-Request-Id"),
			RetryAfter: parseRetryAfter(resp.Header.Get("Retry-After")),
		}
		if e.Status < 400 { // error envelope delivered with a 2xx status
			e.Status = env.Code
		}
		if e.Code == 0 {
			e.Code = resp.StatusCode
		}
		if e.Message == "" {
			e.Message = http.StatusText(resp.StatusCode)
		}
		return e
	}
	if jsonErr != nil {
		return &Error{Status: resp.StatusCode, Message: "invalid JSON response from Mailat", RequestID: resp.Header.Get("X-Request-Id")}
	}
	if out != nil && len(env.Data) > 0 && string(env.Data) != "null" {
		if err := json.Unmarshal(env.Data, out); err != nil {
			return &localError{fmt.Errorf("mailat: decode response: %w", err)}
		}
	}
	return nil
}

// localError marks a failure that happened in this process (building the
// request, decoding a 2xx body). Retrying it cannot help, so do() returns it
// at once. It unwraps to the underlying error.
type localError struct{ err error }

func (e *localError) Error() string { return e.err.Error() }
func (e *localError) Unwrap() error { return e.err }

func (c *Client) backoff(attempt int) time.Duration {
	d := float64(c.backoffBase) * math.Pow(2, float64(attempt))
	if d > float64(10*time.Second) {
		d = float64(10 * time.Second)
	}
	// Equal jitter: half fixed, half random.
	return time.Duration(d/2 + mrand.Float64()*d/2)
}

func parseRetryAfter(v string) time.Duration {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0
	}
	var d time.Duration
	if n, err := strconv.Atoi(v); err == nil {
		d = time.Duration(n) * time.Second
	} else if t, err := http.ParseTime(v); err == nil {
		d = time.Until(t)
	}
	if d < 0 {
		return 0
	}
	if d > maxRetryWait {
		d = maxRetryWait
	}
	return d
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// newUUID returns a random RFC 4122 version 4 UUID.
func newUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("mailat: crypto/rand failed: " + err.Error())
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
