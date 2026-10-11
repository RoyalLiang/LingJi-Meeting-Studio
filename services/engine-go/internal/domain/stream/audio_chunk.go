package stream

import (
	"errors"
	"fmt"
	"sync"
	"time"
)

const (
	MaxAudioChunkBytes      = 1024 * 1024
	MaxTranscriptHintChars = 4000
)

var (
	ErrInvalidSequence      = errors.New("x-audio-sequence must be greater than or equal to 1")
	ErrSequenceConflict     = errors.New("x-audio-sequence must be strictly increasing within a session")
	ErrInvalidSampleRate    = errors.New("x-audio-sample-rate must be between 8000 and 192000")
	ErrInvalidChannels      = errors.New("x-audio-channels must be between 1 and 8")
	ErrChunkTooLarge        = fmt.Errorf("audio chunk exceeds %d bytes", MaxAudioChunkBytes)
	ErrEmptyChunk           = errors.New("audio chunk body cannot be empty unless it is a finalization chunk")
	ErrTranscriptHintLength = fmt.Errorf("x-transcript-hint must be shorter than %d characters", MaxTranscriptHintChars)
)

type AudioChunkMetadata struct {
	ChunkID         string    `json:"chunkId"`
	SessionID       string    `json:"sessionId"`
	Sequence        int       `json:"sequence"`
	Encoding        string    `json:"encoding"`
	SampleRateHz    int       `json:"sampleRateHz"`
	Channels        int       `json:"channels"`
	ByteLength      int       `json:"byteLength"`
	DurationMs      *int      `json:"durationMs,omitempty"`
	SourceLanguage  string    `json:"sourceLanguage"`
	TargetLanguages []string  `json:"targetLanguages"`
	TranscriptHint  *string   `json:"transcriptHint,omitempty"`
	IsFinalChunk    bool      `json:"isFinalChunk"`
	ReceivedAt      time.Time `json:"receivedAt"`
}

type AudioChunkAck struct {
	Accepted            bool   `json:"accepted"`
	SessionID           string `json:"sessionId"`
	ChunkID             string `json:"chunkId"`
	Sequence            int    `json:"sequence"`
	ByteLength          int    `json:"byteLength"`
	TotalChunksReceived int    `json:"totalChunksReceived"`
	TotalBytesReceived  int    `json:"totalBytesReceived"`
	TranscriptAccepted  bool   `json:"transcriptAccepted"`
}

type AudioChunkTracker struct {
	mu                  sync.Mutex
	sessionID           string
	totalChunksReceived int
	totalBytesReceived  int
	lastSequence        int
}

func NewAudioChunkTracker(sessionID string) *AudioChunkTracker {
	return &AudioChunkTracker{
		sessionID: sessionID,
	}
}

func (t *AudioChunkTracker) RecordChunk(meta AudioChunkMetadata, bodyLen int) (*AudioChunkAck, error) {
	t.mu.Lock()
	defer t.mu.Unlock()

	if meta.Sequence < 1 {
		return nil, ErrInvalidSequence
	}
	if meta.SampleRateHz < 8000 || meta.SampleRateHz > 192000 {
		return nil, ErrInvalidSampleRate
	}
	if meta.Channels < 1 || meta.Channels > 8 {
		return nil, ErrInvalidChannels
	}
	if bodyLen > MaxAudioChunkBytes {
		return nil, ErrChunkTooLarge
	}
	if bodyLen == 0 && !meta.IsFinalChunk {
		return nil, ErrEmptyChunk
	}
	if meta.TranscriptHint != nil && len(*meta.TranscriptHint) > MaxTranscriptHintChars {
		return nil, ErrTranscriptHintLength
	}
	if t.lastSequence > 0 && meta.Sequence <= t.lastSequence {
		return nil, ErrSequenceConflict
	}

	t.totalChunksReceived++
	t.totalBytesReceived += bodyLen
	t.lastSequence = meta.Sequence

	return &AudioChunkAck{
		Accepted:            true,
		SessionID:           t.sessionID,
		ChunkID:             meta.ChunkID,
		Sequence:            meta.Sequence,
		ByteLength:          bodyLen,
		TotalChunksReceived: t.totalChunksReceived,
		TotalBytesReceived:  t.totalBytesReceived,
		TranscriptAccepted:  false,
	}, nil
}

func (t *AudioChunkTracker) Stats() (totalChunks int, totalBytes int, lastSeq int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.totalChunksReceived, t.totalBytesReceived, t.lastSequence
}
