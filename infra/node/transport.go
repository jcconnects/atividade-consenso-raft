package main

import (
	"io"
	"time"

	"github.com/hashicorp/raft"
)

// wrapTransport wraps a raft.Transport so every outgoing RPC produces a
// "rpc_send" event on the bus. Incoming responses produce companion events.
// This is what makes AppendEntries / RequestVote visible on the dashboard.
func wrapTransport(inner raft.Transport, nodeID string, bus *eventBus) raft.Transport {
	return &observingTransport{inner: inner, nodeID: nodeID, bus: bus}
}

type observingTransport struct {
	inner  raft.Transport
	nodeID string
	bus    *eventBus
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
	t.bus.publish(event{
		Type:    "rpc_send",
		Node:    t.nodeID,
		From:    t.nodeID,
		To:      string(id),
		RPC:     "AppendEntries",
		Term:    args.Term,
		PrevIdx: args.PrevLogEntry,
		Entries: len(args.Entries),
	})
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
		})
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
	return t.inner.AppendEntriesPipeline(id, target)
}

// suppress unused
var _ = time.Second
