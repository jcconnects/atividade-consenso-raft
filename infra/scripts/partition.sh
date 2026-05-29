#!/usr/bin/env bash
# Isolates a node (or set of nodes) from the rest of the cluster by dropping
# Raft RPC traffic (TCP port 7000) via iptables. The container keeps running
# and remains reachable on its event stream (port 8100), so the dashboard
# still sees the node — only its Raft communication is severed. This mirrors
# the broker's /partition endpoint so behavior is identical whether the
# partition is triggered from the dashboard or from the shell.
#
# Usage: ./partition.sh <isolated-node> [other-isolated-nodes ...]
#   ./partition.sh node1                 # isolate node1 from {node2, node3}
#   ./partition.sh node1 node2           # isolate {node1, node2} from {node3}
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <node> [node ...]" >&2
  exit 1
fi

RAFT_PORT="${RAFT_PORT:-7000}"
ALL_NODES=(node1 node2 node3 node4 node5)

ISOLATED=("$@")

# Build the "other side" set: every existing container that wasn't named.
OTHERS=()
for candidate in "${ALL_NODES[@]}"; do
  if ! docker inspect "$candidate" >/dev/null 2>&1; then
    continue
  fi
  skip=false
  for iso in "${ISOLATED[@]}"; do
    if [ "$candidate" = "$iso" ]; then
      skip=true
      break
    fi
  done
  if [ "$skip" = false ]; then
    OTHERS+=("$candidate")
  fi
done

if [ "${#OTHERS[@]}" -eq 0 ]; then
  echo "no peers left on the other side of the partition" >&2
  exit 1
fi

node_ip() {
  docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$1"
}

drop() {
  local node="$1" peer_ip="$2"
  docker exec "$node" iptables -I OUTPUT -d "$peer_ip" \
    -p tcp --dport "$RAFT_PORT" -j DROP 2>/dev/null || true
  docker exec "$node" iptables -I INPUT  -s "$peer_ip" \
    -p tcp --sport "$RAFT_PORT" -j DROP 2>/dev/null || true
}

for iso in "${ISOLATED[@]}"; do
  iso_ip="$(node_ip "$iso")"
  for other in "${OTHERS[@]}"; do
    other_ip="$(node_ip "$other")"
    echo "blocking $iso <-> $other (port $RAFT_PORT)"
    drop "$iso" "$other_ip"
    drop "$other" "$iso_ip"
  done
done

echo "partition active"
