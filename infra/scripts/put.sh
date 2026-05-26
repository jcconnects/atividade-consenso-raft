#!/usr/bin/env bash
# Submits a PUT to a specific node's HTTP API. If the node is not the leader,
# the response will indicate which node is the current leader.
#
# Usage: ./put.sh <node> <key> <value>
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <node> <key> <value>" >&2
  exit 1
fi

declare -A PORTS=([node1]=9001 [node2]=9002 [node3]=9003 [node4]=9004 [node5]=9005)
node="$1"
key="$2"
value="$3"

port="${PORTS[$node]:-}"
if [ -z "$port" ]; then
  echo "unknown node: $node" >&2
  exit 1
fi

curl -s -X POST "http://localhost:${port}/put" \
  -H "Content-Type: application/json" \
  -d "{\"key\":\"${key}\",\"value\":\"${value}\"}"
echo
