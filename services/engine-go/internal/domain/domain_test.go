package domain_test

import (
	"testing"
	"tts/engine-go/internal/domain/interpretation"
	"tts/engine-go/internal/domain/session"
	"tts/engine-go/internal/domain/stream"
	"tts/engine-go/internal/domain/transcription"
)

func TestSessionLifecycle(t *testing.T) {
	s := session.NewSession("Test Session", session.Config{
		SourceLanguage: "auto",
	}, session.DeviceSelection{
		SourceKind: "microphone",
	})

	if s.Status != session.StatusCreated {
		t.Fatalf("expected created, got %s", s.Status)
	}

	if err := s.Start(); err != nil {
		t.Fatalf("unexpected error starting: %v", err)
	}
	if s.Status != session.StatusLive {
		t.Fatalf("expected live, got %s", s.Status)
	}

	if err := s.Complete(); err != nil {
		t.Fatalf("unexpected error completing: %v", err)
	}
	if s.Status != session.StatusCompleted {
		t.Fatalf("expected completed, got %s", s.Status)
	}

	if err := s.Start(); err == nil {
		t.Fatalf("expected error restarting completed session")
	}
}

func TestAudioChunkTracker(t *testing.T) {
	tracker := stream.NewAudioChunkTracker("sess-go-test")

	ack, err := tracker.RecordChunk(stream.AudioChunkMetadata{
		ChunkID:      "c1",
		Sequence:     1,
		SampleRateHz: 16000,
		Channels:     1,
	}, 100)

	if err != nil || !ack.Accepted {
		t.Fatalf("expected accepted chunk 1, got err: %v", err)
	}

	// Duplicate or lower sequence must fail
	_, err = tracker.RecordChunk(stream.AudioChunkMetadata{
		ChunkID:      "c1-dup",
		Sequence:     1,
		SampleRateHz: 16000,
		Channels:     1,
	}, 100)

	if err != stream.ErrSequenceConflict {
		t.Fatalf("expected sequence conflict error, got: %v", err)
	}
}

func TestLanguageRules(t *testing.T) {
	if interpretation.DetectLanguageFromText("你好世界") != "zh" {
		t.Fatalf("expected zh")
	}
	if interpretation.DetectLanguageFromText("Hello world") != "en" {
		t.Fatalf("expected en")
	}
	if interpretation.DetectLanguageFromText("こんにちは") != "ja" {
		t.Fatalf("expected ja")
	}

	// "当前语种默认不转译"
	if interpretation.ShouldTranslate("zh", "zh-CN", true) {
		t.Fatalf("expected same language to be suppressed when switch enabled")
	}
	if !interpretation.ShouldTranslate("en", "zh-CN", true) {
		t.Fatalf("expected cross language to be translated")
	}
}

func TestTranscriptDrafts(t *testing.T) {
	drafts := transcription.ProgressiveDraftEvents("hello", "hello world roadmap", transcription.StatusFinal)
	if len(drafts) == 0 {
		t.Fatalf("expected progressive drafts")
	}
	if drafts[len(drafts)-1].Status != transcription.StatusFinal {
		t.Fatalf("expected last event to be final")
	}
}
