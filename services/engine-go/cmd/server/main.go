package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"tts/engine-go/internal/application"
	"tts/engine-go/internal/infrastructure/asr"
	"tts/engine-go/internal/infrastructure/broadcaster"
	"tts/engine-go/internal/infrastructure/storage"
	api "tts/engine-go/internal/interfaces/http"
)

func main() {
	port := flag.Int("port", 3010, "Port to listen on")
	host := flag.String("host", "127.0.0.1", "Host to bind to")
	flag.Parse()

	repo := storage.NewMemoryRepository()
	bcast := broadcaster.NewBroadcaster()
	provider := asr.NewMockProvider()
	svc := application.NewEngineAppService(repo, bcast, provider)
	handler := api.NewHandler(svc)

	addr := fmt.Sprintf("%s:%d", *host, *port)
	log.Printf("[engine-go] listening on http://%s (DDD Go Core Engine)", addr)
	if err := http.ListenAndServe(addr, handler); err != nil {
		log.Fatalf("[engine-go] server fatal error: %v", err)
	}
}
