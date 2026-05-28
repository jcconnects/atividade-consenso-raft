// Cards compactos com estado por nó + botões contextuais por-nó.
// Ações globais ficam em controlsView.

import { POLL_TICK_MS, HIGHLIGHT_QUORUM_MS } from '../config.js';

const STALE_MS = 3 * POLL_TICK_MS; // 1500ms

function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}

export function mount(root, store) {
  root.innerHTML = '';
  root.appendChild(el('h2', null, 'Estado dos nós'));
  const grid = el('div', 'cards-grid');
  root.appendChild(grid);

  const cards = new Map();
  const state = store.get();

  for (const id of state.node_ids) {
    const card = el('div', 'card-nodo');
    card.dataset.node = id;
    const name = el('div', 'card-nome', id);
    const role = el('div', 'card-papel', '—');
    const stats = el('div', 'card-stats');
    const actions = el('div', 'node-actions');

    const btnKill = el('button', null, 'Matar');
    btnKill.onclick = () => fetch('/control/kill-node', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ node: id }),
    });

    const btnIsolate = el('button', 'isolar', 'Isolar');
    btnIsolate.onclick = async () => {
      const s = store.get();
      if (s.applied_isolations.has(id)) {
        // Já aplicado: chama /heal-node para desfazer iptables só desse nó.
        const r = await fetch('/control/heal-node', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ node: id }),
        });
        if (r.ok) store.releaseApplied(id);
      } else {
        // Pendente: só marca/desmarca local.
        store.togglePendingIsolation(id);
      }
    };

    const btnHeal = el('button', null, 'Curar este nó');
    btnHeal.onclick = () => fetch('/control/heal-node', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ node: id }),
    });

    actions.appendChild(btnKill);
    actions.appendChild(btnIsolate);
    actions.appendChild(btnHeal);

    card.appendChild(name);
    card.appendChild(role);
    card.appendChild(stats);
    card.appendChild(actions);
    grid.appendChild(card);
    cards.set(id, { card, role, stats, btnIsolate, btnHeal });
  }

  function render(s) {
    const now = Date.now();
    for (const id of s.node_ids) {
      const n = s.nodes[id];
      const ref = cards.get(id);
      if (!ref || !n) continue;
      const isStale = (now - n.last_seen) > STALE_MS;
      ref.card.dataset.role = n.role;
      ref.card.dataset.stale = isStale ? 'true' : 'false';
      ref.role.textContent = isStale ? 'sem resposta' : n.role;
      let extra = '';
      if (n.role === 'leader' && Object.keys(n.match_index).length) {
        const parts = Object.entries(n.match_index).map(([p, i]) => `${p}: ${i}`);
        extra = `<div class="match">match: ${parts.join(' · ')}</div>`;
      }
      // Badge "quórum atingido": só no líder, dispara no avanço de commit_idx.
      const quorumEv = s.recently_committed_leader[id];
      const showQuorum = n.role === 'leader' && quorumEv && (Date.now() - quorumEv.t_ms) < HIGHLIGHT_QUORUM_MS;
      const badge = showQuorum
        ? `<span class="badge-quorum">quórum atingido idx=${quorumEv.index}</span>`
        : '';
      ref.stats.innerHTML = `
        term <span class="v">${n.term}</span> ·
        commit <span class="v">${n.commit_idx}</span> ·
        last_log <span class="v">${n.last_log_idx}</span> ·
        applied <span class="v">${n.last_applied}</span>
        ${badge}
        ${extra}
      `;
      const pending = s.pending_isolations.has(id);
      const applied = s.applied_isolations.has(id);
      ref.btnIsolate.classList.toggle('ativo', pending || applied);
      if (applied) ref.btnIsolate.textContent = 'Liberar';
      else if (pending) ref.btnIsolate.textContent = 'Cancelar';
      else ref.btnIsolate.textContent = 'Isolar';
      ref.card.dataset.pending = (pending || applied) ? 'true' : 'false';
      ref.btnHeal.style.display = isStale ? '' : 'none';
    }
  }

  const unsub = store.subscribe(render);
  // Re-render periódico para detectar staleness mesmo sem novos eventos.
  const tid = setInterval(() => render(store.get()), POLL_TICK_MS);
  return { destroy() { unsub(); clearInterval(tid); } };
}
