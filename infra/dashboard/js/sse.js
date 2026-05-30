// Abre um EventSource por nó e despacha cada mensagem no bus.
// `EventSource` faz reconnect automático; só logamos para visibilidade.
//
// Snapshot-on-open: cada vez que a conexão SSE estabiliza (open inicial OU
// reconexão após falha), buscamos `/log/<node>` para popular o painel com o
// log persistido no nó. Isso fecha a lacuna em que entradas chegam ao nó
// antes do dashboard reconectar (catch-up pós-revive, reconciliação de
// follower pós-partição). Padrão snapshot+tail, igual `kubectl logs -f`.

async function fetchSnapshot(id, bus) {
  try {
    const r = await fetch(`/log/${id}`);
    if (!r.ok) return;
    const body = await r.json();
    for (const e of (body.entries || [])) {
      bus.dispatch({
        type: 'log_entry',
        node: id,
        from: id,
        to: id,
        index: e.index,
        term: e.term,
        command: e.command,
        key: e.key,
        value: e.value,
      });
    }
  } catch (err) {
    console.warn(`[sse] snapshot /log/${id} falhou:`, err);
  }
}

export function connectSSE(nodeIds, bus) {
  const sources = [];
  for (const id of nodeIds) {
    const url = `/events/${id}`;
    const es = new EventSource(url);
    es.onopen = () => fetchSnapshot(id, bus);
    es.onmessage = (msg) => {
      let evt;
      try { evt = JSON.parse(msg.data); } catch { return; }
      if (!evt.node) evt.node = id;
      bus.dispatch(evt);
    };
    es.onerror = () => {
      console.warn(`[sse] erro em ${url}, tentando reconectar`);
    };
    sources.push(es);
  }
  return {
    close() { for (const es of sources) es.close(); }
  };
}
