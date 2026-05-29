export function register(bus, store) {
  bus.on('role_change', (e) => {
    store.updateNode(e.node, { role: e.role });
  });
  bus.on('leader_change', (e) => {
    if (e.to) store.setLeader(e.to);
  });
  bus.on('peer_change', (_e) => {
    // Sem mutação automática de topologia; lista de nós vem de RAFT_NODES no boot.
  });
}
