package mailat

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"
)

const (
	vectorSecret = "whsec_test_secret"
	vectorStamp  = int64(1700000000)
	vectorBody   = `{"version":"1","id":"9b2f6a3e-1c4d-4e8f-a0b1-2c3d4e5f6a7b","type":"email.delivered","createdAt":"2023-11-14T22:13:20Z","data":{"messageUuid":"0f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a","identityId":7}}`
	// Computed independently with:
	//   printf '%s' "1700000000.$BODY" | openssl dgst -sha256 -hmac whsec_test_secret
	vectorDigest = "a542678c8dffba710047c7b45cbada0645151031978a1b66026e8c5b4554225e"
)

// serverSign is a verbatim copy of Sign in
// mailat/apps/api/internal/eventoutbox/security.go (the code that signs
// every webhook delivery). Keeping it here pins the wire format.
func serverSign(body []byte, secret string, at time.Time) string {
	stamp := strconv.FormatInt(at.Unix(), 10)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(stamp + "."))
	mac.Write(body)
	return "t=" + stamp + ",v1=" + hex.EncodeToString(mac.Sum(nil))
}

var vectorTime = time.Unix(vectorStamp, 0)

func TestWebhookVectorMatchesServer(t *testing.T) {
	want := "t=1700000000,v1=" + vectorDigest
	if got := serverSign([]byte(vectorBody), vectorSecret, vectorTime); got != want {
		t.Fatalf("server algorithm = %s, want %s", got, want)
	}
	if got := SignWebhook([]byte(vectorBody), vectorSecret, vectorTime); got != want {
		t.Fatalf("SignWebhook = %s, want %s", got, want)
	}
	ev, err := verifyWebhookAt([]byte(vectorBody), want, vectorSecret, 0, vectorTime.Add(30*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if ev.Type != EventEmailDelivered || ev.ID != "9b2f6a3e-1c4d-4e8f-a0b1-2c3d4e5f6a7b" || ev.Version != "1" {
		t.Fatalf("event = %+v", ev)
	}
	if !ev.CreatedAt.Equal(vectorTime) || ev.Data["messageUuid"] != "0f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a" || ev.Data["identityId"] != float64(7) {
		t.Fatalf("event fields = %+v", ev)
	}
}

func TestVerifyWebhookLive(t *testing.T) {
	body := []byte(`{"version":"1","id":"e1","type":"email.received","createdAt":"2026-10-08T10:00:00Z","data":{}}`)
	sig := serverSign(body, "s3cret", time.Now())
	ev, err := VerifyWebhook(body, sig, "s3cret", time.Minute)
	if err != nil || ev.Type != EventEmailReceived {
		t.Fatalf("ev=%v err=%v", ev, err)
	}
}

func TestVerifyWebhookRejects(t *testing.T) {
	body := []byte(vectorBody)
	good := "t=1700000000,v1=" + vectorDigest
	now := vectorTime
	cases := []struct {
		name, body, sig, secret string
		now                     time.Time
		tol                     time.Duration
		want                    error
	}{
		{"tampered body", strings.Replace(vectorBody, "delivered", "bounced", 1), good, vectorSecret, now, 0, ErrInvalidSignature},
		{"wrong secret", vectorBody, good, "other", now, 0, ErrInvalidSignature},
		{"empty secret", vectorBody, good, "", now, 0, ErrInvalidSignature},
		{"empty header", vectorBody, "", vectorSecret, now, 0, ErrInvalidSignature},
		{"missing t", vectorBody, "v1=" + vectorDigest, vectorSecret, now, 0, ErrInvalidSignature},
		{"missing v1", vectorBody, "t=1700000000", vectorSecret, now, 0, ErrInvalidSignature},
		{"duplicate v1", vectorBody, good + ",v1=" + vectorDigest, vectorSecret, now, 0, ErrInvalidSignature},
		{"duplicate t", vectorBody, "t=1700000000," + good, vectorSecret, now, 0, ErrInvalidSignature},
		{"unknown part", vectorBody, good + ",v0=abc", vectorSecret, now, 0, ErrInvalidSignature},
		{"uppercase digest", vectorBody, "t=1700000000,v1=" + strings.ToUpper(vectorDigest), vectorSecret, now, 0, ErrInvalidSignature},
		{"short digest", vectorBody, "t=1700000000,v1=" + vectorDigest[:62], vectorSecret, now, 0, ErrInvalidSignature},
		{"leading zero stamp", vectorBody, "t=01700000000,v1=" + vectorDigest, vectorSecret, now, 0, ErrInvalidSignature},
		{"negative stamp", vectorBody, "t=-1,v1=" + vectorDigest, vectorSecret, now, 0, ErrInvalidSignature},
		{"too old (default 5m)", vectorBody, good, vectorSecret, now.Add(5*time.Minute + time.Second), 0, ErrSignatureExpired},
		{"too far in future", vectorBody, good, vectorSecret, now.Add(-6 * time.Minute), 0, ErrSignatureExpired},
		{"custom tolerance", vectorBody, good, vectorSecret, now.Add(11 * time.Second), 10 * time.Second, ErrSignatureExpired},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ev, err := verifyWebhookAt([]byte(tc.body), tc.sig, tc.secret, tc.tol, tc.now)
			if !errors.Is(err, tc.want) || ev != nil {
				t.Fatalf("err=%v ev=%v, want %v", err, ev, tc.want)
			}
		})
	}
	// Spaces around parts are tolerated, as on the server.
	if _, err := verifyWebhookAt(body, " t=1700000000 , v1="+vectorDigest+" ", vectorSecret, 0, now); err != nil {
		t.Fatalf("spaced header rejected: %v", err)
	}
	// Exactly at the tolerance edge is accepted.
	if _, err := verifyWebhookAt(body, good, vectorSecret, 0, now.Add(5*time.Minute)); err != nil {
		t.Fatalf("edge rejected: %v", err)
	}
}

func TestVerifyWebhookPayloadChecks(t *testing.T) {
	for _, body := range []string{`not json`, `{"version":"1","type":"email.sent"}`, `{"id":"x"}`} {
		sig := SignWebhook([]byte(body), "k", vectorTime)
		if _, err := verifyWebhookAt([]byte(body), sig, "k", 0, vectorTime); !errors.Is(err, ErrInvalidPayload) {
			t.Fatalf("body %q: err=%v", body, err)
		}
	}
}

func TestVerifyWebhookTestAndAutomationTypes(t *testing.T) {
	now := time.Unix(1_760_000_000, 0)
	for _, typ := range []string{EventWebhookTest, EventAutomationWebhook} {
		body := []byte(`{"version":"1","id":"evt_1","type":"` + typ + `","createdAt":"2026-10-08T10:00:00Z","data":{"test":true}}`)
		ev, err := verifyWebhookAt(body, SignWebhook(body, "whsec_x", now), "whsec_x", 0, now)
		if err != nil || ev.Type != typ {
			t.Fatalf("%s: ev=%+v err=%v", typ, ev, err)
		}
	}
	if EventWebhookTest != "webhook.test" || EventAutomationWebhook != "automation.webhook" {
		t.Fatal("event constants changed")
	}
}
