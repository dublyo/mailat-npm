package mailat

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

var uuidV4 = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

type recorded struct {
	Method, Path, Auth, Key, ContentType string
	Body                                 map[string]any
	Raw                                  string
}

// fakeMailat is a scripted Mailat API. Each request pops the next responder;
// the last one repeats.
type fakeMailat struct {
	t     *testing.T
	mu    sync.Mutex
	reqs  []recorded
	steps []func(w http.ResponseWriter, r *http.Request)
	srv   *httptest.Server
}

func newFake(t *testing.T, steps ...func(w http.ResponseWriter, r *http.Request)) *fakeMailat {
	f := &fakeMailat{t: t, steps: steps}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		rec := recorded{Method: r.Method, Path: r.URL.EscapedPath(), Auth: r.Header.Get("Authorization"), Key: r.Header.Get("Idempotency-Key"), ContentType: r.Header.Get("Content-Type"), Raw: string(raw)}
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &rec.Body)
		}
		f.mu.Lock()
		i := len(f.reqs)
		f.reqs = append(f.reqs, rec)
		f.mu.Unlock()
		if i >= len(f.steps) {
			i = len(f.steps) - 1
		}
		f.steps[i](w, r)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeMailat) requests() []recorded {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]recorded(nil), f.reqs...)
}

func reply(status int, body string, headers ...string) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, _ *http.Request) {
		for i := 0; i+1 < len(headers); i += 2 {
			w.Header().Set(headers[i], headers[i+1])
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}
}

func ok(data string) func(http.ResponseWriter, *http.Request) {
	return reply(200, `{"code":0,"message":"success","data":`+data+`}`)
}

const sendOK = `{"id":"3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b","messageId":"<abc@mail.example.com>","status":"queued","acceptedAt":"2026-10-08T10:00:00Z"}`

type client struct {
	*Client
	sleeps []time.Duration
	mu     sync.Mutex
}

func newTestClient(t *testing.T, url string, mod ...func(*Config)) *client {
	t.Helper()
	cfg := Config{URL: url, APIKey: "ml_test_key", From: "Support <support@example.com>"}
	for _, m := range mod {
		m(&cfg)
	}
	c, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	tc := &client{Client: c}
	c.sleep = func(ctx context.Context, d time.Duration) error {
		tc.mu.Lock()
		tc.sleeps = append(tc.sleeps, d)
		tc.mu.Unlock()
		return ctx.Err()
	}
	return tc
}

func baseEmail() Email {
	return Email{To: []string{"user@example.org"}, Subject: "Hello", Text: "Hi there"}
}

func TestSendRequestShape(t *testing.T) {
	f := newFake(t, reply(200, `{"code":0,"message":"Email queued","data":`+sendOK+`}`))
	c := newTestClient(t, f.srv.URL)
	at := time.Date(2026, 10, 9, 8, 30, 0, 0, time.FixedZone("x", 3600))
	res, err := c.Send(context.Background(), Email{
		To: []string{"a@example.org"}, Cc: []string{"b@example.org"}, Bcc: []string{"c@example.org"},
		ReplyTo: "help@example.com", Subject: "Welcome", HTML: "<p>Hi</p>", Text: "Hi",
		Attachments: []Attachment{{Name: "a.txt", Type: "text/plain", Content: "aGk=", Disposition: "attachment"}},
		Tags:        []string{"welcome"}, Metadata: map[string]string{"user": "42"}, ScheduledFor: &at,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.ID != "3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b" || res.MessageID != "<abc@mail.example.com>" || res.Status != "queued" || !res.AcceptedAt.Equal(time.Date(2026, 10, 8, 10, 0, 0, 0, time.UTC)) {
		t.Fatalf("result = %+v", res)
	}
	reqs := f.requests()
	if len(reqs) != 1 {
		t.Fatalf("requests = %d", len(reqs))
	}
	r := reqs[0]
	if r.Method != "POST" || r.Path != "/api/v1/emails" || r.Auth != "Bearer ml_test_key" || r.ContentType != "application/json" {
		t.Fatalf("request = %+v", r)
	}
	if !uuidV4.MatchString(r.Key) || res.IdempotencyKey != r.Key {
		t.Fatalf("idempotency key %q (result %q)", r.Key, res.IdempotencyKey)
	}
	b := r.Body
	if b["from"] != "Support <support@example.com>" { // display name sent as given
		t.Fatalf("from = %v", b["from"])
	}
	if b["subject"] != "Welcome" || b["html"] != "<p>Hi</p>" || b["text"] != "Hi" || b["replyTo"] != "help@example.com" || b["scheduledFor"] != "2026-10-09T07:30:00Z" {
		t.Fatalf("body = %s", r.Raw)
	}
	if _, has := b["idempotencyKey"]; has {
		t.Fatalf("single send must carry the key in the header only: %s", r.Raw)
	}
	for _, k := range []string{"to", "cc", "bcc", "attachments", "tags", "metadata"} {
		if _, has := b[k]; !has {
			t.Fatalf("missing %s in %s", k, r.Raw)
		}
	}
	att := b["attachments"].([]any)[0].(map[string]any)
	if att["name"] != "a.txt" || att["type"] != "text/plain" || att["content"] != "aGk=" || att["disposition"] != "attachment" {
		t.Fatalf("attachment = %v", att)
	}
	if b["metadata"].(map[string]any)["user"] != "42" {
		t.Fatalf("metadata = %v", b["metadata"])
	}
}

func TestSendTemplateAndExplicitKey(t *testing.T) {
	f := newFake(t, ok(sendOK))
	c := newTestClient(t, f.srv.URL)
	_, err := c.Send(context.Background(), Email{From: "billing@example.com", To: []string{"u@example.org"}, Subject: "Invoice", TemplateID: "tpl-uuid", Variables: map[string]string{"name": "Ada"}, IdempotencyKey: "order-1234-receipt"})
	if err != nil {
		t.Fatal(err)
	}
	r := f.requests()[0]
	if r.Key != "order-1234-receipt" || r.Body["from"] != "billing@example.com" || r.Body["templateId"] != "tpl-uuid" || r.Body["variables"].(map[string]any)["name"] != "Ada" {
		t.Fatalf("request = %+v", r)
	}
	if _, has := r.Body["html"]; has {
		t.Fatalf("empty fields must be omitted: %s", r.Raw)
	}
}

func TestRetryReusesKeyAndBody(t *testing.T) {
	f := newFake(t,
		reply(503, `{"code":503,"message":"Mail service is temporarily unavailable; retry unchanged content with the same idempotency key"}`),
		reply(500, `oops`),
		ok(sendOK))
	c := newTestClient(t, f.srv.URL)
	res, err := c.Send(context.Background(), baseEmail())
	if err != nil {
		t.Fatal(err)
	}
	reqs := f.requests()
	if len(reqs) != 3 {
		t.Fatalf("attempts = %d", len(reqs))
	}
	for _, r := range reqs[1:] {
		if r.Key != reqs[0].Key || r.Raw != reqs[0].Raw {
			t.Fatalf("retry changed key/body: %q vs %q", r.Key, reqs[0].Key)
		}
	}
	if res.IdempotencyKey != reqs[0].Key || len(c.sleeps) != 2 {
		t.Fatalf("key=%s sleeps=%v", res.IdempotencyKey, c.sleeps)
	}
	// Exponential backoff with jitter: attempt 0 in [250ms,500ms], attempt 1 in [500ms,1s].
	if c.sleeps[0] < 250*time.Millisecond || c.sleeps[0] > 500*time.Millisecond || c.sleeps[1] < 500*time.Millisecond || c.sleeps[1] > time.Second {
		t.Fatalf("backoff = %v", c.sleeps)
	}
}

func TestRetryAfterHonoured(t *testing.T) {
	f := newFake(t, reply(429, `{"code":429,"message":"API key request limit exceeded"}`, "Retry-After", "7"), ok(sendOK))
	c := newTestClient(t, f.srv.URL)
	if _, err := c.Send(context.Background(), baseEmail()); err != nil {
		t.Fatal(err)
	}
	if len(c.sleeps) != 1 || c.sleeps[0] != 7*time.Second {
		t.Fatalf("sleeps = %v", c.sleeps)
	}
	if reqs := f.requests(); reqs[0].Key != reqs[1].Key {
		t.Fatal("key changed across 429 retry")
	}
}

func TestRetriesExhausted(t *testing.T) {
	f := newFake(t, reply(429, `{"code":429,"message":"slow down"}`, "Retry-After", "2"))
	c := newTestClient(t, f.srv.URL)
	_, err := c.Send(context.Background(), baseEmail())
	var e *Error
	if !errors.As(err, &e) || e.Status != 429 || e.Code != 429 || e.Message != "slow down" || e.RetryAfter != 2*time.Second {
		t.Fatalf("err = %#v", err)
	}
	if !IsRateLimit(err) || IsAuth(err) {
		t.Fatal("helpers wrong for 429")
	}
	if n := len(f.requests()); n != 3 {
		t.Fatalf("attempts = %d, want 3", n)
	}
}

func TestMaxRetriesConfig(t *testing.T) {
	f := newFake(t, reply(502, `bad gateway`))
	c := newTestClient(t, f.srv.URL, func(cfg *Config) { cfg.MaxRetries = -1 })
	if _, err := c.Send(context.Background(), baseEmail()); statusOf(err) != 502 {
		t.Fatalf("err = %v", err)
	}
	if n := len(f.requests()); n != 1 {
		t.Fatalf("attempts = %d, want 1", n)
	}
	f2 := newFake(t, reply(500, `{"code":500,"message":"x"}`))
	c2 := newTestClient(t, f2.srv.URL, func(cfg *Config) { cfg.MaxRetries = 4 })
	_, _ = c2.Send(context.Background(), baseEmail())
	if n := len(f2.requests()); n != 5 {
		t.Fatalf("attempts = %d, want 5", n)
	}
}

func TestNoRetryOnClientErrors(t *testing.T) {
	cases := []struct {
		status int
		body   string
		check  func(error) bool
	}{
		{400, `{"code":400,"message":"sender domain not verified for your organization"}`, IsValidation},
		{401, `{"code":401,"message":"Invalid, expired, or revoked API key"}`, IsAuth},
		{403, `{"code":403,"message":"API key is not permitted for this operation"}`, IsAuth},
		{404, `{"code":404,"message":"email not found"}`, IsNotFound},
		{409, `{"code":409,"message":"submission key was already used for different content"}`, IsConflict},
	}
	for _, tc := range cases {
		f := newFake(t, reply(tc.status, tc.body))
		c := newTestClient(t, f.srv.URL)
		_, err := c.Send(context.Background(), baseEmail())
		var e *Error
		if !errors.As(err, &e) || e.Status != tc.status || e.Code != tc.status || !tc.check(err) {
			t.Fatalf("%d: err = %#v", tc.status, err)
		}
		if !strings.Contains(err.Error(), e.Message) || e.Message == "" {
			t.Fatalf("%d: message %q", tc.status, err.Error())
		}
		if n := len(f.requests()); n != 1 {
			t.Fatalf("%d: attempts = %d", tc.status, n)
		}
	}
}

func TestErrorEnvelopeWith200(t *testing.T) {
	f := newFake(t, reply(200, `{"code":400,"message":"bad thing"}`))
	c := newTestClient(t, f.srv.URL)
	_, err := c.Send(context.Background(), baseEmail())
	if !IsValidation(err) || err.(*Error).Message != "bad thing" {
		t.Fatalf("err = %v", err)
	}
}

func TestNonJSONSuccessIsError(t *testing.T) {
	f := newFake(t, reply(200, `<html>proxy</html>`))
	c := newTestClient(t, f.srv.URL)
	if _, err := c.Send(context.Background(), baseEmail()); err == nil || !strings.Contains(err.Error(), "invalid JSON") {
		t.Fatalf("err = %v", err)
	}
}

func TestNetworkErrorRetried(t *testing.T) {
	f := newFake(t, func(w http.ResponseWriter, _ *http.Request) {
		conn, _, err := w.(http.Hijacker).Hijack()
		if err == nil {
			conn.Close() // drop the connection without a response
		}
	}, ok(sendOK))
	c := newTestClient(t, f.srv.URL)
	if _, err := c.Send(context.Background(), baseEmail()); err != nil {
		t.Fatal(err)
	}
	reqs := f.requests()
	if len(reqs) != 2 || reqs[0].Key != reqs[1].Key {
		t.Fatalf("requests = %+v", reqs)
	}
}

func TestPerAttemptTimeout(t *testing.T) {
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	f := newFake(t, func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	})
	c := newTestClient(t, f.srv.URL, func(cfg *Config) { cfg.Timeout = 50 * time.Millisecond; cfg.MaxRetries = 1 })
	start := time.Now()
	_, err := c.Send(context.Background(), baseEmail())
	if err == nil || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v", err)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatal("timeout not applied")
	}
	if n := len(f.requests()); n != 2 {
		t.Fatalf("attempts = %d, want 2 (timeout is retried)", n)
	}
}

func TestContextCancelStopsRetries(t *testing.T) {
	f := newFake(t, reply(503, `{"code":503,"message":"down"}`))
	c := newTestClient(t, f.srv.URL)
	ctx, cancel := context.WithCancel(context.Background())
	c.sleep = func(context.Context, time.Duration) error { cancel(); return context.Canceled }
	_, err := c.Send(ctx, baseEmail())
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	if n := len(f.requests()); n != 1 {
		t.Fatalf("attempts = %d", n)
	}
	// Real sleeper honours cancellation too.
	ctx2, cancel2 := context.WithCancel(context.Background())
	cancel2()
	if err := sleepCtx(ctx2, time.Hour); !errors.Is(err, context.Canceled) {
		t.Fatalf("sleepCtx = %v", err)
	}
}

func TestSendBatch(t *testing.T) {
	f := newFake(t, ok(`{"results":[{"index":0,"id":"id-0","messageId":"<m0@x>","status":"queued"},{"index":1,"status":"failed","error":"invalid recipient"}]}`))
	c := newTestClient(t, f.srv.URL)
	e1 := baseEmail()
	e1.IdempotencyKey = "welcome-user-1"
	e2 := baseEmail()
	e2.From = "news@example.com"
	res, err := c.SendBatch(context.Background(), []Email{e1, e2}, &BatchOptions{IdempotencyKey: "batch-2026-10-08"})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Results) != 2 || res.Results[0].ID != "id-0" || res.Results[1].Status != "failed" || res.Results[1].Error != "invalid recipient" || res.IdempotencyKey != "batch-2026-10-08" {
		t.Fatalf("result = %+v", res)
	}
	r := f.requests()[0]
	if r.Method != "POST" || r.Path != "/api/v1/emails/batch" || r.Key != "batch-2026-10-08" {
		t.Fatalf("request = %+v", r)
	}
	items := r.Body["emails"].([]any)
	if len(items) != 2 {
		t.Fatalf("body = %s", r.Raw)
	}
	i0, i1 := items[0].(map[string]any), items[1].(map[string]any)
	if i0["idempotencyKey"] != "welcome-user-1" || i0["from"] != "Support <support@example.com>" || i1["from"] != "news@example.com" {
		t.Fatalf("items = %s", r.Raw)
	}
	if _, has := i1["idempotencyKey"]; has {
		t.Fatalf("empty per-item key must be omitted so the server derives one: %s", r.Raw)
	}
}

func TestSendBatchGeneratesKeyAndRetries(t *testing.T) {
	f := newFake(t, reply(503, `{"code":503,"message":"down"}`), ok(`{"results":[]}`))
	c := newTestClient(t, f.srv.URL)
	res, err := c.SendBatch(context.Background(), []Email{baseEmail()}, nil)
	if err != nil {
		t.Fatal(err)
	}
	reqs := f.requests()
	if !uuidV4.MatchString(reqs[0].Key) || reqs[0].Key != reqs[1].Key || res.IdempotencyKey != reqs[0].Key {
		t.Fatalf("keys %q %q", reqs[0].Key, reqs[1].Key)
	}
}

func TestEmailStatusAndCancel(t *testing.T) {
	f := newFake(t,
		ok(`{"id":"e-1","messageId":"<m@x>","from":"support@example.com","to":["u@example.org"],"subject":"Hi","status":"delivered","events":[{"id":1,"emailId":9,"eventType":"delivered","timestamp":"2026-10-08T10:01:00Z"}],"createdAt":"2026-10-08T10:00:00Z","deliveredAt":"2026-10-08T10:01:00Z"}`),
		reply(200, `{"code":0,"message":"Email cancelled"}`))
	c := newTestClient(t, f.srv.URL)
	st, err := c.GetEmail(context.Background(), "e-1")
	if err != nil {
		t.Fatal(err)
	}
	if st.Status != "delivered" || len(st.Events) != 1 || st.Events[0].EventType != "delivered" || st.DeliveredAt == nil || st.SentAt != nil || st.To[0] != "u@example.org" {
		t.Fatalf("status = %+v", st)
	}
	if err := c.CancelEmail(context.Background(), "a/b"); err != nil {
		t.Fatal(err)
	}
	reqs := f.requests()
	if reqs[0].Method != "GET" || reqs[0].Path != "/api/v1/emails/e-1" || reqs[0].Key != "" || reqs[0].Auth != "Bearer ml_test_key" {
		t.Fatalf("get = %+v", reqs[0])
	}
	if reqs[1].Method != "DELETE" || reqs[1].Path != "/api/v1/emails/a%2Fb" {
		t.Fatalf("cancel = %+v", reqs[1])
	}
	if _, err := c.GetEmail(context.Background(), " "); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("empty id: %v", err)
	}
	if err := c.CancelEmail(context.Background(), ""); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("empty id: %v", err)
	}
}

func TestCancelNotCancellable(t *testing.T) {
	f := newFake(t, reply(400, `{"code":400,"message":"email not found or cannot be cancelled"}`))
	c := newTestClient(t, f.srv.URL)
	if err := c.CancelEmail(context.Background(), "e-1"); !IsValidation(err) {
		t.Fatalf("err = %v", err)
	}
}

func TestTemplates(t *testing.T) {
	tpl := `{"id":3,"uuid":"t-uuid","orgId":1,"name":"Welcome","subject":"Hi {{name}}","htmlBody":"<p>Hi {{name}}</p>","variables":["name"],"isActive":true,"createdAt":"2026-10-01T00:00:00Z","updatedAt":"2026-10-02T00:00:00Z"}`
	f := newFake(t, ok(`[`+tpl+`]`), ok(tpl), ok(`null`), reply(404, `{"code":404,"message":"template not found"}`))
	c := newTestClient(t, f.srv.URL)
	list, err := c.ListTemplates(context.Background())
	if err != nil || len(list) != 1 || list[0].UUID != "t-uuid" || list[0].Variables[0] != "name" || !list[0].IsActive {
		t.Fatalf("list = %+v err=%v", list, err)
	}
	one, err := c.GetTemplate(context.Background(), "t-uuid")
	if err != nil || one.Name != "Welcome" || one.HTMLBody != "<p>Hi {{name}}</p>" {
		t.Fatalf("get = %+v err=%v", one, err)
	}
	empty, err := c.ListTemplates(context.Background())
	if err != nil || empty == nil || len(empty) != 0 {
		t.Fatalf("empty list = %#v err=%v", empty, err)
	}
	if _, err := c.GetTemplate(context.Background(), "missing"); !IsNotFound(err) {
		t.Fatalf("err = %v", err)
	}
	reqs := f.requests()
	if reqs[0].Path != "/api/v1/templates" || reqs[1].Path != "/api/v1/templates/t-uuid" || reqs[0].Method != "GET" {
		t.Fatalf("reqs = %+v", reqs)
	}
}

func TestLocalValidation(t *testing.T) {
	f := newFake(t, ok(sendOK))
	c := newTestClient(t, f.srv.URL)
	noFrom := newTestClient(t, f.srv.URL, func(cfg *Config) { cfg.From = "" })
	ctx := context.Background()
	cases := map[string]func() error{
		"no from":       func() error { _, err := noFrom.Send(ctx, baseEmail()); return err },
		"no recipients": func() error { e := baseEmail(); e.To = nil; _, err := c.Send(ctx, e); return err },
		"no subject":    func() error { e := baseEmail(); e.Subject = ""; _, err := c.Send(ctx, e); return err },
		"no body":       func() error { e := baseEmail(); e.Text = ""; _, err := c.Send(ctx, e); return err },
		"short key":     func() error { e := baseEmail(); e.IdempotencyKey = "short"; _, err := c.Send(ctx, e); return err },
		"long key": func() error {
			e := baseEmail()
			e.IdempotencyKey = strings.Repeat("k", 129)
			_, err := c.Send(ctx, e)
			return err
		},
		"newline key": func() error { e := baseEmail(); e.IdempotencyKey = "abcdefgh\n"; _, err := c.Send(ctx, e); return err },
		"reserved key": func() error {
			e := baseEmail()
			e.IdempotencyKey = "Mailat:digest:1"
			_, err := c.Send(ctx, e)
			return err
		},
		"from newline": func() error { e := baseEmail(); e.From = "a@b.c\r\nBcc: x@y.z"; _, err := c.Send(ctx, e); return err },
		"empty batch":  func() error { _, err := c.SendBatch(ctx, nil, nil); return err },
		"big batch":    func() error { _, err := c.SendBatch(ctx, make([]Email, 101), nil); return err },
		"bad batch key": func() error {
			_, err := c.SendBatch(ctx, []Email{baseEmail()}, &BatchOptions{IdempotencyKey: "x"})
			return err
		},
		"bad item key": func() error {
			e := baseEmail()
			e.IdempotencyKey = "x"
			_, err := c.SendBatch(ctx, []Email{e}, nil)
			return err
		},
		"bad item": func() error {
			e := baseEmail()
			e.To = nil
			_, err := c.SendBatch(ctx, []Email{baseEmail(), e}, nil)
			return err
		},
	}
	for name, fn := range cases {
		if err := fn(); !errors.Is(err, ErrInvalidRequest) || !IsValidation(err) {
			t.Fatalf("%s: err = %v", name, err)
		}
	}
	if n := len(f.requests()); n != 0 {
		t.Fatalf("invalid requests reached the server: %d", n)
	}
	// Exactly 8 and 128 characters are valid.
	for _, k := range []string{"12345678", strings.Repeat("k", 128)} {
		e := baseEmail()
		e.IdempotencyKey = k
		if _, err := c.Send(ctx, e); err != nil {
			t.Fatalf("key len %d: %v", len(k), err)
		}
	}
}

func TestURLNormalisation(t *testing.T) {
	good := map[string]string{
		"https://mail.example.com":             "https://mail.example.com/api/v1",
		"https://mail.example.com/":            "https://mail.example.com/api/v1",
		"https://mail.example.com/api/v1":      "https://mail.example.com/api/v1",
		"https://mail.example.com/api/v1/":     "https://mail.example.com/api/v1",
		"  https://mail.example.com:8443/x/ ":  "https://mail.example.com:8443/x/api/v1",
		"http://localhost:8080":                "http://localhost:8080/api/v1",
		"http://127.0.0.1:3000/api/v1":         "http://127.0.0.1:3000/api/v1",
		"http://[::1]:3000":                    "http://[::1]:3000/api/v1",
		"http://api.localhost":                 "http://api.localhost/api/v1",
		"https://mail.example.com/base/api/v1": "https://mail.example.com/base/api/v1",
	}
	for in, want := range good {
		got, err := normalizeURL(in)
		if err != nil || got != want {
			t.Fatalf("%q => %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"", "mail.example.com", "ftp://mail.example.com", "http://mail.example.com", "http://10.0.0.5", "https://user:pw@mail.example.com", "https://mail.example.com?x=1", "https://mail.example.com#f", "https://"} {
		if _, err := normalizeURL(in); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("%q accepted", in)
		}
	}
	if _, err := New(Config{URL: "https://mail.example.com"}); !errors.Is(err, ErrInvalidRequest) {
		t.Fatal("missing API key accepted")
	}
	if _, err := New(Config{URL: "https://mail.example.com", APIKey: "k\r\nX: y"}); !errors.Is(err, ErrInvalidRequest) {
		t.Fatal("API key with line break accepted")
	}
}

func TestNewFromEnv(t *testing.T) {
	f := newFake(t, ok(sendOK))
	t.Setenv("MAILAT_URL", f.srv.URL+"/api/v1/")
	t.Setenv("MAILAT_API_KEY", "env_key")
	t.Setenv("MAILAT_FROM", "env@example.com")
	c, err := NewFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if c.timeout != 30*time.Second || c.maxRetries != 2 {
		t.Fatalf("defaults: timeout=%v retries=%d", c.timeout, c.maxRetries)
	}
	if _, err := c.Send(context.Background(), baseEmail()); err != nil {
		t.Fatal(err)
	}
	r := f.requests()[0]
	if r.Auth != "Bearer env_key" || r.Body["from"] != "env@example.com" || r.Path != "/api/v1/emails" {
		t.Fatalf("request = %+v", r)
	}
	t.Setenv("MAILAT_API_KEY", "")
	if _, err := NewFromEnv(); err == nil {
		t.Fatal("missing env key accepted")
	}
}

func TestCustomHTTPClient(t *testing.T) {
	f := newFake(t, ok(sendOK))
	var used bool
	hc := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		used = true
		return http.DefaultTransport.RoundTrip(r)
	})}
	c := newTestClient(t, f.srv.URL, func(cfg *Config) { cfg.HTTPClient = hc })
	if _, err := c.Send(context.Background(), baseEmail()); err != nil || !used {
		t.Fatalf("err=%v used=%v", err, used)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestParseRetryAfter(t *testing.T) {
	if d := parseRetryAfter("3"); d != 3*time.Second {
		t.Fatal(d)
	}
	if d := parseRetryAfter("9999"); d != maxRetryWait {
		t.Fatal(d)
	}
	if d := parseRetryAfter(time.Now().Add(20 * time.Second).UTC().Format(http.TimeFormat)); d < 15*time.Second || d > 20*time.Second {
		t.Fatal(d)
	}
	for _, v := range []string{"", "soon", "-5"} {
		if d := parseRetryAfter(v); d != 0 {
			t.Fatalf("%q => %v", v, d)
		}
	}
}

func TestNewUUID(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 1000; i++ {
		u := newUUID()
		if !uuidV4.MatchString(u) || seen[u] {
			t.Fatalf("bad or duplicate uuid %q", u)
		}
		seen[u] = true
	}
}

func TestRedirectNotFollowedAndKeyNotLeaked(t *testing.T) {
	var plainHits int
	var mu sync.Mutex
	plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		plainHits++
		mu.Unlock()
		if strings.Contains(r.Header.Get("Authorization"), "ml_test_key") {
			t.Errorf("API key leaked to plaintext server")
		}
		_, _ = io.WriteString(w, `{"code":0,"data":[]}`)
	}))
	t.Cleanup(plain.Close)
	tlsSrv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, plain.URL+r.URL.Path, http.StatusTemporaryRedirect)
	}))
	t.Cleanup(tlsSrv.Close)
	caller := tlsSrv.Client()
	c := newTestClient(t, tlsSrv.URL, func(cfg *Config) { cfg.HTTPClient = caller })
	_, err := c.ListTemplates(context.Background())
	var apiErr *Error
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusTemporaryRedirect {
		t.Fatalf("err = %v, want *Error with status 307", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if plainHits != 0 {
		t.Fatalf("redirect was followed (%d hits on the http server)", plainHits)
	}
	if caller.CheckRedirect != nil {
		t.Fatal("caller's http.Client was mutated")
	}
	if len(c.sleeps) != 0 {
		t.Fatalf("3xx was retried: %v", c.sleeps)
	}
}

func TestDecodeErrorNotRetried(t *testing.T) {
	f := newFake(t, ok(`{"id":123}`)) // id should be a string
	c := newTestClient(t, f.srv.URL)
	_, err := c.Send(context.Background(), baseEmail())
	if err == nil || !strings.Contains(err.Error(), "decode response") {
		t.Fatalf("err = %v", err)
	}
	var je *json.UnmarshalTypeError
	if !errors.As(err, &je) {
		t.Fatalf("decode error does not unwrap to the json error: %v", err)
	}
	if n := len(f.requests()); n != 1 {
		t.Fatalf("decode failure was retried: %d requests", n)
	}
}

func TestAttachmentBlobID(t *testing.T) {
	f := newFake(t, ok(sendOK))
	c := newTestClient(t, f.srv.URL)
	e := baseEmail()
	e.Attachments = []Attachment{{BlobID: "0b6f1d3e-8a2c-4c55-9f1e-2d7b9a4c1e00"}, {Name: "a.txt", Type: "text/plain", Content: "aGk="}}
	if _, err := c.Send(context.Background(), e); err != nil {
		t.Fatal(err)
	}
	atts := f.requests()[0].Body["attachments"].([]any)
	ref := atts[0].(map[string]any)
	if ref["blobId"] != "0b6f1d3e-8a2c-4c55-9f1e-2d7b9a4c1e00" || len(ref) != 1 {
		t.Fatalf("blob attachment = %v", ref)
	}
	inline := atts[1].(map[string]any)
	if inline["content"] != "aGk=" || inline["name"] != "a.txt" {
		t.Fatalf("inline attachment = %v", inline)
	}
	for name, a := range map[string]Attachment{
		"both":    {BlobID: "0b6f1d3e-8a2c-4c55-9f1e-2d7b9a4c1e00", Content: "aGk="},
		"neither": {Name: "x.txt"},
	} {
		e := baseEmail()
		e.Attachments = []Attachment{a}
		if _, err := c.Send(context.Background(), e); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("%s: err = %v", name, err)
		}
	}
	if n := len(f.requests()); n != 1 {
		t.Fatalf("invalid attachments reached the server: %d requests", n)
	}
}
