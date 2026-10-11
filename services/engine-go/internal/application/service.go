package application

import (
	"errors"
	"strings"
	"sync"
	"tts/engine-go/internal/domain/interpretation"
	"tts/engine-go/internal/domain/session"
	"tts/engine-go/internal/domain/stream"
	"tts/engine-go/internal/domain/transcription"
	"tts/engine-go/internal/infrastructure/asr"
	"tts/engine-go/internal/infrastructure/broadcaster"
	"tts/engine-go/internal/infrastructure/storage"
)

type EngineAppService struct {
	repo        *storage.MemoryRepository
	bcast       *broadcaster.Broadcaster
	provider    asr.Provider
	mu          sync.Mutex
	trackers    map[string]*stream.AudioChunkTracker
	sequences   map[string]int
	offsets     map[string]int
}

func NewEngineAppService(repo *storage.MemoryRepository, bcast *broadcaster.Broadcaster, provider asr.Provider) *EngineAppService {
	return &EngineAppService{
		repo:      repo,
		bcast:     bcast,
		provider:  provider,
		trackers:  make(map[string]*stream.AudioChunkTracker),
		sequences: make(map[string]int),
		offsets:   make(map[string]int),
	}
}

func (s *EngineAppService) Broadcaster() *broadcaster.Broadcaster {
	return s.bcast
}

func (s *EngineAppService) CreateSession(title string, cfg session.Config, dev session.DeviceSelection) (*session.Session, error) {
	sess := session.NewSession(title, cfg, dev)
	if err := s.repo.SaveSession(sess); err != nil {
		return nil, err
	}
	return sess, nil
}

func (s *EngineAppService) GetSession(id string) (*session.Session, error) {
	return s.repo.GetSession(id)
}

func (s *EngineAppService) ListSessions() ([]*session.Session, error) {
	return s.repo.ListSessions()
}

func (s *EngineAppService) StartSession(id string) (*session.Session, error) {
	sess, err := s.repo.GetSession(id)
	if err != nil {
		return nil, err
	}
	if err := sess.Start(); err != nil {
		return nil, err
	}
	_ = s.repo.SaveSession(sess)
	s.bcast.Broadcast(id, "session.status_changed", map[string]interface{}{
		"id":     id,
		"status": "live",
	})
	return sess, nil
}

func (s *EngineAppService) StopSession(id string) (*session.Session, error) {
	sess, err := s.repo.GetSession(id)
	if err != nil {
		return nil, err
	}
	if err := sess.Complete(); err != nil {
		return nil, err
	}
	_ = s.repo.SaveSession(sess)

	s.mu.Lock()
	delete(s.trackers, id)
	delete(s.sequences, id)
	delete(s.offsets, id)
	s.mu.Unlock()

	s.bcast.Broadcast(id, "session.status_changed", map[string]interface{}{
		"id":     id,
		"status": "completed",
	})
	return sess, nil
}

func (s *EngineAppService) nextSequence(sessionID string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	curr := s.sequences[sessionID]
	next := curr + 1
	s.sequences[sessionID] = next
	return next
}

func (s *EngineAppService) nextTiming(sessionID string, wordCount int) (int, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	currOffset := s.offsets[sessionID]
	startMs, endMs, nextOffset := transcription.CalculateTiming(currOffset, wordCount)
	s.offsets[sessionID] = nextOffset
	return startMs, endMs
}

func (s *EngineAppService) IngestText(sessionID string, text string, srcLang string, targets []string) (*transcription.TranscriptSegment, error) {
	sess, err := s.repo.GetSession(sessionID)
	if err != nil {
		return nil, err
	}
	if !sess.IsLive() {
		if err := sess.Start(); err == nil {
			_ = s.repo.SaveSession(sess)
			s.bcast.Broadcast(sessionID, "session.status_changed", map[string]interface{}{
				"id":     sessionID,
				"status": "live",
			})
		}
	}

	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return nil, errors.New("text is empty")
	}

	actualSrcLang := interpretation.ResolveSourceLanguage(srcLang, trimmed, "en")
	words := strings.Fields(trimmed)
	startMs, endMs := s.nextTiming(sessionID, len(words))
	seq := s.nextSequence(sessionID)

	segment := transcription.NewSegment(sessionID, seq, transcription.StatusFinal, trimmed, actualSrcLang, s.provider.Name(), startMs, endMs)
	if err := s.repo.SaveSegment(segment); err != nil {
		return nil, err
	}

	s.bcast.Broadcast(sessionID, "segment.upserted", segment)

	// Translation handling with domain rule "当前语种默认不转译"
	if len(targets) == 0 {
		targets = []string{"zh-CN"}
	}

	for _, target := range targets {
		if !interpretation.ShouldTranslate(actualSrcLang, target, sess.Config.SuppressSameLanguageTranslation) {
			continue
		}
		transText := asr.MockTranslate(trimmed, target)
		tr := &interpretation.Translation{
			SegmentID:      segment.SegmentID,
			TargetLanguage: target,
			Text:           transText,
			Provider:       "mock-translate",
			IsFinal:        true,
		}
		_ = s.repo.SaveTranslation(tr)
		s.bcast.Broadcast(sessionID, "translation.upserted", tr)
	}

	return segment, nil
}

func (s *EngineAppService) IngestAudioChunk(sessionID string, meta stream.AudioChunkMetadata, body []byte) (*stream.AudioChunkAck, error) {
	sess, err := s.repo.GetSession(sessionID)
	if err != nil {
		return nil, err
	}
	if !sess.IsLive() {
		if err := sess.Start(); err == nil {
			_ = s.repo.SaveSession(sess)
			s.bcast.Broadcast(sessionID, "session.status_changed", map[string]interface{}{
				"id":     sessionID,
				"status": "live",
			})
		}
	}

	s.mu.Lock()
	tracker, ok := s.trackers[sessionID]
	if !ok {
		tracker = stream.NewAudioChunkTracker(sessionID)
		s.trackers[sessionID] = tracker
	}
	s.mu.Unlock()

	ack, err := tracker.RecordChunk(meta, len(body))
	if err != nil {
		return nil, err
	}

	if meta.TranscriptHint != nil && *meta.TranscriptHint != "" && meta.IsFinalChunk {
		seg, err := s.IngestText(sessionID, *meta.TranscriptHint, meta.SourceLanguage, meta.TargetLanguages)
		if err == nil && seg != nil {
			ack.TranscriptAccepted = true
		}
	}

	return ack, nil
}

func (s *EngineAppService) BuildReplay(sessionID string) (map[string]interface{}, error) {
	sess, err := s.repo.GetSession(sessionID)
	if err != nil {
		return nil, err
	}
	segments, _ := s.repo.GetSegments(sessionID)
	translations, _ := s.repo.GetTranslations(sessionID)
	summary, _ := s.repo.GetSummary(sessionID)

	return map[string]interface{}{
		"session":      sess,
		"segments":     segments,
		"translations": translations,
		"summary":      summary,
	}, nil
}
