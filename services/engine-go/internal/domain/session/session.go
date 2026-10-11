package session

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strings"
	"time"
)

type Status string

const (
	StatusCreated    Status = "created"
	StatusConnecting Status = "connecting"
	StatusLive       Status = "live"
	StatusStopping   Status = "stopping"
	StatusCompleted  Status = "completed"
	StatusFailed     Status = "failed"
)

type Config struct {
	SourceLanguage                  string   `json:"sourceLanguage"`
	TargetLanguages                 []string `json:"targetLanguages"`
	EnableAudioStorage              bool     `json:"enableAudioStorage"`
	EnableLiveShare                 bool     `json:"enableLiveShare"`
	SuppressSameLanguageTranslation bool     `json:"suppressSameLanguageTranslation"`
	GlossaryIDs                     []string `json:"glossaryIds"`
	ReferenceDocIDs                 []string `json:"referenceDocumentIds"`
}

type DeviceSelection struct {
	SourceKind         string  `json:"sourceKind"`
	MicrophoneDeviceID *string `json:"microphoneDeviceId,omitempty"`
	SystemDeviceID     *string `json:"systemDeviceId,omitempty"`
}

type Session struct {
	ID              string          `json:"id"`
	WorkspaceID     string          `json:"workspaceId"`
	FolderID        *string         `json:"folderId,omitempty"`
	Title           string          `json:"title"`
	Status          Status          `json:"status"`
	DeviceSelection DeviceSelection `json:"deviceSelection"`
	Config          Config          `json:"config"`
	CreatedAt       time.Time       `json:"createdAt"`
	StartedAt       *time.Time      `json:"startedAt,omitempty"`
	EndedAt         *time.Time      `json:"endedAt,omitempty"`
}

func generateID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func NewSession(title string, cfg Config, devices DeviceSelection) *Session {
	trimmed := strings.TrimSpace(title)
	if trimmed == "" {
		trimmed = "Untitled Session"
	}
	if cfg.SourceLanguage == "" {
		cfg.SourceLanguage = "auto"
	}
	if len(cfg.TargetLanguages) == 0 {
		cfg.TargetLanguages = []string{"zh-CN"}
	}
	if devices.SourceKind == "" {
		devices.SourceKind = "microphone"
	}

	return &Session{
		ID:              generateID(),
		WorkspaceID:     "default-workspace",
		Title:           trimmed,
		Status:          StatusCreated,
		DeviceSelection: devices,
		Config:          cfg,
		CreatedAt:       time.Now().UTC(),
	}
}

func (s *Session) IsLive() bool {
	return s.Status == StatusLive
}

func (s *Session) IsTerminated() bool {
	return s.Status == StatusCompleted || s.Status == StatusFailed
}

func (s *Session) Start() error {
	if s.IsTerminated() {
		return errors.New("cannot start session: already terminated")
	}
	s.Status = StatusLive
	if s.StartedAt == nil {
		now := time.Now().UTC()
		s.StartedAt = &now
	}
	return nil
}

func (s *Session) Complete() error {
	s.Status = StatusCompleted
	if s.EndedAt == nil {
		now := time.Now().UTC()
		s.EndedAt = &now
	}
	return nil
}

func (s *Session) Fail(reason string) error {
	s.Status = StatusFailed
	if s.EndedAt == nil {
		now := time.Now().UTC()
		s.EndedAt = &now
	}
	return nil
}

func (s *Session) Rename(newTitle string) error {
	trimmed := strings.TrimSpace(newTitle)
	if trimmed == "" {
		return errors.New("session title cannot be empty")
	}
	s.Title = trimmed
	return nil
}

func (s *Session) MoveToFolder(folderID *string) {
	s.FolderID = folderID
}

func (s *Session) UpdateConfig(cfg Config) {
	if cfg.SourceLanguage != "" {
		s.Config.SourceLanguage = cfg.SourceLanguage
	}
	if len(cfg.TargetLanguages) > 0 {
		s.Config.TargetLanguages = cfg.TargetLanguages
	}
	s.Config.EnableAudioStorage = cfg.EnableAudioStorage
	s.Config.EnableLiveShare = cfg.EnableLiveShare
	s.Config.SuppressSameLanguageTranslation = cfg.SuppressSameLanguageTranslation
	if cfg.GlossaryIDs != nil {
		s.Config.GlossaryIDs = cfg.GlossaryIDs
	}
	if cfg.ReferenceDocIDs != nil {
		s.Config.ReferenceDocIDs = cfg.ReferenceDocIDs
	}
}
