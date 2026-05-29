// Banner de partição declarada. Pendentes ficam visíveis pelo botão flutuante
// em controlsView; este banner mostra só o que já foi APLICADO.

function formatGroup(group) {
  return `(${group.join(', ')})`;
}

export function mount(root, store) {
  root.innerHTML = '';
  const banner = document.createElement('div');
  banner.className = 'banner';
  root.appendChild(banner);

  function render(s) {
    if (!s.declared_partitions || s.declared_partitions.length === 0) {
      banner.textContent = 'Sem partição declarada.';
      banner.classList.remove('ativa');
      return;
    }
    banner.classList.add('ativa');
    banner.textContent = 'Partição declarada: ' + s.declared_partitions.map(formatGroup).join(' | ');
  }

  const unsub = store.subscribe(render);
  return { destroy() { unsub(); } };
}
