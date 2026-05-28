// Ações globais (header): Matar líder, Curar tudo, Put aleatório,
// Aplicar partição (visível só se há pendentes).

function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}

// Listas de palavras para gerar chaves e valores divertidos.
const CHAVES = [
  'capivara', 'jabuticaba', 'pamonha', 'caipirinha', 'goiabada',
  'açaí', 'tapioca', 'feijoada', 'brigadeiro', 'cuscuz',
  'mandioca', 'guaraná', 'pequi', 'farofa', 'paçoca',
  'caju', 'mate_gelado', 'pão_de_queijo', 'rapadura', 'beiju',
  'macarrão', 'salgadinho', 'caldo_de_cana', 'curupira', 'saci',
  'iara', 'boto', 'maracanã', 'tarsila', 'machado',
];

const VALORES = [
  'fervendo', 'descongelado', 'crocante', 'molhado', 'em_brasa',
  'gelado', 'morno', 'quentinho', 'derretendo', 'congelado',
  'azedo', 'doce', 'salgado', 'picante', 'amargo',
  'fresco', 'amassado', 'inteiro', 'estourado', 'queimado',
  'na_panela', 'no_forno', 'na_geladeira', 'no_armário', 'sumiu',
  'voando', 'pulando', 'dormindo', 'cantando', 'reclamando',
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomPair() {
  return { key: pick(CHAVES), value: pick(VALORES) };
}

export function mount(root, store) {
  root.innerHTML = '';

  const killLeader = el('button', null, 'Matar líder');
  killLeader.onclick = () => fetch('/control/kill-leader', { method: 'POST' });

  const healAll = el('button', null, 'Curar tudo');
  healAll.onclick = async () => {
    await fetch('/control/heal', { method: 'POST' });
    store.clearDeclaredPartitions();
  };

  const putRandom = el('button', null, 'Put aleatório');
  putRandom.onclick = () => fetch('/control/put', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(randomPair()),
  });

  const aplicar = el('button', 'aplicar', 'Aplicar partição');
  aplicar.style.display = 'none';
  aplicar.onclick = async () => {
    const s = store.get();
    const isolate = [...s.pending_isolations];
    const majority = s.node_ids.filter(n => !s.pending_isolations.has(n));
    if (isolate.length === 0 || majority.length === 0) return;
    const resp = await fetch('/control/partition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isolate, majority }),
    });
    if (resp.ok) {
      store.setDeclaredPartitions([isolate, majority]);
      store.commitPending();
    }
  };

  root.appendChild(killLeader);
  root.appendChild(healAll);
  root.appendChild(putRandom);
  root.appendChild(aplicar);

  const unsub = store.subscribe((s) => {
    const n = s.pending_isolations.size;
    if (n > 0) {
      aplicar.style.display = '';
      aplicar.textContent = `Aplicar partição (${n} marcado${n === 1 ? '' : 's'})`;
    } else {
      aplicar.style.display = 'none';
    }
  });

  return { destroy() { unsub(); } };
}
