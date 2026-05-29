export function register(bus, store) {
  bus.on('state', (e) => {
    store.updateNode(e.node, {
      role: e.role || 'follower',
      term: e.term || 0,
      commit_idx: e.commit_idx || 0,
      last_log_idx: e.last_log_idx || 0,
      last_applied: e.last_applied || 0,
    });
    if (e.heartbeat_ms) store.setHeartbeatMs(e.heartbeat_ms);
  });
}
