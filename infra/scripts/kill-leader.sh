#!/usr/bin/env bash
# Identifies the current Raft leader by querying each node's /status endpoint
# and stops its container. The cluster should re-elect within a few seconds.
set -euo pipefail

declare -A PORTS=([node1]=9001 [node2]=9002 [node3]=9003 [node4]=9004 [node5]=9005)

leader=""
for node in "${!PORTS[@]}"; do
  port="${PORTS[$node]}"
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
