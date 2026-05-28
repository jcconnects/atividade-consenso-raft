// Renderiza nós como caixas absolutas, linhas tracejadas entre pares,
// e anima pacotes via SVG path/circle.

import { layout, routePacket, pathD } from '../geometry.js';
import { linkKey } from '../store.js';
import { NODE_BOX, PACKET_COLORS } from '../config.js';
import { POLL_TICK_MS } from '../config.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function packetColor(p) {
  if (p.kind === 'heartbeat') return PACKET_COLORS.heartbeat;
  if (p.kind === 'entries')   return PACKET_COLORS.entries;
  if (p.kind === 'snapshot')  return PACKET_COLORS.snapshot;
  if (p.kind === 'vote')      return PACKET_COLORS.vote;
  if (p.kind === 'voteResp')  return p.granted ? PACKET_COLORS.voteGranted : PACKET_COLORS.voteDenied;
  if (p.kind === 'appendResp') return p.success ? PACKET_COLORS.appendRespOk : PACKET_COLORS.appendRespFail;
  return PACKET_COLORS.heartbeat;
}

function packetRadius(p) {
  if (p.kind === 'entries')  return 7;
  if (p.kind === 'snapshot') return 9;
  return 5;
}

export function mount(root, store) {
  root.innerHTML = '';
  const svgLinks = document.createElementNS(SVG_NS, 'svg');
  svgLinks.setAttribute('class', 'links');
  root.appendChild(svgLinks);
  const svgArrows = document.createElementNS(SVG_NS, 'svg');
  svgArrows.setAttribute('class', 'arrows');
  root.appendChild(svgArrows);

  const nodeEls = new Map();
  let positions = {};
  let center = { x: 0, y: 0 };
  let dim = { w: 0, h: 0 };

  function ensureNodes(state) {
    for (const id of state.node_ids) {
      if (nodeEls.has(id)) continue;
      const div = document.createElement('div');
      div.className = 'node';
      div.id = `nodo-${id}`;
      div.innerHTML = `
        <div class="node-name"></div>
        <div class="node-role"></div>
        <div class="node-stats"></div>
      `;
      root.appendChild(div);
      nodeEls.set(id, {
        root: div,
        name: div.querySelector('.node-name'),
        role: div.querySelector('.node-role'),
        stats: div.querySelector('.node-stats'),
      });
    }
  }

  function relayout() {
    const rect = root.getBoundingClientRect();
    dim = { w: rect.width, h: rect.height };
    const state = store.get();
    const r = layout(state.node_ids, dim.w, dim.h);
    positions = r.positions;
    center = r.center;
    for (const id of state.node_ids) {
      const p = positions[id];
      const ref = nodeEls.get(id);
      if (!ref) continue;
      ref.root.style.left = `${p.cx - NODE_BOX.w / 2}px`;
      ref.root.style.top  = `${p.cy - NODE_BOX.h / 2}px`;
    }
    renderLinks(state);
  }

  function renderNodes(state) {
    const now = Date.now();
    const STALE_MS = 3 * POLL_TICK_MS;
    for (const id of state.node_ids) {
      const n = state.nodes[id];
      const ref = nodeEls.get(id);
      if (!n || !ref) continue;
      const stale = (now - n.last_seen) > STALE_MS;
      ref.name.textContent = id;
      ref.role.textContent = stale ? 'DESCONECTADO' : n.role;
      ref.stats.innerHTML = `term ${n.term}<br>commit ${n.commit_idx}<br>last_log ${n.last_log_idx}`;
      ref.root.dataset.role = n.role;
      ref.root.dataset.disconnected = stale ? 'true' : 'false';
      ref.root.dataset.stale = stale ? 'true' : 'false';
      ref.root.dataset.pending = (state.pending_isolations.has(id) || state.applied_isolations.has(id)) ? 'true' : 'false';
    }
  }

  function renderLinks(state) {
    while (svgLinks.firstChild) svgLinks.removeChild(svgLinks.firstChild);
    const ids = state.node_ids;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i], b = ids[j];
        const k = linkKey(a, b);
        const l = state.links[k];
        if (!l) continue;
        const pa = positions[a], pb = positions[b];
        if (!pa || !pb) continue;
        const line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('x1', pa.cx);
        line.setAttribute('y1', pa.cy);
        line.setAttribute('x2', pb.cx);
        line.setAttribute('y2', pb.cy);
        if (l.down) line.setAttribute('class', 'broken');
        svgLinks.appendChild(line);
      }
    }
  }

  const activePackets = new Map(); // id → { el, path, route, t_start, duration }

  function renderPackets(state) {
    // Remove pacotes que sumiram da store.
    const ids = new Set(state.packets.map(p => p.id));
    for (const [id, ref] of activePackets) {
      if (!ids.has(id)) {
        if (ref.path) svgArrows.removeChild(ref.path);
        if (ref.el)   svgArrows.removeChild(ref.el);
        activePackets.delete(id);
      }
    }
    // Adiciona novos.
    for (const p of state.packets) {
      if (activePackets.has(p.id)) continue;
      const from = positions[p.from], to = positions[p.to];
      if (!from || !to) continue;
      const others = state.node_ids
        .filter(n => n !== p.from && n !== p.to)
        .map(n => positions[n]).filter(Boolean);
      const route = routePacket(from, to, others, center);
      const pathEl = document.createElementNS(SVG_NS, 'path');
      pathEl.setAttribute('d', pathD(route));
      pathEl.setAttribute('stroke', 'transparent');
      pathEl.setAttribute('fill', 'none');
      svgArrows.appendChild(pathEl);
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('r', packetRadius(p));
      dot.setAttribute('fill', packetColor(p));
      dot.setAttribute('cx', from.cx);
      dot.setAttribute('cy', from.cy);
      svgArrows.appendChild(dot);
      activePackets.set(p.id, { el: dot, path: pathEl, t_start: p.t_start, duration: p.duration });
    }
  }

  function tickAnimation() {
    const now = performance.now();
    for (const [_id, ref] of activePackets) {
      const t = (now - ref.t_start) / ref.duration;
      if (t >= 1) {
        ref.el.style.opacity = 0;
        continue;
      }
      const len = ref.path.getTotalLength();
      const pt = ref.path.getPointAtLength(t * len);
      ref.el.setAttribute('cx', pt.x);
      ref.el.setAttribute('cy', pt.y);
      ref.el.style.opacity = 1;
    }
    raf = requestAnimationFrame(tickAnimation);
  }
  let raf = requestAnimationFrame(tickAnimation);

  function render(state) {
    ensureNodes(state);
    if (dim.w === 0 || dim.h === 0) relayout();
    renderNodes(state);
    renderLinks(state);
    renderPackets(state);
  }

  const unsub = store.subscribe(render);
  const ro = new ResizeObserver(() => relayout());
  ro.observe(root);

  return {
    destroy() {
      unsub();
      ro.disconnect();
      cancelAnimationFrame(raf);
    }
  };
}
