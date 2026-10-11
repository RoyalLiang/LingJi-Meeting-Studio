package knowledge

import "time"

type ActionItem struct {
	ID         string   `json:"id"`
	Text       string   `json:"text"`
	Owner      *string  `json:"owner,omitempty"`
	DueDate    *string  `json:"dueDate,omitempty"`
	SegmentIDs []string `json:"segmentIds"`
}

type Topic struct {
	Title      string   `json:"title"`
	SegmentIDs []string `json:"segmentIds"`
}

type SessionSummary struct {
	SessionID   string       `json:"sessionId"`
	Summary     string       `json:"summary"`
	Topics      []Topic      `json:"topics"`
	ActionItems []ActionItem `json:"actionItems"`
	GeneratedAt time.Time    `json:"generatedAt"`
}
