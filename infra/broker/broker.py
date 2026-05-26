"""Control broker: translates dashboard button clicks into docker + raft actions.

Endpoints (POST):
  /kill-leader     query each node /status, find leader, docker stop it
  /kill-node       body {node}: docker stop that node
  /heal            reconnect all stopped nodes; rejoin partitioned containers
  /partition       body {isolate:[ids], majority:[ids]}: docker network disconnect
  /put             body {key, value}: forward to current leader's HTTP API
  /slow-motion     body {enabled}: noop (slow motion is set at boot via env)
"""
import json
import os
import subprocess
import sys
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

NODES = os.environ.get("RAFT_NODES", "node1,node2,node3").split(",")
NETWORK = os.environ.get("RAFT_NETWORK", "rede-raft")


def docker(*args):
    try:
        out = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=15)
        return out.returncode, out.stdout.strip(), out.stderr.strip()
    except subprocess.TimeoutExpired:
        return 1, "", "timeout"


def http_get(url, timeout=2):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.loads(r.read())
    except Exception as exc:
        return {"_error": str(exc)}


def http_post(url, body, timeout=5):
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method="POST",
                                  headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except Exception as exc:
        return 0, str(exc)


def find_leader():
    """Query each node and return the leader's id (or None)."""
    for node in NODES:
        info = http_get(f"http://{node}:9000/status")
        if info.get("role") == "leader":
            return node
        if info.get("leader_id"):
            return info["leader_id"]
    return None


def reply(handler, status, body):
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.end_headers()
    handler.wfile.write(json.dumps(body).encode())


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[broker] " + fmt % args + "\n")

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            return reply(self, 400, {"error": "invalid JSON"})

        path = self.path.rstrip("/")
        if path == "/kill-leader":
            leader = find_leader()
            if not leader:
                return reply(self, 503, {"error": "no leader found"})
            code, out, err = docker("stop", leader)
            return reply(self, 200 if code == 0 else 500, {"leader": leader, "stdout": out, "stderr": err})

        if path == "/kill-node":
            node = body.get("node")
            if not node:
                return reply(self, 400, {"error": "node required"})
            code, out, err = docker("stop", node)
            return reply(self, 200 if code == 0 else 500, {"node": node, "stdout": out, "stderr": err})

        if path == "/heal":
            results = {}
            for node in NODES:
                # Reconnect to network if previously disconnected.
                docker("network", "connect", NETWORK, node)
                # Start the container if it was stopped.
                docker("start", node)
                results[node] = "healed"
            return reply(self, 200, results)

        if path == "/partition":
            isolate = body.get("isolate", [])
            results = {}
            for node in isolate:
                code, out, err = docker("network", "disconnect", NETWORK, node)
                results[node] = err if code != 0 else "disconnected"
            return reply(self, 200, results)

        if path == "/put":
            key = body.get("key")
            value = body.get("value", "")
            if not key:
                return reply(self, 400, {"error": "key required"})
            leader = find_leader()
            if not leader:
                return reply(self, 503, {"error": "no leader"})
            code, resp = http_post(f"http://{leader}:9000/put",
                                    {"key": key, "value": value})
            return reply(self, 200, {"leader": leader, "code": code, "resp": resp})

        if path == "/slow-motion":
            # Slow motion is determined at node boot via env var. Toggling at
            # runtime would require restarting nodes — out of scope.
            return reply(self, 200, {"note": "slow motion is fixed at cluster boot via SLOW_MOTION env var"})

        return reply(self, 404, {"error": f"unknown path {path}"})


def main():
    port = int(os.environ.get("BROKER_PORT", "9100"))
    srv = HTTPServer(("0.0.0.0", port), Handler)
    sys.stderr.write(f"[broker] listening on :{port} for nodes={NODES}\n")
    srv.serve_forever()


if __name__ == "__main__":
    main()
