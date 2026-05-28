(() => {
  "use strict";

  // Cluster topology is supplied by the dashboard container's environment.
  // For now: hardcoded 3-node layout. To support 5-node mode (Modificação A),
  // the dashboard container reads NODES env and templates this at boot.
  const NODES = (window.RAFT_NODES || "node1,node2,node3").split(",");
  const EVENT_BASE = window.RAFT_EVENT_BASE || ""; // proxied via nginx
  const CONTROL_BASE = window.RAFT_CONTROL_BASE || "/control";

  const state = {
    nodes: new Map(),     // nodeID → {role, term, commit, lastLog, lastApplied}
    logs: new Map(),      // nodeID → array of {index, term, command, key, value, committed}
    paused: false,
    slow: true,
    hideHeartbeats: true,
    eventCount: 0,
    // Partition groups: array of node-id arrays. Nodes in the same group can talk
    // to each other; nodes in different groups are partitioned. Default: one group
    // containing every node (fully connected cluster).
    partitions: [NODES.slice()],
  };

  for (const id of NODES) {
    state.nodes.set(id, {
      role: "follower",
      term: 0,
      commit: 0,
      lastLog: 0,
      lastApplied: 0,
      disconnected: false,
    });
    state.logs.set(id, []);
  }

  const dom = {
    statTerm: document.getElementById("stat-term"),
    statCommit: document.getElementById("stat-commit"),
    statQuorum: document.getElementById("stat-quorum"),
    statLeader: document.getElementById("stat-leader"),
    nodes: document.getElementById("nodes"),
    logsTable: document.getElementById("logs-table"),
    eventLog: document.getElementById("event-log-list"),
    killNode: document.getElementById("kill-node"),
  };

  function renderNodes() {
    // Two SVG layers: links (persistent topology lines, behind boxes) and arrows
    // (animated packets, in front of boxes).
    let linkSvg = dom.nodes.querySelector("svg.links");
    if (!linkSvg) {
      linkSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      linkSvg.setAttribute("class", "links");
      dom.nodes.insertBefore(linkSvg, dom.nodes.firstChild);
    }
    let svg = dom.nodes.querySelector("svg.arrows");
    if (!svg) {
      svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "arrows");
      dom.nodes.appendChild(svg);
    }

    // Circular layout: chords between any two nodes never cross another node box.
    const containerRect = dom.nodes.getBoundingClientRect();
    const nodeW = 160, nodeH = 140;
    const cx = containerRect.width / 2;
    const cy = containerRect.height / 2;
    const radius = Math.max(120, Math.min(cx, cy) - Math.max(nodeW, nodeH) / 2 - 20);

    // Build/refresh node boxes.
    NODES.forEach((id, i) => {
      let box = document.getElementById(`node-${id}`);
      const s = state.nodes.get(id);
      if (!box) {
        box = document.createElement("div");
        box.id = `node-${id}`;
        box.className = "node";
        box.innerHTML = `
          <div class="node-name"></div>
          <div class="node-role"></div>
          <div class="node-stats"></div>
        `;
        dom.nodes.appendChild(box);
      }
      box.querySelector(".node-name").textContent = id;
      box.querySelector(".node-role").textContent = s.disconnected ? "DISCONNECTED" : s.role;
      box.querySelector(".node-stats").innerHTML =
        `term: ${s.term}<br>commit: ${s.commit}<br>last_log: ${s.lastLog}`;
      box.setAttribute("data-role", s.role);
      box.setAttribute("data-disconnected", s.disconnected ? "true" : "false");
      // Place on circle, first node at top, clockwise.
      const angle = -Math.PI / 2 + (2 * Math.PI * i) / NODES.length;
      const x = cx + radius * Math.cos(angle) - nodeW / 2;
      const y = cy + radius * Math.sin(angle) - nodeH / 2;
      box.style.left = `${x}px`;
      box.style.top = `${y}px`;
    });

    renderConnections(linkSvg, containerRect);

    // Cluster header stats — derive from current leader, if any.
    let leader = null;
    let maxTerm = 0;
    let maxCommit = 0;
    for (const [id, s] of state.nodes.entries()) {
      if (s.role === "leader" && !s.disconnected) leader = id;
      if (s.term > maxTerm) maxTerm = s.term;
      if (s.commit > maxCommit) maxCommit = s.commit;
    }
    dom.statTerm.textContent = maxTerm;
    dom.statCommit.textContent = maxCommit;
    dom.statQuorum.textContent = `${Math.floor(NODES.length / 2) + 1}/${NODES.length}`;
    dom.statLeader.textContent = leader || "—";
  }

  function renderLogs() {
    // Determine global max log length across all nodes for column alignment.
    let maxLen = 0;
    for (const log of state.logs.values()) maxLen = Math.max(maxLen, log.length);
    if (maxLen > 30) maxLen = 30; // window — show only most recent 30 entries

    dom.logsTable.innerHTML = "";
    for (const id of NODES) {
      const log = state.logs.get(id);
      const s = state.nodes.get(id);
      const tail = log.slice(Math.max(0, log.length - 30));
      const entriesHTML = tail.map(e => {
        const committed = e.index <= s.commit;
        const label = e.command === "PUT" ? "P" : e.command === "DEL" ? "D" : "·";
        return `<div class="log-entry" data-committed="${committed}" title="idx=${e.index} term=${e.term} ${e.command || ""} ${e.key || ""}">${label}</div>`;
      }).join("");
      const row = document.createElement("div");
      row.className = "log-row";
      row.innerHTML = `
        <div class="log-node">${id}</div>
        <div class="log-entries">${entriesHTML}</div>
        <div class="log-meta">last=${s.lastLog} commit=${s.commit}</div>
      `;
      dom.logsTable.appendChild(row);
    }
  }

  function pushEventLine(ev) {
    state.eventCount++;
    const div = document.createElement("div");
    div.className = "event-line";
    const t = `<span class="ev-t">[t=${ev.t.toFixed(3)}s]</span>`;
    let body;
    switch (ev.type) {
      case "rpc_send":
        body = `<span class="ev-rpc-send">${ev.from}→${ev.to} ${ev.rpc}(term=${ev.term}${ev.entries ? `, n=${ev.entries}` : ""})</span>`;
        break;
      case "rpc_resp":
        body = `<span class="ev-rpc-resp">${ev.from}→${ev.to} ${ev.rpc}(term=${ev.term}, ${ev.success || ev.granted ? "ok" : "no"})</span>`;
        break;
      case "apply":
        body = `<span class="ev-apply">${ev.node} apply idx=${ev.index} term=${ev.term} ${ev.command}(${ev.key}${ev.value ? "=" + ev.value : ""})</span>`;
        break;
      case "role_change":
        body = `<span class="ev-role">${ev.node} → ${ev.role}</span>`;
        break;
      case "leader_change":
        body = `<span class="ev-role">${ev.node}: leader is now ${ev.to}</span>`;
        break;
      default:
        body = `<span>${ev.type} ${ev.node || ""}</span>`;
    }
    div.innerHTML = `${t} ${body}`;
    dom.eventLog.insertBefore(div, dom.eventLog.firstChild);
    while (dom.eventLog.children.length > 200) {
      dom.eventLog.removeChild(dom.eventLog.lastChild);
    }
  }

  // Draw a persistent line between every pair of nodes that are in the same
  // partition group. Different groups (partitioned) get no line — so the
  // dashboard reflects current network topology, not just live RPC packets.
  function renderConnections(svg, containerRect) {
    svg.innerHTML = "";
    for (const group of state.partitions) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = document.getElementById(`node-${group[i]}`);
          const b = document.getElementById(`node-${group[j]}`);
          if (!a || !b) continue;
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          const ax = ar.left + ar.width / 2 - containerRect.left;
          const ay = ar.top + ar.height / 2 - containerRect.top;
          const bx = br.left + br.width / 2 - containerRect.left;
          const by = br.top + br.height / 2 - containerRect.top;
          const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
          line.setAttribute("x1", ax);
          line.setAttribute("y1", ay);
          line.setAttribute("x2", bx);
          line.setAttribute("y2", by);
          line.setAttribute("class", "link");
          svg.appendChild(line);
        }
      }
    }
  }

  // Returns the point on the rectangle's border (in container coords) where the
  // ray from rect center toward (tx, ty) exits the rect, plus a small margin.
  function rectEdgePoint(rect, containerRect, tx, ty) {
    const cx = rect.left + rect.width / 2 - containerRect.left;
    const cy = rect.top + rect.height / 2 - containerRect.top;
    const dx = tx - cx;
    const dy = ty - cy;
    if (dx === 0 && dy === 0) return [cx, cy];
    const halfW = rect.width / 2;
    const halfH = rect.height / 2;
    const scale = Math.min(halfW / Math.abs(dx || 1e-9), halfH / Math.abs(dy || 1e-9));
    const margin = 10;
    const len = Math.hypot(dx, dy);
    const ux = dx / len, uy = dy / len;
    return [cx + dx * scale + ux * margin, cy + dy * scale + uy * margin];
  }

  function drawArrow(fromID, toID, kind, extra = {}) {
    const svg = dom.nodes.querySelector("svg.arrows");
    if (!svg) return;
    const from = document.getElementById(`node-${fromID}`);
    const to = document.getElementById(`node-${toID}`);
    if (!from || !to) return;
    const containerRect = dom.nodes.getBoundingClientRect();
    const fromRect = from.getBoundingClientRect();
    const toRect = to.getBoundingClientRect();
    const cx1 = fromRect.left + fromRect.width / 2 - containerRect.left;
    const cy1 = fromRect.top + fromRect.height / 2 - containerRect.top;
    const cx2 = toRect.left + toRect.width / 2 - containerRect.left;
    const cy2 = toRect.top + toRect.height / 2 - containerRect.top;
    // Offset start/end to the node-box border facing the other node, so the packet is never hidden behind a box.
    const [x1, y1] = rectEdgePoint(fromRect, containerRect, cx2, cy2);
    const [x2, y2] = rectEdgePoint(toRect, containerRect, cx1, cy1);
    const duration = 700;
    const packet = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    // Bigger packet for AppendEntries carrying log entries so log replication
    // visually stands out from the constant heartbeat trickle.
    const hasPayload = kind === "AppendEntries" && (extra.entries || 0) > 0;
    packet.setAttribute("r", hasPayload ? 13 : 7);
    packet.setAttribute("cx", x1);
    packet.setAttribute("cy", y1);
    // Distinguish replication traffic carrying client writes (Put) from heartbeats:
    // AppendEntries with entries>0 is a Put being replicated. Color it differently
    // so students can visually track a Put's request→response round-trip.
    let cls;
    if (kind === "AppendEntries") {
      cls = hasPayload ? "packet-put" : "packet-append";
    } else {
      cls = "packet-vote";
    }
    if (hasPayload) cls += " packet-payload";
    packet.setAttribute("class", `packet ${cls}`);
    svg.appendChild(packet);
    const start = performance.now();
    function step(now) {
      const t = Math.min(1, (now - start) / duration);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // ease in-out
      packet.setAttribute("cx", x1 + (x2 - x1) * e);
      packet.setAttribute("cy", y1 + (y2 - y1) * e);
      if (t < 1) requestAnimationFrame(step);
      else packet.remove();
    }
    requestAnimationFrame(step);
  }

  // True for empty AppendEntries (heartbeats) and their responses, which fire
  // many times per second and would otherwise drown out the interesting events.
  // RequestVote and AppendEntries carrying log entries are always interesting.
  function isHeartbeatEvent(ev) {
    if (!state.hideHeartbeats) return false;
    if (ev.rpc === "RequestVote" || ev.rpc === "RequestVoteResp") return false;
    // Empty AppendEntries (and their responses) are heartbeats. Both sides are
    // tagged with `entries` so we can filter them symmetrically and let the
    // request→response handshake for a Put show up end-to-end.
    if (ev.rpc === "AppendEntries" || ev.rpc === "AppendEntriesResp") {
      return (ev.entries || 0) === 0;
    }
    return false;
  }

  // Raft terms are monotonic. If we observe a higher term for a node via any
  // event channel, our cached snapshot is stale — update it. If the node was
  // marked leader at the old (lower) term, demote to follower until a fresh
  // state snapshot proves otherwise.
  function bumpTerm(nodeID, term) {
    if (!nodeID || term == null) return;
    const s = state.nodes.get(nodeID);
    if (!s) return;
    if (term > s.term) {
      s.term = term;
      if (s.role === "leader") s.role = "follower";
    }
  }

  function handleEvent(ev) {
    if (state.paused) return;
    const node = ev.node;
    switch (ev.type) {
      case "state":
        if (state.nodes.has(node)) {
          const s = state.nodes.get(node);
          s.role = ev.role || s.role;
          s.term = ev.term ?? s.term;
          s.commit = ev.commit_idx ?? s.commit;
          s.lastLog = ev.last_log_idx ?? s.lastLog;
          s.lastApplied = ev.last_applied ?? s.lastApplied;
        }
        break;
      case "role_change":
        if (state.nodes.has(node)) {
          state.nodes.get(node).role = ev.role;
        }
        pushEventLine(ev);
        break;
      case "leader_change":
        pushEventLine(ev);
        break;
      case "apply":
        if (state.logs.has(node)) {
          const log = state.logs.get(node);
          log.push({
            index: ev.index,
            term: ev.term,
            command: ev.command,
            key: ev.key,
            value: ev.value,
          });
        }
        pushEventLine(ev);
        break;
      case "rpc_send":
        if (ev.from && ev.to && ev.from !== ev.to) {
          drawArrow(ev.from, ev.to, ev.rpc, { entries: ev.entries });
        }
        // Term observed on the wire is monotonic — use it to correct any stale node-state
        // we may have missed during an SSE disconnect.
        bumpTerm(ev.from, ev.term);
        if (!isHeartbeatEvent(ev)) pushEventLine(ev);
        break;
      case "rpc_resp":
        bumpTerm(ev.from, ev.term);
        // If a peer responds to us with a higher term, our local role must have stepped down.
        if (state.nodes.has(ev.to)) {
          const recv = state.nodes.get(ev.to);
          if (ev.term > recv.term) {
            recv.term = ev.term;
            recv.role = "follower";
          }
        }
        // Animate a response packet flying back so users can see the handshake.
        // Skip heartbeat acks (empty AppendEntries responses) — they fire constantly
        // and clutter the canvas without adding signal.
        // Defer the response by the request-packet animation duration so the response
        // visibly leaves the follower AFTER the request arrives — preserving the
        // temporal order of the handshake even though both events arrive on the SSE
        // stream almost simultaneously.
        if (ev.from && ev.to && ev.from !== ev.to && !(ev.rpc === "AppendEntriesResp" && (ev.entries || 0) === 0)) {
          const respKind = ev.rpc === "AppendEntriesResp" ? "AppendEntries" : "RequestVote";
          setTimeout(() => drawArrow(ev.from, ev.to, respKind, { entries: ev.entries }), 700);
        }
        if (!isHeartbeatEvent(ev)) pushEventLine(ev);
        break;
    }
    renderNodes();
    renderLogs();
  }

  function connectToNode(id) {
    const url = `${EVENT_BASE}/events/${id}`;
    const es = new EventSource(url);
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data);
        handleEvent(ev);
      } catch (err) {
        console.error("event parse", err);
      }
    };
    es.onerror = () => {
      const s = state.nodes.get(id);
      if (s) {
        s.disconnected = true;
        // Wipe role to avoid showing a stale leader badge while the stream is down.
        // The next /state snapshot after reconnect will overwrite this.
        s.role = "follower";
        renderNodes();
      }
      // Browser EventSource auto-reconnects, but we close + reopen so stats reset
      // cleanly and we never end up with two live streams for the same node.
      es.close();
      setTimeout(() => connectToNode(id), 2000);
    };
    es.onopen = () => {
      const s = state.nodes.get(id);
      if (s) {
        s.disconnected = false;
        renderNodes();
      }
    };
  }

  // ──────────────── controls ────────────────

  async function controlAction(action, params = {}) {
    try {
      const res = await fetch(`${CONTROL_BASE}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      const text = await res.text();
      pushEventLine({ t: 0, type: "control", node: action, role: text.slice(0, 80) });
    } catch (e) {
      console.error("control", e);
    }
  }

  document.getElementById("btn-kill-leader").addEventListener("click", () => {
    controlAction("kill-leader");
  });
  document.getElementById("btn-heal").addEventListener("click", () => {
    state.partitions = [NODES.slice()];
    renderNodes();
    controlAction("heal");
  });
  document.getElementById("btn-put").addEventListener("click", () => {
    const key = `key${Math.floor(Math.random() * 1000)}`;
    const value = `val${Math.floor(Math.random() * 1000)}`;
    controlAction("put", { key, value });
  });
  document.getElementById("kill-node").addEventListener("change", (e) => {
    const id = e.target.value;
    if (id) {
      controlAction("kill-node", { node: id });
      e.target.value = "";
    }
  });
  document.getElementById("partition-preset").addEventListener("change", (e) => {
    const v = e.target.value;
    if (v) {
      const [iso, rest] = v.split("|");
      // Dropdown values use bare digits (e.g. "1|2,3"); prepend "node" for ids.
      const isolate = iso.split(",").map(n => `node${n.trim()}`);
      const majority = rest.split(",").map(n => `node${n.trim()}`);
      state.partitions = [isolate, majority];
      renderNodes();
      controlAction("partition", { isolate, majority });
      e.target.value = "";
    }
  });
  document.getElementById("toggle-pause").addEventListener("change", (e) => {
    state.paused = e.target.checked;
  });
  document.getElementById("toggle-slow").addEventListener("change", (e) => {
    state.slow = e.target.checked;
    controlAction("slow-motion", { enabled: state.slow });
  });
  document.getElementById("toggle-hide-heartbeats").addEventListener("change", (e) => {
    state.hideHeartbeats = e.target.checked;
  });

  for (const id of NODES) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = `Kill ${id}`;
    dom.killNode.appendChild(opt);
  }

  // initial paint
  renderNodes();
  renderLogs();
  window.addEventListener("resize", renderNodes);
  for (const id of NODES) connectToNode(id);
})();
