package storage

import (
	"errors"
	"sort"
	"sync"
	"tts/engine-go/internal/domain/interpretation"
	"tts/engine-go/internal/domain/knowledge"
	"tts/engine-go/internal/domain/session"
	"tts/engine-go/internal/domain/transcription"
)

var ErrNotFound = errors.New("entity not found")

type MemoryRepository struct {
	mu           sync.RWMutex
	sessions     map[string]*session.Session
	segments     map[string][]*transcription.TranscriptSegment
	translations map[string][]*interpretation.Translation
	summaries    map[string]*knowledge.SessionSummary
}

func NewMemoryRepository() *MemoryRepository {
	return &MemoryRepository{
		sessions:     make(map[string]*session.Session),
		segments:     make(map[string][]*transcription.TranscriptSegment),
		translations: make(map[string][]*interpretation.Translation),
		summaries:    make(map[string]*knowledge.SessionSummary),
	}
}

func (r *MemoryRepository) SaveSession(s *session.Session) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sessions[s.ID] = s
	return nil
}

func (r *MemoryRepository) GetSession(id string) (*session.Session, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	s, ok := r.sessions[id]
	if !ok {
		return nil, ErrNotFound
	}
	return s, nil
}

func (r *MemoryRepository) ListSessions() ([]*session.Session, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	list := make([]*session.Session, 0, len(r.sessions))
	for _, s := range r.sessions {
		list = append(list, s)
	}
	sort.Slice(list, func(i, j int) bool {
		return list[i].CreatedAt.After(list[j].CreatedAt)
	})
	return list, nil
}

func (r *MemoryRepository) SaveSegment(seg *transcription.TranscriptSegment) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	list := r.segments[seg.SessionID]
	// upsert by segmentId
	found := false
	for i, existing := range list {
		if existing.SegmentID == seg.SegmentID {
			list[i] = seg
			found = true
			break
		}
	}
	if !found {
		list = append(list, seg)
	}
	r.segments[seg.SessionID] = list
	return nil
}

func (r *MemoryRepository) GetSegments(sessionID string) ([]*transcription.TranscriptSegment, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	list, ok := r.segments[sessionID]
	if !ok {
		return []*transcription.TranscriptSegment{}, nil
	}
	res := make([]*transcription.TranscriptSegment, len(list))
	copy(res, list)
	sort.Slice(res, func(i, j int) bool {
		return res[i].Sequence < res[j].Sequence
	})
	return res, nil
}

func (r *MemoryRepository) SaveTranslation(trans *interpretation.Translation) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	// find sessionID from segment
	var targetSessionID string
	for sid, segs := range r.segments {
		for _, seg := range segs {
			if seg.SegmentID == trans.SegmentID {
				targetSessionID = sid
				break
			}
		}
		if targetSessionID != "" {
			break
		}
	}
	if targetSessionID == "" {
		targetSessionID = "unknown"
	}

	list := r.translations[targetSessionID]
	found := false
	for i, existing := range list {
		if existing.SegmentID == trans.SegmentID && existing.TargetLanguage == trans.TargetLanguage {
			list[i] = trans
			found = true
			break
		}
	}
	if !found {
		list = append(list, trans)
	}
	r.translations[targetSessionID] = list
	return nil
}

func (r *MemoryRepository) GetTranslations(sessionID string) ([]*interpretation.Translation, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	list, ok := r.translations[sessionID]
	if !ok {
		return []*interpretation.Translation{}, nil
	}
	res := make([]*interpretation.Translation, len(list))
	copy(res, list)
	return res, nil
}

func (r *MemoryRepository) SaveSummary(sum *knowledge.SessionSummary) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.summaries[sum.SessionID] = sum
	return nil
}

func (r *MemoryRepository) GetSummary(sessionID string) (*knowledge.SessionSummary, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	sum, ok := r.summaries[sessionID]
	if !ok {
		return nil, ErrNotFound
	}
	return sum, nil
}
