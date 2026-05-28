#!/usr/bin/env bash
# Restores full connectivity: starts any stopped node containers and flushes
# the iptables rules that the partition.sh / broker /partition endpoint may
# have installed. Mirrors the broker's /heal endpoint.
set -euo pipefail

NODES=(node1 node2 node3 node4 node5)

for node in "${NODES[@]}"; do
  if ! docker inspect "$node" >/dev/null 2>&1; then
    continue
  fi
  docker start "$node" >/dev/null 2>&1 || true
  docker exec "$node" iptables -F INPUT  2>/dev/null || true
  docker exec "$node" iptables -F OUTPUT 2>/dev/null || true
  echo "healed $node"
done
echo "heal complete"
