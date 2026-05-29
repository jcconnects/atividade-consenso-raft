package main

import (
	"sync"
	"time"

	"github.com/hashicorp/raft"
)

// replicationTracker stores, per peer, the highest (prev_idx + entries) for
// which a successful AppendEntriesResp was observed. This is the leader's
// best estimate of each follower's match_index — hashicorp/raft does not
// expose followerReplication.nextIndex publicly, so we reconstruct it from
// observed RPC traffic.
type replicationTracker struct {
	mu    sync.Mutex
	match map[string]uint64
}

func newReplicationTracker() *replicationTracker {
	return &replicationTracker{match: make(map[string]uint64)}
}

// observe records a successful AppendEntries acknowledgement against `peer`
// covering up to (and including) index `highIdx` (= prev_idx + len(entries)).
// Only monotonic increases are accepted, so an out-of-order ack does not
// regress the tracked match index.
func (t *replicationTracker) observe(peer string, highIdx uint64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if highIdx > t.match[peer] {
		t.match[peer] = highIdx
	}
}

// snapshot returns a copy of the current match-index map.
func (t *replicationTracker) snapshot() map[string]uint64 {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make(map[string]uint64, len(t.match))
	for k, v := range t.match {
		out[k] = v
	}
	return out
}

// publishReplication runs in the background and, while this node is the
// leader, emits one `replication` event per peer every 500ms. Followers go
// silent — the dashboard infers their absence and clears stale entries.
func publishReplication(r *raft.Raft, nodeID string, bus *eventBus, tracker *replicationTracker) {
	tick := time.NewTicker(500 * time.Millisecond)
	defer tick.Stop()
	for range tick.C {
		if r.State() != raft.Leader {
			continue
		}
		for peer, idx := range tracker.snapshot() {
			bus.publish(event{
				Type:  "replication",
				Node:  nodeID,
				To:    peer,
				Index: idx,
			})
		}
	}
}
