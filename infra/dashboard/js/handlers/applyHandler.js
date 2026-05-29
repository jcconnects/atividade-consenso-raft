export function register(bus, store) {
  bus.on('apply', (e) => {
    store.appendLog(e.node, {
      index: e.index,
      term: e.term,
      command: e.command,
      key: e.key,
      value: e.value,
      committed: true,
    });
  });
}
