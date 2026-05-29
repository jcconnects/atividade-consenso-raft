// `log_entry` events são emitidos pelo transport do líder a cada entrada
// enviada em AppendEntries. O campo `to` identifica o follower de destino —
// populamos o log dele assim que vemos a entrada na rede, sem depender do
// evento `apply` (que pode ter sido perdido durante reconexão SSE).
//
// Marcamos a entrada como `committed: false`: ela está no log do follower
// mas pode ainda não ter sido aplicada. O painel decidirá entre "em voo" e
// "comprometido" usando `commit_idx` do `state` event.
export function register(bus, store) {
  bus.on('log_entry', (e) => {
    if (!e.to || !e.index) return;
    store.appendLog(e.to, {
      index: e.index,
      term: e.term,
      command: e.command,
      key: e.key,
      value: e.value,
      committed: false,
    });
  });
}
