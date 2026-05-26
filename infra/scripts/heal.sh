#!/usr/bin/env bash
# Restores full connectivity: starts any stopped node containers and
# reconnects them to the cluster network.
set -euo pipefail

NETWORK="atividade-consenso-raft_rede-raft"
NODES=(node1 node2 node3 node4 node5)

for node in "${NODES[@]}"; do
  # If the container doesn't exist (e.g., 5-node mode not enabled), skip silently.
  if ! docker inspect "$node" >/dev/null 2>&1; then
    continue
  fi
  echo "reconnecting $node to $NETWORK"
  docker network connect "$NETWORK" "$node" 2>/dev/null || true
  docker start "$node" >/dev/null 2>&1 || true
done
echo "heal complete"
