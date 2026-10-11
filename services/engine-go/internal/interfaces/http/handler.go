package http

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
	"tts/engine-go/internal/application"
	"tts/engine-go/internal/domain/session"
	"tts/engine-go/internal/domain/stream"
)

type Handler struct {
	svc *application.EngineAppService
}

func NewHandler(svc *application.EngineAppService) *Handler {
	return &Handler{svc: svc}
}

func setCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, x-audio-chunk-id, x-audio-sequence, x-audio-encoding, x-audio-sample-rate, x-audio-channels, x-audio-duration-ms, x-audio-final, x-source-language, x-target-languages, x-transcript-hint")
}

func sendJSON(w http.ResponseWriter, status int, data interface{}) {
	setCORS(w)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	setCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	path := r.URL.Path

	if r.Method == http.MethodGet && path == "/health" {
		sendJSON(w, http.StatusOK, map[string]interface{}{
			"ok":          true,
			"service":     "engine-go",
			"runtime":     "go",
			"asrProvider": "mock",
		})
		return
	}

	if r.Method == http.MethodGet && path == "/sessions" {
		sessions, err := h.svc.ListSessions()
		if err != nil {
			sendJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		sendJSON(w, http.StatusOK, map[string]interface{}{"sessions": sessions})
		return
	}

	if r.Method == http.MethodPost && path == "/sessions" {
		var req struct {
			Title           string                  `json:"title"`
			Config          session.Config          `json:"config"`
			DeviceSelection session.DeviceSelection `json:"deviceSelection"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		sess, err := h.svc.CreateSession(req.Title, req.Config, req.DeviceSelection)
		if err != nil {
			sendJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		sendJSON(w, http.StatusCreated, sess)
		return
	}

	// Dynamic session routes
	if strings.HasPrefix(path, "/sessions/") {
		parts := strings.Split(strings.TrimPrefix(path, "/sessions/"), "/")
		sessionID := parts[0]

		if len(parts) == 1 {
			if r.Method == http.MethodGet {
				sess, err := h.svc.GetSession(sessionID)
				if err != nil {
					sendJSON(w, http.StatusNotFound, map[string]string{"error": "session_not_found"})
					return
				}
				sendJSON(w, http.StatusOK, sess)
				return
			}
		}

		if len(parts) == 2 {
			sub := parts[1]

			if r.Method == http.MethodPost && sub == "start" {
				sess, err := h.svc.StartSession(sessionID)
				if err != nil {
					sendJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
					return
				}
				sendJSON(w, http.StatusOK, sess)
				return
			}

			if r.Method == http.MethodPost && sub == "stop" {
				sess, err := h.svc.StopSession(sessionID)
				if err != nil {
					sendJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
					return
				}
				sendJSON(w, http.StatusOK, sess)
				return
			}

			if r.Method == http.MethodGet && sub == "stream" {
				h.handleStream(w, r, sessionID)
				return
			}

			if r.Method == http.MethodPost && sub == "ingest-text" {
				var req struct {
					Text            string   `json:"text"`
					SourceLanguage  string   `json:"sourceLanguage"`
					TargetLanguages []string `json:"targetLanguages"`
				}
				if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
					sendJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
					return
				}
				seg, err := h.svc.IngestText(sessionID, req.Text, req.SourceLanguage, req.TargetLanguages)
				if err != nil {
					sendJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
					return
				}
				sendJSON(w, http.StatusAccepted, map[string]interface{}{
					"accepted":  true,
					"sessionId": sessionID,
					"segmentId": seg.SegmentID,
					"sequence":  seg.Sequence,
				})
				return
			}

			if r.Method == http.MethodPost && sub == "audio-chunks" {
				h.handleAudioChunks(w, r, sessionID)
				return
			}

			if r.Method == http.MethodGet && sub == "replay" {
				replay, err := h.svc.BuildReplay(sessionID)
				if err != nil {
					sendJSON(w, http.StatusNotFound, map[string]string{"error": "session_not_found"})
					return
				}
				sendJSON(w, http.StatusOK, replay)
				return
			}
		}
	}

	sendJSON(w, http.StatusNotFound, map[string]string{"error": "not_found"})
}

func (h *Handler) handleStream(w http.ResponseWriter, r *http.Request, sessionID string) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	_, _ = fmt.Fprintf(w, ": connected\n\n")
	flusher.Flush()

	ch := h.svc.Broadcaster().Subscribe(sessionID)
	defer h.svc.Broadcaster().Unsubscribe(sessionID, ch)

	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			_, _ = fmt.Fprintf(w, ": keep-alive\n\n")
			flusher.Flush()
		case msg, ok := <-ch:
			if !ok {
				return
			}
			_, _ = fmt.Fprintf(w, "data: %s\n\n", string(msg))
			flusher.Flush()
		}
	}
}

func (h *Handler) handleAudioChunks(w http.ResponseWriter, r *http.Request, sessionID string) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		sendJSON(w, http.StatusBadRequest, map[string]string{"error": "failed_read_body"})
		return
	}

	seq, _ := strconv.Atoi(r.Header.Get("x-audio-sequence"))
	sampleRate, _ := strconv.Atoi(r.Header.Get("x-audio-sample-rate"))
	if sampleRate == 0 {
		sampleRate = 16000
	}
	channels, _ := strconv.Atoi(r.Header.Get("x-audio-channels"))
	if channels == 0 {
		channels = 1
	}
	isFinal := r.Header.Get("x-audio-final") == "true" || r.Header.Get("x-audio-final") == "1"

	var dur *int
	if durStr := r.Header.Get("x-audio-duration-ms"); durStr != "" {
		if d, err := strconv.Atoi(durStr); err == nil {
			dur = &d
		}
	}

	var hint *string
	if hStr := r.Header.Get("x-transcript-hint"); hStr != "" {
		hint = &hStr
	}

	var targetLangs []string
	if tg := r.Header.Get("x-target-languages"); tg != "" {
		targetLangs = strings.Split(tg, ",")
	}

	meta := stream.AudioChunkMetadata{
		ChunkID:         r.Header.Get("x-audio-chunk-id"),
		SessionID:       sessionID,
		Sequence:        seq,
		Encoding:        r.Header.Get("x-audio-encoding"),
		SampleRateHz:    sampleRate,
		Channels:        channels,
		ByteLength:      len(body),
		DurationMs:      dur,
		SourceLanguage:  r.Header.Get("x-source-language"),
		TargetLanguages: targetLangs,
		TranscriptHint:  hint,
		IsFinalChunk:    isFinal,
		ReceivedAt:      time.Now().UTC(),
	}

	ack, err := h.svc.IngestAudioChunk(sessionID, meta, body)
	if err != nil {
		statusCode := http.StatusBadRequest
		if err == stream.ErrSequenceConflict {
			statusCode = http.StatusConflict
		}
		sendJSON(w, statusCode, map[string]string{
			"error":  "invalid_audio_sequence",
			"detail": err.Error(),
		})
		return
	}

	sendJSON(w, http.StatusAccepted, ack)
}
