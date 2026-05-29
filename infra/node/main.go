package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/hashicorp/raft"
	boltdb "github.com/hashicorp/raft-boltdb/v2"
)

func main() {
	nodeID := flag.String("id", envOr("NODE_ID", "node1"), "node identifier")
	raftAddr := flag.String("raft-addr", envOr("RAFT_ADDR", "0.0.0.0:7000"), "raft bind address")
	httpAddr := flag.String("http-addr", envOr("HTTP_ADDR", "0.0.0.0:9000"), "HTTP API bind address")
	eventAddr := flag.String("event-addr", envOr("EVENT_ADDR", "0.0.0.0:8100"), "event stream bind address")
	dataDir := flag.String("data-dir", envOr("DATA_DIR", "/data"), "data directory")
	peersFlag := flag.String("peers", os.Getenv("RAFT_PEERS"), "comma-separated id=addr peers (includes self)")
	bootstrap := flag.Bool("bootstrap", envBool("RAFT_BOOTSTRAP", false), "bootstrap cluster from this node")
	heartbeatMs := flag.Int("heartbeat-ms", envInt("RAFT_HEARTBEAT_MS", 5000), "Raft heartbeat interval (ms); election timeout = 2× this")
	flag.Parse()

	if err := os.MkdirAll(*dataDir, 0o755); err != nil {
		log.Fatalf("create data dir: %v", err)
	}

	bus := newEventBus()
	go bus.serve(*eventAddr)

	// Timeouts derive from a single HEARTBEAT_MS parameter to keep all
	// observable timing proportional (see infra/dashboard/docs/TEMPO.md).
	hb := time.Duration(*heartbeatMs) * time.Millisecond
	cfg := raft.DefaultConfig()
	cfg.LocalID = raft.ServerID(*nodeID)
	cfg.LogLevel = "INFO"
	cfg.HeartbeatTimeout = hb
	cfg.ElectionTimeout = 2 * hb
	cfg.LeaderLeaseTimeout = hb
	cfg.CommitTimeout = hb / 5

	logStore, err := boltdb.NewBoltStore(filepath.Join(*dataDir, "raft-log.bolt"))
	if err != nil {
		log.Fatalf("create log store: %v", err)
	}
	stableStore, err := boltdb.NewBoltStore(filepath.Join(*dataDir, "raft-stable.bolt"))
	if err != nil {
		log.Fatalf("create stable store: %v", err)
	}
	snapshots, err := raft.NewFileSnapshotStore(*dataDir, 2, os.Stderr)
	if err != nil {
		log.Fatalf("create snapshot store: %v", err)
	}

	advertise, err := resolveAdvertise(*nodeID, *raftAddr, *peersFlag)
	if err != nil {
		log.Fatalf("resolve advertise addr: %v", err)
	}
	addr, err := raft.NewTCPTransportWithLogger(*raftAddr, advertise, 3, 10*time.Second, nil)
	if err != nil {
		log.Fatalf("create transport: %v", err)
	}
	tracker := newReplicationTracker()
	transport := wrapTransport(addr, *nodeID, bus, tracker)

	fsm := newKVFSM(bus, *nodeID)

	r, err := raft.NewRaft(cfg, fsm, logStore, stableStore, snapshots, transport)
	if err != nil {
		log.Fatalf("create raft: %v", err)
	}

	if *bootstrap {
		servers := parsePeers(*peersFlag)
		if len(servers) == 0 {
			log.Fatalf("bootstrap requires non-empty peers list")
		}
		future := r.BootstrapCluster(raft.Configuration{Servers: servers})
		if err := future.Error(); err != nil && err != raft.ErrCantBootstrap {
			log.Fatalf("bootstrap: %v", err)
		}
	}

	registerObserver(r, *nodeID, bus)
	go pollState(r, *nodeID, bus, uint64(*heartbeatMs))
	go publishReplication(r, *nodeID, bus, tracker)

	api := newHTTPAPI(r, fsm, logStore, *nodeID)
	log.Printf("[%s] HTTP API listening on %s", *nodeID, *httpAddr)
	log.Printf("[%s] raft transport listening on %s", *nodeID, *raftAddr)
	log.Printf("[%s] event stream listening on %s", *nodeID, *eventAddr)
	if err := http.ListenAndServe(*httpAddr, api); err != nil {
		log.Fatalf("http: %v", err)
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envBool(key string, def bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return def
	}
	return b
}

func envInt(key string, def int) int {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

// resolveAdvertise picks the host:port this node should advertise to peers.
// It looks up our own ID in the peers list. If the bind address has a wildcard
// host (0.0.0.0 or empty), the peer entry tells the cluster where to reach us.
func resolveAdvertise(nodeID, raftAddr, peers string) (net.Addr, error) {
	for _, item := range strings.Split(peers, ",") {
		item = strings.TrimSpace(item)
		parts := strings.SplitN(item, "=", 2)
		if len(parts) != 2 || parts[0] != nodeID {
			continue
		}
		return net.ResolveTCPAddr("tcp", parts[1])
	}
	return net.ResolveTCPAddr("tcp", raftAddr)
}

// parsePeers parses "id1=host1:port1,id2=host2:port2" into raft Server entries.
func parsePeers(s string) []raft.Server {
	var out []raft.Server
	for _, item := range strings.Split(s, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		parts := strings.SplitN(item, "=", 2)
		if len(parts) != 2 {
			continue
		}
		out = append(out, raft.Server{
			ID:      raft.ServerID(parts[0]),
			Address: raft.ServerAddress(parts[1]),
		})
	}
	return out
}

// pollState publishes periodic state snapshots so the dashboard can recover
// from missed events and so commit_idx changes are reflected even when no
// observer event fires.
func pollState(r *raft.Raft, nodeID string, bus *eventBus, heartbeatMs uint64) {
	tick := time.NewTicker(500 * time.Millisecond)
	defer tick.Stop()
	for range tick.C {
		stats := r.Stats()
		bus.publish(event{
			Type:        "state",
			Node:        nodeID,
			Role:        strings.ToLower(stats["state"]),
			Term:        atoiOr(stats["term"]),
			CommitIndex: atoiOr(stats["commit_index"]),
			LastLogIdx:  atoiOr(stats["last_log_index"]),
			LastApplied: atoiOr(stats["applied_index"]),
			HeartbeatMs: heartbeatMs,
		})
	}
}

func atoiOr(s string) uint64 {
	n, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		return 0
	}
	return n
}

// unused import guard
var _ = fmt.Sprintf
