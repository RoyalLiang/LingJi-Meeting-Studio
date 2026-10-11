package asr

import (
	"fmt"
	"strings"
	"tts/engine-go/internal/domain/transcription"
)

type Provider interface {
	Name() string
	TranscribeText(text string, srcLang string) ([]transcription.DraftEvent, error)
}

type MockProvider struct{}

func NewMockProvider() *MockProvider {
	return &MockProvider{}
}

func (m *MockProvider) Name() string {
	return "mock"
}

func (m *MockProvider) TranscribeText(text string, srcLang string) ([]transcription.DraftEvent, error) {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return nil, fmt.Errorf("empty text")
	}
	// Emit progressive drafts
	events := transcription.ProgressiveDraftEvents("", trimmed, transcription.StatusFinal)
	return events, nil
}

var mockDict = map[string]string{
	"hello":       "你好",
	"roadmap":     "路线图",
	"action":      "行动项",
	"meeting":     "会议",
	"transcript":  "转录",
	"translation": "翻译",
	"customer":    "客户",
	"launch":      "上线",
	"summary":     "摘要",
}

func MockTranslate(text, targetLanguage string) string {
	if targetLanguage != "zh-CN" && targetLanguage != "zh" {
		return fmt.Sprintf("[%s] %s", targetLanguage, text)
	}

	tokens := strings.Fields(text)
	var translated []string
	for _, tok := range tokens {
		norm := strings.ToLower(strings.Trim(tok, ",.!?\"'"))
		if val, ok := mockDict[norm]; ok {
			translated = append(translated, val)
		} else {
			translated = append(translated, tok)
		}
	}
	return fmt.Sprintf("[%s] %s", targetLanguage, strings.Join(translated, " "))
}
