// Abre um EventSource por nó e despacha cada mensagem no bus.
// `EventSource` faz reconnect automático; só logamos para visibilidade.

export function connectSSE(nodeIds, bus) {
  const sources = [];
  for (const id of nodeIds) {
    const url = `/events/${id}`;
    const es = new EventSource(url);
    es.onmessage = (msg) => {
      let evt;
      try { evt = JSON.parse(msg.data); } catch { return; }
      // Garantir que `node` seja a fonte do evento — alguns eventos chegam
      // sem `node` (não deveria, mas defensivo).
      if (!evt.node) evt.node = id;
      bus.dispatch(evt);
    };
    es.onerror = () => {
      // Browser fará reconnect; só logamos.
      console.warn(`[sse] erro em ${url}, tentando reconectar`);
    };
    sources.push(es);
  }
  return {
    close() { for (const es of sources) es.close(); }
  };
}
