package broadcaster

import (
	"encoding/json"
	"sync"
	"time"
)

type EventEnvelope struct {
	Type      string      `json:"type"`
	SessionID string      `json:"sessionId"`
	EmittedAt time.Time   `json:"emittedAt"`
	Payload   interface{} `json:"payload"`
}

type Broadcaster struct {
	mu          sync.RWMutex
	subscribers map[string]map[chan []byte]struct{}
}

func NewBroadcaster() *Broadcaster {
	return &Broadcaster{
		subscribers: make(map[string]map[chan []byte]struct{}),
	}
}

func (b *Broadcaster) Subscribe(sessionID string) chan []byte {
	b.mu.Lock()
	defer b.mu.Unlock()

	ch := make(chan []byte, 64)
	if _, ok := b.subscribers[sessionID]; !ok {
		b.subscribers[sessionID] = make(map[chan []byte]struct{})
	}
	b.subscribers[sessionID][ch] = struct{}{}
	return ch
}

func (b *Broadcaster) Unsubscribe(sessionID string, ch chan []byte) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if subs, ok := b.subscribers[sessionID]; ok {
		delete(subs, ch)
		close(ch)
		if len(subs) == 0 {
			delete(b.subscribers, sessionID)
		}
	}
}

func (b *Broadcaster) Broadcast(sessionID string, eventType string, payload interface{}) {
	b.mu.RLock()
	subs, ok := b.subscribers[sessionID]
	if !ok || len(subs) == 0 {
		b.mu.RUnlock()
		return
	}

	env := EventEnvelope{
		Type:      eventType,
		SessionID: sessionID,
		EmittedAt: time.Now().UTC(),
		Payload:   payload,
	}
	data, err := json.Marshal(env)
	if err != nil {
		b.mu.RUnlock()
		return
	}

	for ch := range subs {
		select {
		case ch <- data:
		default:
			// dropped if client buffer full
		}
	}
	b.mu.RUnlock()
}
