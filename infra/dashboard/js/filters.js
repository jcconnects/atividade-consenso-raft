// Filtros de stream textual. Cada filtro é evt => bool (true = mantém).
// Composição: linhas que passam todos os filtros aparecem.

export const filters = {
  hideHeartbeats(evt) {
    if (evt.type === 'rpc_send' && evt.rpc === 'AppendEntries' && (evt.entries || 0) === 0) return false;
    if (evt.type === 'rpc_resp' && evt.rpc === 'AppendEntriesResp' && (evt.entries || 0) === 0) return false;
    return true;
  },
  hideStateSnapshots(evt) {
    return evt.type !== 'state';
  },
  hideReplication(evt) {
    return evt.type !== 'replication';
  },
};

export function composeFilters(active) {
  const list = active.map(name => filters[name]).filter(Boolean);
  return (evt) => list.every(f => f(evt));
}
