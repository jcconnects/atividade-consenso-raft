#!/usr/bin/env bash
# Isolates a node (or set of nodes) by disconnecting it from the cluster
# network. The container keeps running but cannot exchange RPCs.
#
# Usage: ./partition.sh node1 [node2 ...]
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <node> [node ...]" >&2
  exit 1
fi

NETWORK="atividade-consenso-raft_rede-raft"

for node in "$@"; do
  echo "disconnecting $node from $NETWORK"
  docker network disconnect "$NETWORK" "$node" || true
done
