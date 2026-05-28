// Stream textual ao vivo com cadeia de filtros (esconder heartbeats, etc.).

import { STREAM_WINDOW } from '../config.js';
import { composeFilters } from '../filters.js';

const FORMATTERS = {
  state:         (e) => `${e.node} state role=${e.role} term=${e.term} commit=${e.commit_idx} last_log=${e.last_log_idx}`,
  role_change:   (e) => `${e.node} role_change → ${e.role}`,
  leader_change: (e) => `${e.node} leader_change → ${e.to}`,
  peer_change:   (e) => `${e.node} peer_change ${e.to}`,
  rpc_send:      (e) => `${e.from} → ${e.to} ${e.rpc} term=${e.term}${e.entries ? ` entries=${e.entries}` : ''}`,
  rpc_resp:      (e) => `${e.from} → ${e.to} ${e.rpc} term=${e.term}${e.success !== undefined ? ` success=${e.success}` : ''}${e.granted !== undefined ? ` granted=${e.granted}` : ''}${e.entries ? ` entries=${e.entries}` : ''}`,
  rpc_recv:      (e) => `${e.node} ← ${e.from} ${e.rpc} term=${e.term}`,
  apply:         (e) => `${e.node} apply idx=${e.index} ${e.command} ${e.key}${e.value ? `=${e.value}` : ''}`,
  replication:   (e) => `${e.node} repl ${e.to} match=${e.index}`,
};

function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}

export function mount(root, bus) {
  root.innerHTML = '';
  const header = el('div', 'stream-header');
  const title = el('h2', null, 'Eventos ao vivo');
  header.appendChild(title);

  function makeToggle(label, name, checkedDefault) {
    const wrap = el('label', 'toggle');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checkedDefault;
    cb.dataset.filter = name;
    wrap.appendChild(cb);
    wrap.appendChild(document.createTextNode(' ' + label));
    header.appendChild(wrap);
    return cb;
  }

  const cbHb = makeToggle('Esconder heartbeats', 'hideHeartbeats', true);
  const cbState = makeToggle('Esconder snapshots de estado', 'hideStateSnapshots', true);
  const cbRepl = makeToggle('Esconder replicação', 'hideReplication', true);
  root.appendChild(header);

  const list = el('div', 'stream-list');
  root.appendChild(list);

  let activeFilters = computeActive();
  function computeActive() {
    const arr = [];
    if (cbHb.checked) arr.push('hideHeartbeats');
    if (cbState.checked) arr.push('hideStateSnapshots');
    if (cbRepl.checked) arr.push('hideReplication');
    return arr;
  }
  cbHb.onchange = () => { activeFilters = computeActive(); };
  cbState.onchange = () => { activeFilters = computeActive(); };
  cbRepl.onchange = () => { activeFilters = computeActive(); };

  bus.onAny((evt) => {
    const keep = composeFilters(activeFilters);
    if (!keep(evt)) return;
    const fmt = FORMATTERS[evt.type] || ((e) => JSON.stringify(e));
    const linha = el('div', 'linha');
    const t = el('span', 't', `${(evt.t || 0).toFixed(2)}s`);
    const tipo = el('span', 'tipo', evt.type);
    const txt = el('span', 'msg', fmt(evt));
    linha.appendChild(t);
    linha.appendChild(tipo);
    linha.appendChild(txt);
    list.insertBefore(linha, list.firstChild);
    while (list.children.length > STREAM_WINDOW) list.removeChild(list.lastChild);
    list.scrollTop = 0;
  });
}
