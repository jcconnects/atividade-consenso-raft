package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/hashicorp/raft"
)

type httpAPI struct {
	mux      *http.ServeMux
	raft     *raft.Raft
	fsm      *kvFSM
	logStore raft.LogStore
	nodeID   string
}

func newHTTPAPI(r *raft.Raft, fsm *kvFSM, logStore raft.LogStore, nodeID string) *httpAPI {
	a := &httpAPI{
		mux:      http.NewServeMux(),
		raft:     r,
		fsm:      fsm,
		logStore: logStore,
		nodeID:   nodeID,
	}
	a.mux.HandleFunc("/put", a.handlePut)
	a.mux.HandleFunc("/delete", a.handleDelete)
	a.mux.HandleFunc("/get", a.handleGet)
	a.mux.HandleFunc("/status", a.handleStatus)
	a.mux.HandleFunc("/log", a.handleLog)
	a.mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	return a
}

func (a *httpAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	a.mux.ServeHTTP(w, r)
}

type kvRequest struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

func (a *httpAPI) handlePut(w http.ResponseWriter, r *http.Request) {
	var req kvRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if req.Key == "" {
		http.Error(w, "key required", http.StatusBadRequest)
		return
	}
	a.submit(w, Command{Type: CmdPut, Key: req.Key, Value: req.Value})
}

func (a *httpAPI) handleDelete(w http.ResponseWriter, r *http.Request) {
	var req kvRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if req.Key == "" {
		http.Error(w, "key required", http.StatusBadRequest)
		return
	}
	a.submit(w, Command{Type: CmdDel, Key: req.Key})
}

func (a *httpAPI) handleGet(w http.ResponseWriter, r *http.Request) {
	key := r.URL.Query().Get("key")
	if key == "" {
		http.Error(w, "key required", http.StatusBadRequest)
		return
	}
	v, ok := a.fsm.get(key)
	resp := map[string]any{"key": key, "value": v, "exists": ok, "from": a.nodeID}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func (a *httpAPI) handleStatus(w http.ResponseWriter, r *http.Request) {
	stats := a.raft.Stats()
	leaderAddr, leaderID := a.raft.LeaderWithID()
	out := map[string]any{
		"node":         a.nodeID,
		"role":         strings.ToLower(stats["state"]),
		"term":         atoiOr(stats["term"]),
		"commit_idx":   atoiOr(stats["commit_index"]),
		"last_log_idx": atoiOr(stats["last_log_index"]),
		"leader_id":    string(leaderID),
		"leader_addr":  string(leaderAddr),
		"store":        a.fsm.all(),
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

func (a *httpAPI) submit(w http.ResponseWriter, cmd Command) {
	if a.raft.State() != raft.Leader {
		_, leaderID := a.raft.LeaderWithID()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]any{
			"error":     "not leader",
			"leader_id": string(leaderID),
			"node":      a.nodeID,
		})
		return
	}
	data, err := json.Marshal(cmd)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	future := a.raft.Apply(data, 5*time.Second)
	if err := future.Error(); err != nil {
		http.Error(w, fmt.Sprintf("apply: %v", err), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"ok":    true,
		"index": future.Index(),
	})
}

// handleLog returns the local Raft log decoded as KV commands. The dashboard
// fetches this on (re)connect to seed its log matrix, so entries replicated
// silently (catch-up after revive, or follower-side reconciliation after a
// partition heal) are visible even when the corresponding `apply` and
// `log_entry` events were missed.
func (a *httpAPI) handleLog(w http.ResponseWriter, r *http.Request) {
	first, err := a.logStore.FirstIndex()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	last, err := a.logStore.LastIndex()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	type entry struct {
		Index   uint64 `json:"index"`
		Term    uint64 `json:"term"`
		Command string `json:"command"`
		Key     string `json:"key"`
		Value   string `json:"value,omitempty"`
	}
	out := []entry{}
	var rec raft.Log
	for i := first; i <= last && i != 0; i++ {
		if err := a.logStore.GetLog(i, &rec); err != nil {
			continue
		}
		if rec.Type != raft.LogCommand {
			continue
		}
		var cmd Command
		if err := json.Unmarshal(rec.Data, &cmd); err != nil {
			continue
		}
		out = append(out, entry{
			Index:   rec.Index,
			Term:    rec.Term,
			Command: string(cmd.Type),
			Key:     cmd.Key,
			Value:   cmd.Value,
		})
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"node":    a.nodeID,
		"first":   first,
		"last":    last,
		"entries": out,
	})
}

// avoid unused import in some builds
var _ = strconv.Itoa
