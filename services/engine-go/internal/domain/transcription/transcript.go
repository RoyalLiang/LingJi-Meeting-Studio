package transcription

import (
	"crypto/rand"
	"encoding/hex"
	"math"
	"strings"
	"time"
)

type SegmentStatus string

const (
	StatusPartial SegmentStatus = "partial"
	StatusFinal   SegmentStatus = "final"
)

type TranscriptSegment struct {
	SegmentID      string        `json:"segmentId"`
	SessionID      string        `json:"sessionId"`
	Sequence       int           `json:"sequence"`
	Status         SegmentStatus `json:"status"`
	SourceLanguage string        `json:"sourceLanguage"`
	StartMs        int           `json:"startMs"`
	EndMs          int           `json:"endMs"`
	Text           string        `json:"text"`
	Confidence     *float64      `json:"confidence,omitempty"`
	SpeakerID      *string       `json:"speakerId,omitempty"`
	Provider       string        `json:"provider"`
	GlossaryHits   []string      `json:"glossaryHits"`
	ReceivedAt     time.Time     `json:"receivedAt"`
}

func generateSegmentID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func NewSegment(sessionID string, seq int, status SegmentStatus, text, srcLang, provider string, startMs, endMs int) *TranscriptSegment {
	return &TranscriptSegment{
		SegmentID:      generateSegmentID(),
		SessionID:      sessionID,
		Sequence:       seq,
		Status:         status,
		SourceLanguage: srcLang,
		StartMs:        startMs,
		EndMs:          endMs,
		Text:           text,
		Provider:       provider,
		GlossaryHits:   []string{},
		ReceivedAt:     time.Now().UTC(),
	}
}

type DraftEvent struct {
	Text   string        `json:"text"`
	Status SegmentStatus `json:"status"`
}

func ProgressiveDraftEvents(prevText, nextText string, status SegmentStatus) []DraftEvent {
	normNext := strings.TrimSpace(nextText)
	if normNext == "" {
		return nil
	}

	normPrev := strings.TrimSpace(prevText)
	alignedPrev := ""
	if strings.HasPrefix(normNext, normPrev) {
		alignedPrev = normPrev
	}

	if status == StatusFinal && alignedPrev == normNext {
		return []DraftEvent{{Text: normNext, Status: StatusFinal}}
	}

	startIdx := len(alignedPrev)
	deltaLen := len(normNext) - startIdx
	if deltaLen <= 0 {
		return nil
	}

	step := int(math.Max(1, math.Ceil(float64(deltaLen)/4.0)))
	var events []DraftEvent

	for cursor := startIdx + step; cursor < len(normNext); cursor += step {
		events = append(events, DraftEvent{
			Text:   normNext[:cursor],
			Status: StatusPartial,
		})
	}

	finalStatus := StatusPartial
	if status == StatusFinal {
		finalStatus = StatusFinal
	}
	events = append(events, DraftEvent{
		Text:   normNext,
		Status: finalStatus,
	})

	return events
}

func CalculateTiming(currentOffsetMs int, wordCount int) (startMs, endMs, nextOffsetMs int) {
	startMs = currentOffsetMs
	duration := int(math.Max(900, float64(wordCount*260)))
	endMs = startMs + duration
	nextOffsetMs = endMs + 280
	return startMs, endMs, nextOffsetMs
}
