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
    eventCount: 0,
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
    // Lazy create the SVG arrow layer.
    let svg = dom.nodes.querySelector("svg.arrows");
    if (!svg) {
      svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "arrows");
      dom.nodes.appendChild(svg);
    }

    // Build/refresh node boxes.
    for (const id of NODES) {
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
    }

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

  function drawArrow(fromID, toID, kind) {
    const svg = dom.nodes.querySelector("svg.arrows");
    if (!svg) return;
    const from = document.getElementById(`node-${fromID}`);
    const to = document.getElementById(`node-${toID}`);
    if (!from || !to) return;
    const containerRect = dom.nodes.getBoundingClientRect();
    const fromRect = from.getBoundingClientRect();
    const toRect = to.getBoundingClientRect();
    const x1 = fromRect.left + fromRect.width / 2 - containerRect.left;
    const y1 = fromRect.top + fromRect.height / 2 - containerRect.top;
    const x2 = toRect.left + toRect.width / 2 - containerRect.left;
    const y2 = toRect.top + toRect.height / 2 - containerRect.top;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", x1);
    line.setAttribute("y1", y1);
    line.setAttribute("x2", x2);
    line.setAttribute("y2", y2);
    line.setAttribute("class", `arrow ${kind === "AppendEntries" ? "arrow-append" : "arrow-vote"}`);
    svg.appendChild(line);
    setTimeout(() => line.remove(), 1300);
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
          drawArrow(ev.from, ev.to, ev.rpc);
        }
        if (ev.entries > 0 || ev.rpc === "RequestVote") pushEventLine(ev);
        break;
      case "rpc_resp":
        pushEventLine(ev);
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
        renderNodes();
      }
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
      controlAction("partition", { isolate: iso.split(","), majority: rest.split(",") });
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

  for (const id of NODES) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = `Kill ${id}`;
    dom.killNode.appendChild(opt);
  }

  // initial paint
  renderNodes();
  renderLogs();
  for (const id of NODES) connectToNode(id);
})();
