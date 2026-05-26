package main

import (
	"strings"

	"github.com/hashicorp/raft"
)

// registerObserver subscribes to raft.Observation events and re-publishes
// them through the event bus so the dashboard can render them.
func registerObserver(r *raft.Raft, nodeID string, bus *eventBus) {
	ch := make(chan raft.Observation, 64)
	obs := raft.NewObserver(ch, false, nil)
	r.RegisterObserver(obs)

	go func() {
		for o := range ch {
			switch d := o.Data.(type) {
			case raft.RaftState:
				bus.publish(event{
					Type: "role_change",
					Node: nodeID,
					Role: strings.ToLower(d.String()),
				})
			case raft.LeaderObservation:
				bus.publish(event{
					Type: "leader_change",
					Node: nodeID,
					To:   string(d.LeaderID),
				})
			case raft.PeerObservation:
				bus.publish(event{
					Type: "peer_change",
					Node: nodeID,
					To:   string(d.Peer.ID),
				})
			case raft.RequestVoteRequest:
				bus.publish(event{
					Type: "rpc_recv",
					Node: nodeID,
					From: string(d.RPCHeader.ID),
					RPC:  "RequestVote",
					Term: d.Term,
				})
			}
		}
	}()
}
