// Atualiza o resumo no header (term, commit, quorum, líder, heartbeat).

export function mount(_root, store) {
  const elTerm = document.getElementById('resumo-term');
  const elCommit = document.getElementById('resumo-commit');
  const elQuorum = document.getElementById('resumo-quorum');
  const elLider = document.getElementById('resumo-lider');
  const elHb = document.getElementById('resumo-heartbeat');

  function render(s) {
    elTerm.textContent = s.max_term || 0;
    let commitMax = 0;
    for (const id of s.node_ids) {
      const n = s.nodes[id];
      if (n && n.commit_idx > commitMax) commitMax = n.commit_idx;
    }
    elCommit.textContent = commitMax;
    const N = s.node_ids.length;
    elQuorum.textContent = `${Math.floor(N / 2) + 1}/${N}`;
    elLider.textContent = s.leader || '—';
    elHb.textContent = `${s.heartbeat_ms}ms`;
  }

  return { destroy: store.subscribe(render) };
}
