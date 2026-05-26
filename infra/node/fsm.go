package main

import (
	"encoding/json"
	"fmt"
	"io"
	"sync"

	"github.com/hashicorp/raft"
)

type CommandType string

const (
	CmdPut CommandType = "PUT"
	CmdDel CommandType = "DEL"
)

type Command struct {
	Type  CommandType `json:"type"`
	Key   string      `json:"key"`
	Value string      `json:"value,omitempty"`
}

// kvFSM is the replicated state machine. Plain in-memory map; persistence
// is provided by Raft's log + snapshots.
type kvFSM struct {
	mu     sync.RWMutex
	store  map[string]string
	bus    *eventBus
	nodeID string
}

func newKVFSM(bus *eventBus, nodeID string) *kvFSM {
	return &kvFSM{
		store:  make(map[string]string),
		bus:    bus,
		nodeID: nodeID,
	}
}

func (f *kvFSM) Apply(l *raft.Log) interface{} {
	var cmd Command
	if err := json.Unmarshal(l.Data, &cmd); err != nil {
		return fmt.Errorf("decode command: %w", err)
	}

	f.mu.Lock()
	switch cmd.Type {
	case CmdPut:
		f.store[cmd.Key] = cmd.Value
	case CmdDel:
		delete(f.store, cmd.Key)
	}
	f.mu.Unlock()

	f.bus.publish(event{
		Type:    "apply",
		Node:    f.nodeID,
		Index:   l.Index,
		Term:    l.Term,
		Command: string(cmd.Type),
		Key:     cmd.Key,
		Value:   cmd.Value,
	})

	return nil
}

func (f *kvFSM) Snapshot() (raft.FSMSnapshot, error) {
	f.mu.RLock()
	defer f.mu.RUnlock()
	snap := make(map[string]string, len(f.store))
	for k, v := range f.store {
		snap[k] = v
	}
	return &kvSnapshot{state: snap}, nil
}

func (f *kvFSM) Restore(r io.ReadCloser) error {
	defer r.Close()
	var snap map[string]string
	if err := json.NewDecoder(r).Decode(&snap); err != nil {
		return err
	}
	f.mu.Lock()
	f.store = snap
	f.mu.Unlock()
	return nil
}

func (f *kvFSM) get(key string) (string, bool) {
	f.mu.RLock()
	defer f.mu.RUnlock()
	v, ok := f.store[key]
	return v, ok
}

func (f *kvFSM) all() map[string]string {
	f.mu.RLock()
	defer f.mu.RUnlock()
	out := make(map[string]string, len(f.store))
	for k, v := range f.store {
		out[k] = v
	}
	return out
}

type kvSnapshot struct {
	state map[string]string
}

func (s *kvSnapshot) Persist(sink raft.SnapshotSink) error {
	if err := json.NewEncoder(sink).Encode(s.state); err != nil {
		sink.Cancel()
		return err
	}
	return sink.Close()
}

func (s *kvSnapshot) Release() {}
