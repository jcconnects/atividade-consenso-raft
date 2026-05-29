package main

import (
	"encoding/json"
	"io"

	"github.com/hashicorp/raft"
)

// emitLogEntries decodes each Raft log entry in an outgoing AppendEntries
// request and publishes a `log_entry` event per entry. The event carries the
// destination follower in `To`, so the dashboard can populate that follower's
// log column even when it never saw the corresponding FSM `apply` event
// (e.g., during catch-up after a revive, when entries flow before the SSE
// client reconnects, or on the leader side before commit).
func emitLogEntries(bus *eventBus, leaderID, peerID string, entries []*raft.Log) {
	for _, l := range entries {
		if l.Type != raft.LogCommand {
			continue
		}
		var cmd Command
		if err := json.Unmarshal(l.Data, &cmd); err != nil {
			continue
		}
		bus.publish(event{
			Type:    "log_entry",
			Node:    leaderID,
			From:    leaderID,
			To:      peerID,
			Index:   l.Index,
			Term:    l.Term,
			Command: string(cmd.Type),
			Key:     cmd.Key,
			Value:   cmd.Value,
		})
	}
}

// wrapTransport wraps a raft.Transport so every outgoing RPC produces a
// "rpc_send" event on the bus. Incoming responses produce companion events.
// This is what makes AppendEntries / RequestVote visible on the dashboard.
// The tracker observes successful AppendEntriesResp to estimate per-peer
// match_index for the `replication` event emitted by publishReplication.
func wrapTransport(inner raft.Transport, nodeID string, bus *eventBus, tracker *replicationTracker) raft.Transport {
	return &observingTransport{inner: inner, nodeID: nodeID, bus: bus, tracker: tracker}
}

type observingTransport struct {
	inner   raft.Transport
	nodeID  string
	bus     *eventBus
	tracker *replicationTracker
}

func (t *observingTransport) Consumer() <-chan raft.RPC { return t.inner.Consumer() }
func (t *observingTransport) LocalAddr() raft.ServerAddress { return t.inner.LocalAddr() }
func (t *observingTransport) EncodePeer(id raft.ServerID, addr raft.ServerAddress) []byte {
	return t.inner.EncodePeer(id, addr)
}
func (t *observingTransport) DecodePeer(b []byte) raft.ServerAddress { return t.inner.DecodePeer(b) }
func (t *observingTransport) SetHeartbeatHandler(cb func(rpc raft.RPC)) {
	t.inner.SetHeartbeatHandler(cb)
}
func (t *observingTransport) TimeoutNow(id raft.ServerID, target raft.ServerAddress, args *raft.TimeoutNowRequest, resp *raft.TimeoutNowResponse) error {
	return t.inner.TimeoutNow(id, target, args, resp)
}

func (t *observingTransport) AppendEntries(id raft.ServerID, target raft.ServerAddress, args *raft.AppendEntriesRequest, resp *raft.AppendEntriesResponse) error {
	highIdx := args.PrevLogEntry + uint64(len(args.Entries))
	t.bus.publish(event{
		Type:    "rpc_send",
		Node:    t.nodeID,
		From:    t.nodeID,
		To:      string(id),
		RPC:     "AppendEntries",
		Term:    args.Term,
		PrevIdx: args.PrevLogEntry,
		Entries: len(args.Entries),
		Index:   highIdx,
	})
	emitLogEntries(t.bus, t.nodeID, string(id), args.Entries)
	err := t.inner.AppendEntries(id, target, args, resp)
	if err == nil {
		t.bus.publish(event{
			Type:    "rpc_resp",
			Node:    t.nodeID,
			From:    string(id),
			To:      t.nodeID,
			RPC:     "AppendEntriesResp",
			Term:    resp.Term,
			Success: resp.Success,
			// Tag the response with the request's payload size so the dashboard
			// can tell a heartbeat-ack from a real replication-ack.
			Entries: len(args.Entries),
			Index:   highIdx,
		})
		if resp.Success && t.tracker != nil {
			t.tracker.observe(string(id), highIdx)
		}
	}
	return err
}

func (t *observingTransport) RequestVote(id raft.ServerID, target raft.ServerAddress, args *raft.RequestVoteRequest, resp *raft.RequestVoteResponse) error {
	t.bus.publish(event{
		Type: "rpc_send",
		Node: t.nodeID,
		From: t.nodeID,
		To:   string(id),
		RPC:  "RequestVote",
		Term: args.Term,
	})
	err := t.inner.RequestVote(id, target, args, resp)
	if err == nil {
		t.bus.publish(event{
			Type:    "rpc_resp",
			Node:    t.nodeID,
			From:    string(id),
			To:      t.nodeID,
			RPC:     "RequestVoteResp",
			Term:    resp.Term,
			Granted: resp.Granted,
		})
	}
	return err
}

func (t *observingTransport) InstallSnapshot(id raft.ServerID, target raft.ServerAddress, args *raft.InstallSnapshotRequest, resp *raft.InstallSnapshotResponse, data io.Reader) error {
	t.bus.publish(event{
		Type: "rpc_send",
		Node: t.nodeID,
		From: t.nodeID,
		To:   string(id),
		RPC:  "InstallSnapshot",
		Term: args.Term,
	})
	return t.inner.InstallSnapshot(id, target, args, resp, data)
}

func (t *observingTransport) AppendEntriesPipeline(id raft.ServerID, target raft.ServerAddress) (raft.AppendPipeline, error) {
	// hashicorp/raft uses a pipeline transport for streaming AppendEntries to
	// followers; those calls bypass the AppendEntries method above. Wrap the
	// returned pipeline so log-replication RPCs also show up on the bus.
	inner, err := t.inner.AppendEntriesPipeline(id, target)
	if err != nil {
		return inner, err
	}
	p := &observingPipeline{
		inner:    inner,
		nodeID:   t.nodeID,
		peerID:   string(id),
		bus:      t.bus,
		tracker:  t.tracker,
		consumer: make(chan raft.AppendFuture, 128),
	}
	// Bridge: read finished futures from the inner pipeline, emit the response
	// event with the request's entry count, then forward the inner future to
	// the consumer so the raft library can process it normally.
	go func() {
		for fut := range inner.Consumer() {
			entries := 0
			var highIdx uint64
			if req := fut.Request(); req != nil {
				entries = len(req.Entries)
				highIdx = req.PrevLogEntry + uint64(entries)
			}
			if resp := fut.Response(); resp != nil && fut.Error() == nil {
				t.bus.publish(event{
					Type:    "rpc_resp",
					Node:    p.nodeID,
					From:    p.peerID,
					To:      p.nodeID,
					RPC:     "AppendEntriesResp",
					Term:    resp.Term,
					Success: resp.Success,
					Entries: entries,
					Index:   highIdx,
				})
				if resp.Success && p.tracker != nil {
					p.tracker.observe(p.peerID, highIdx)
				}
			}
			p.consumer <- fut
		}
		close(p.consumer)
	}()
	return p, nil
}

type observingPipeline struct {
	inner    raft.AppendPipeline
	nodeID   string
	peerID   string
	bus      *eventBus
	tracker  *replicationTracker
	consumer chan raft.AppendFuture
}

func (p *observingPipeline) AppendEntries(args *raft.AppendEntriesRequest, resp *raft.AppendEntriesResponse) (raft.AppendFuture, error) {
	highIdx := args.PrevLogEntry + uint64(len(args.Entries))
	p.bus.publish(event{
		Type:    "rpc_send",
		Node:    p.nodeID,
		From:    p.nodeID,
		To:      p.peerID,
		RPC:     "AppendEntries",
		Term:    args.Term,
		PrevIdx: args.PrevLogEntry,
		Entries: len(args.Entries),
		Index:   highIdx,
	})
	emitLogEntries(p.bus, p.nodeID, p.peerID, args.Entries)
	return p.inner.AppendEntries(args, resp)
}

func (p *observingPipeline) Consumer() <-chan raft.AppendFuture { return p.consumer }
func (p *observingPipeline) Close() error                       { return p.inner.Close() }
