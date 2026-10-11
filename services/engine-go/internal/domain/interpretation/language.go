package interpretation

import (
	"regexp"
	"strings"
)

var (
	reJa = regexp.MustCompile(`[\x{3040}-\x{30ff}]`)
	reKo = regexp.MustCompile(`[\x{ac00}-\x{d7af}]`)
	reRu = regexp.MustCompile(`[\x{0400}-\x{04ff}]`)
	reAr = regexp.MustCompile(`[\x{0600}-\x{06ff}]`)
	reHi = regexp.MustCompile(`[\x{0900}-\x{097f}]`)
	reZh = regexp.MustCompile(`[\x{4e00}-\x{9fff}]`)
	reEn = regexp.MustCompile(`[A-Za-z]`)
)

func DetectLanguageFromText(text string) string {
	sample := strings.TrimSpace(text)
	if sample == "" {
		return ""
	}
	if reJa.MatchString(sample) {
		return "ja"
	}
	if reKo.MatchString(sample) {
		return "ko"
	}
	if reRu.MatchString(sample) {
		return "ru"
	}
	if reAr.MatchString(sample) {
		return "ar"
	}
	if reHi.MatchString(sample) {
		return "hi"
	}
	if reZh.MatchString(sample) {
		return "zh"
	}
	if reEn.MatchString(sample) {
		return "en"
	}
	return ""
}

func ResolveSourceLanguage(requested string, text string, fallback string) string {
	if fallback == "" {
		fallback = "en"
	}
	norm := strings.TrimSpace(requested)
	if norm != "" && norm != "auto" {
		return norm
	}
	detected := DetectLanguageFromText(text)
	if detected != "" {
		return detected
	}
	return fallback
}

func IsSameLanguage(langA, langB string) bool {
	if langA == "" || langB == "" {
		return false
	}
	baseA := strings.ToLower(strings.Split(langA, "-")[0])
	baseB := strings.ToLower(strings.Split(langB, "-")[0])
	return baseA == baseB
}

func ShouldTranslate(sourceLang, targetLang string, suppressSameLanguage bool) bool {
	if suppressSameLanguage && IsSameLanguage(sourceLang, targetLang) {
		return false
	}
	return true
}

type Translation struct {
	SegmentID      string `json:"segmentId"`
	TargetLanguage string `json:"targetLanguage"`
	Text           string `json:"text"`
	Provider       string `json:"provider"`
	IsFinal        bool   `json:"isFinal"`
}
