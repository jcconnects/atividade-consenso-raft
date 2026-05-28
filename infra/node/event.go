package main

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"
)

type event struct {
	T           float64 `json:"t"`
	Type        string  `json:"type"`
	Node        string  `json:"node,omitempty"`
	Role        string  `json:"role,omitempty"`
	Term        uint64  `json:"term,omitempty"`
	CommitIndex uint64  `json:"commit_idx,omitempty"`
	LastLogIdx  uint64  `json:"last_log_idx,omitempty"`
	LastApplied uint64  `json:"last_applied,omitempty"`
	HeartbeatMs uint64  `json:"heartbeat_ms,omitempty"`
	From        string  `json:"from,omitempty"`
	To          string  `json:"to,omitempty"`
	RPC         string  `json:"rpc,omitempty"`
	PrevIdx     uint64  `json:"prev_idx,omitempty"`
	Entries     int     `json:"entries,omitempty"`
	Success     bool    `json:"success,omitempty"`
	Granted     bool    `json:"granted,omitempty"`
	Index       uint64  `json:"index,omitempty"`
	Command     string  `json:"command,omitempty"`
	Key         string  `json:"key,omitempty"`
	Value       string  `json:"value,omitempty"`
}

type subscriber chan event

type eventBus struct {
	mu     sync.Mutex
	subs   map[subscriber]struct{}
	start  time.Time
}

func newEventBus() *eventBus {
	return &eventBus{
		subs:  make(map[subscriber]struct{}),
		start: time.Now(),
	}
}

func (b *eventBus) publish(e event) {
	e.T = time.Since(b.start).Seconds()
	b.mu.Lock()
	defer b.mu.Unlock()
	for s := range b.subs {
		select {
		case s <- e:
		default:
			// drop on slow consumers
		}
	}
}

func (b *eventBus) subscribe() subscriber {
	s := make(subscriber, 256)
	b.mu.Lock()
	b.subs[s] = struct{}{}
	b.mu.Unlock()
	return s
}

func (b *eventBus) unsubscribe(s subscriber) {
	b.mu.Lock()
	delete(b.subs, s)
	b.mu.Unlock()
	close(s)
}

// serve exposes the event stream as Server-Sent Events on /events.
func (b *eventBus) serve(addr string) {
	mux := http.NewServeMux()
	mux.HandleFunc("/events", b.handleSSE)
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	log.Printf("event bus serving on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Printf("event bus exit: %v", err)
	}
}

func (b *eventBus) handleSSE(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	sub := b.subscribe()
	defer b.unsubscribe(sub)

	notify := r.Context().Done()
	enc := json.NewEncoder(w)
	for {
		select {
		case <-notify:
			return
		case e := <-sub:
			w.Write([]byte("data: "))
			if err := enc.Encode(e); err != nil {
				return
			}
			w.Write([]byte("\n"))
			flusher.Flush()
		}
	}
}
