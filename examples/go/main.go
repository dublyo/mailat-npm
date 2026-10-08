// Command example is a small HTTP server that sends a receipt and receives
// Mailat webhooks.
//
//	MAILAT_URL=https://mail.example.com MAILAT_API_KEY=ue_... \
//	MAILAT_FROM=noreply@example.com MAILAT_WEBHOOK_SECRET=... go run .
package main

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"time"

	mailat "github.com/dublyo/mailat-npm/go"
)

func main() {
	client, err := mailat.NewFromEnv()
	if err != nil {
		log.Fatal(err)
	}
	secret := os.Getenv("MAILAT_WEBHOOK_SECRET")

	mux := http.NewServeMux()

	mux.HandleFunc("POST /orders/{id}/receipt", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Email string `json:"email"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&in); err != nil || in.Email == "" {
			http.Error(w, "email is required", http.StatusBadRequest)
			return
		}
		id := r.PathValue("id")
		res, err := client.Send(r.Context(), mailat.Email{
			To:             []string{in.Email},
			Subject:        "Receipt for order " + id,
			Text:           "Thanks for your order " + id + ".",
			Tags:           []string{"receipt"},
			IdempotencyKey: "receipt-" + id, // a retried request never sends twice
		})
		var apiErr *mailat.Error
		switch {
		case err == nil:
			_ = json.NewEncoder(w).Encode(map[string]string{"id": res.ID, "status": res.Status})
		case mailat.IsValidation(err):
			http.Error(w, err.Error(), http.StatusBadRequest)
		case errors.As(err, &apiErr):
			log.Printf("mailat: status=%d code=%d %s", apiErr.Status, apiErr.Code, apiErr.Message)
			http.Error(w, "could not send email", http.StatusBadGateway)
		default:
			log.Printf("mailat: %v", err)
			http.Error(w, "could not send email", http.StatusBadGateway)
		}
	})

	mux.HandleFunc("POST /webhooks/mailat", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		ev, err := mailat.VerifyWebhook(body, r.Header.Get(mailat.SignatureHeader), secret, 5*time.Minute)
		if err != nil {
			http.Error(w, "invalid signature", http.StatusUnauthorized)
			return
		}
		switch ev.Type {
		case mailat.EventEmailBounced, mailat.EventEmailComplained:
			// Mailat already suppresses these addresses. Bounce/complaint events
			// carry no "to": use messageUuid (client.GetEmail) for transactional
			// mail, or "recipient" for campaign mail.
			log.Printf("%s: message %v recipient %v (event %s)", ev.Type, ev.Data["messageUuid"], ev.Data["recipient"], ev.ID)
		case mailat.EventEmailReceived:
			log.Printf("reply from %v: %v", ev.Data["from"], ev.Data["subject"])
		}
		w.WriteHeader(http.StatusNoContent)
	})

	log.Fatal(http.ListenAndServe(":8080", mux))
}
