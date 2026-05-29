// Painel de log: matriz alinhada por índice.
// Linhas = índices Raft (decrescente, mais recente no topo).
// Colunas = um por nó.
// Célula = chave/valor da entrada naquele nó OU "—" (não tem) OU "em voo".

import { LOG_WINDOW, HIGHLIGHT_APPLY_MS } from '../config.js';

function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}

export function mount(root, store) {
  root.innerHTML = '';
  root.appendChild(el('h2', null, 'Logs replicados'));
  const container = el('div', 'logs-container');
  root.appendChild(container);

  function render(s) {
    container.innerHTML = '';
    const ids = s.node_ids;

    // Determina maior índice já visto em qualquer nó (comprometido ou em voo).
    let maxIdx = 0;
    for (const id of ids) {
      const n = s.nodes[id];
      if (n) maxIdx = Math.max(maxIdx, n.last_log_idx || 0);
      for (const e of (s.logs[id] || [])) {
        if (e.index > maxIdx) maxIdx = e.index;
      }
    }
    if (maxIdx === 0) {
      container.appendChild(el('div', 'logs-vazio', 'Nenhuma entrada de log ainda. Use "Put aleatório" no header.'));
      return;
    }

    // Mapa rápido: por nó, índice → entry.
    const byNodeIdx = {};
    for (const id of ids) {
      byNodeIdx[id] = {};
      for (const e of (s.logs[id] || [])) {
        byNodeIdx[id][e.index] = e;
      }
    }

    const minIdx = Math.max(1, maxIdx - LOG_WINDOW + 1);

    const table = el('table', 'logs-matriz');
    const thead = el('thead');
    const headRow = el('tr');
    headRow.appendChild(el('th', 'col-idx', 'índice'));
    for (const id of ids) {
      headRow.appendChild(el('th', 'col-no', id));
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = el('tbody');
    for (let idx = maxIdx; idx >= minIdx; idx--) {
      const tr = el('tr');
      const idxCell = el('td', 'col-idx', String(idx));
      tr.appendChild(idxCell);
      // Term de referência: o primeiro nó que tem essa entrada.
      let refTerm = null;
      for (const id of ids) {
        const e = byNodeIdx[id][idx];
        if (e) { refTerm = e.term; break; }
      }
      for (const id of ids) {
        const n = s.nodes[id];
        const e = byNodeIdx[id][idx];
        const td = el('td', 'cel');
        if (e) {
          // Entrada presente no log local. Verde apenas se commit_idx do nó
          // alcança esse índice; senão branca (anexada mas não comprometida).
          const committed = e.committed === true || (n && idx <= n.commit_idx);
          if (committed) {
            td.classList.add('comprometido');
          } else {
            td.classList.add('em-voo');
          }
          const cmd = el('span', 'cmd', e.command || '');
          const kv = el('span', 'kv');
          kv.textContent = e.value ? `${e.key}=${e.value}` : (e.key || '');
          td.appendChild(cmd);
          td.appendChild(kv);
          if (refTerm !== null && e.term !== refTerm) {
            td.classList.add('divergente');
            td.title = `term ${e.term} difere do esperado ${refTerm}`;
          }
          const appliedAt = (s.recently_applied[id] || {})[idx];
          if (appliedAt && (Date.now() - appliedAt) < HIGHLIGHT_APPLY_MS) {
            td.classList.add('recem-aplicado');
          }
        } else if (n && idx <= n.last_log_idx) {
          // Anexada mas ainda não aplicada (entre commit_idx e last_log_idx)
          // OU aplicada antes da janela de visualização — distinguir:
          td.classList.add('em-voo');
          if (idx > n.commit_idx) {
            td.textContent = 'em voo';
            td.title = 'anexada ao log local mas ainda não comprometida (sem comando exposto)';
          } else {
            // Comprometida mas fora da janela de eventos `apply` capturados.
            td.textContent = '· comprometida ·';
            td.title = 'commit_idx alcança esse índice, mas o evento apply não foi capturado nesta sessão';
            td.classList.add('fora-janela');
          }
        } else {
          // Nó não tem essa entrada ainda.
          td.classList.add('ausente');
          td.textContent = '—';
          td.title = 'este nó ainda não recebeu/aplicou essa entrada';
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    container.appendChild(table);

    // Rodapé com legenda.
    const legenda = el('div', 'logs-legenda');
    legenda.innerHTML = `
      <span class="leg comprometido">PUT chave=valor</span> aplicado ·
      <span class="leg em-voo">em voo</span> anexado mas não comprometido ·
      <span class="leg ausente">—</span> ausente neste nó ·
      <span class="leg divergente">cor avermelhada</span> term divergente
    `;
    container.appendChild(legenda);
  }

  const unsub = store.subscribe(render);
  // Re-render rápido durante janela de highlight para fazer fade-out suave.
  const tid = setInterval(() => render(store.get()), 250);
  return { destroy() { unsub(); clearInterval(tid); } };
}
