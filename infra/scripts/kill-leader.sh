#!/usr/bin/env bash
# Identifies the current Raft leader by querying each node's /status endpoint
# and stops its container. The cluster should re-elect within a few seconds.
set -euo pipefail

NODES=(node1 node2 node3)
HOST_PORTS=(9001 9002 9003)

leader=""
for i in "${!NODES[@]}"; do
  port="${HOST_PORTS[$i]}"
  node="${NODES[$i]}"
  resp=$(curl -sf "http://localhost:${port}/status" 2>/dev/null || true)
  if [ -z "$resp" ]; then
    continue
  fi
  role=$(echo "$resp" | grep -o '"role":"[^"]*"' | cut -d'"' -f4 || true)
  if [ "$role" = "leader" ]; then
    leader="$node"
    break
  fi
done

if [ -z "$leader" ]; then
  echo "no leader currently visible — cluster may be in election" >&2
  exit 1
fi

echo "killing leader: $leader"
docker stop "$leader"
