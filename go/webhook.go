package mailat

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"
)

// Webhook request headers set by Mailat.
const (
	SignatureHeader = "X-Webhook-Signature" // t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>
	WebhookIDHeader = "X-Webhook-ID"        // event id, stable across redeliveries
)

// DefaultWebhookTolerance is used when VerifyWebhook gets tolerance <= 0.
const DefaultWebhookTolerance = 5 * time.Minute

// Webhook event types.
const (
	EventEmailSent         = "email.sent"
	EventEmailDelivered    = "email.delivered"
	EventEmailBounced      = "email.bounced"
	EventEmailComplained   = "email.complained"
	EventEmailFailed       = "email.failed"
	EventEmailUnknown      = "email.unknown"
	EventEmailReceived     = "email.received"
	EventContactSubscribed = "contact.subscribed"
	EventCampaignStarted   = "campaign.started"
	EventCampaignPaused    = "campaign.paused"
	EventCampaignCancelled = "campaign.cancelled"
	EventCampaignSent      = "campaign.sent"
	EventWebhookTest       = "webhook.test"       // sent only by the Test button
	EventAutomationWebhook = "automation.webhook" // sent only to an automation's own trigger target
)

var (
	// ErrInvalidSignature means the signature header is malformed or does
	// not match the body and secret.
	ErrInvalidSignature = errors.New("mailat: invalid webhook signature")
	// ErrSignatureExpired means the signature timestamp is outside the tolerance.
	ErrSignatureExpired = errors.New("mailat: webhook timestamp outside tolerance")
	// ErrInvalidPayload means the signature was valid but the body is not a
	// Mailat event envelope.
	ErrInvalidPayload = errors.New("mailat: invalid webhook payload")
)

// WebhookEvent is the signed event envelope Mailat delivers.
type WebhookEvent struct {
	Version   string         `json:"version"`
	ID        string         `json:"id"`
	Type      string         `json:"type"`
	CreatedAt time.Time      `json:"createdAt"`
	Data      map[string]any `json:"data"`
}

// SignWebhook produces an X-Webhook-Signature value exactly as Mailat does.
// It is useful for testing your webhook handler.
func SignWebhook(body []byte, secret string, at time.Time) string {
	stamp := strconv.FormatInt(at.Unix(), 10)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(stamp + "."))
	mac.Write(body)
	return "t=" + stamp + ",v1=" + hex.EncodeToString(mac.Sum(nil))
}

// VerifyWebhook checks the X-Webhook-Signature header against the raw request
// body and returns the parsed event. Pass the body bytes exactly as received.
// The payload is decoded only after the signature is verified.
func VerifyWebhook(body []byte, signature, secret string, tolerance time.Duration) (*WebhookEvent, error) {
	return verifyWebhookAt(body, signature, secret, tolerance, time.Now())
}

func verifyWebhookAt(body []byte, signature, secret string, tolerance time.Duration, now time.Time) (*WebhookEvent, error) {
	if secret == "" {
		return nil, ErrInvalidSignature
	}
	var stamp, digest string
	seen := map[string]bool{}
	for _, part := range strings.Split(signature, ",") {
		pair := strings.SplitN(strings.TrimSpace(part), "=", 2)
		if len(pair) != 2 || seen[pair[0]] {
			return nil, ErrInvalidSignature
		}
		seen[pair[0]] = true
		switch pair[0] {
		case "t":
			stamp = pair[1]
		case "v1":
			digest = pair[1]
		default:
			return nil, ErrInvalidSignature
		}
	}
	ts, err := strconv.ParseInt(stamp, 10, 64)
	if err != nil || ts <= 0 || strconv.FormatInt(ts, 10) != stamp || len(digest) != 64 {
		return nil, ErrInvalidSignature
	}
	if tolerance <= 0 {
		tolerance = DefaultWebhookTolerance
	}
	expected := SignWebhook(body, secret, time.Unix(ts, 0))
	expected = expected[strings.Index(expected, ",v1=")+4:]
	if subtle.ConstantTimeCompare([]byte(expected), []byte(digest)) != 1 {
		return nil, ErrInvalidSignature
	}
	if diff := now.Sub(time.Unix(ts, 0)); diff > tolerance || diff < -tolerance {
		return nil, ErrSignatureExpired
	}
	var ev WebhookEvent
	if err := json.Unmarshal(body, &ev); err != nil || ev.ID == "" || ev.Type == "" {
		return nil, ErrInvalidPayload
	}
	if ev.Data == nil {
		ev.Data = map[string]any{}
	}
	return &ev, nil
}
