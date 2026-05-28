export function register(bus, store) {
  bus.on('replication', (e) => {
    if (!e.node || !e.to) return;
    store.setMatchIndex(e.node, e.to, e.index || 0);
  });
}
