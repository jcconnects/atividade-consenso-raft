// Pub/sub tipado. Handlers registram-se por `type`; `onAny` recebe tudo.
// Erros em handlers são capturados e logados, nunca propagam.

export function createBus() {
  const byType = new Map();
  const anyHandlers = new Set();

  function on(type, handler) {
    if (!byType.has(type)) byType.set(type, new Set());
    byType.get(type).add(handler);
    return () => byType.get(type).delete(handler);
  }

  function onAny(handler) {
    anyHandlers.add(handler);
    return () => anyHandlers.delete(handler);
  }

  function dispatch(evt) {
    const handlers = byType.get(evt.type);
    if (handlers) {
      for (const h of handlers) {
        try { h(evt); } catch (err) { console.error('bus handler', evt.type, err); }
      }
    }
    for (const h of anyHandlers) {
      try { h(evt); } catch (err) { console.error('bus onAny', err); }
    }
  }

  return { on, onAny, dispatch };
}
