import { durationFor } from '../config.js';

function packetKindFor(e) {
  if (e.type === 'rpc_send') {
    if (e.rpc === 'AppendEntries') return e.entries > 0 ? 'entries' : 'heartbeat';
    if (e.rpc === 'RequestVote') return 'vote';
    if (e.rpc === 'InstallSnapshot') return 'snapshot';
  }
  if (e.type === 'rpc_resp') {
    if (e.rpc === 'AppendEntriesResp') return 'appendResp';
    if (e.rpc === 'RequestVoteResp') return 'voteResp';
  }
  return 'heartbeat';
}

let packetCounter = 0;

export function register(bus, store) {
  bus.on('rpc_send', (e) => {
    if (!e.from || !e.to) return;
    const s = store.get();
    const kind = packetKindFor(e);
    const duration = durationFor(kind, s.heartbeat_ms);
    const packet = {
      id: `p${++packetCounter}`,
      from: e.from,
      to: e.to,
      rpc: e.rpc,
      entries: e.entries || 0,
      kind,
      term: e.term,
      success: undefined,
      granted: undefined,
      t_start: performance.now(),
      duration,
    };
    store.recordPacket(packet);
    setTimeout(() => store.removePacket(packet.id), duration + 50);
  });

  bus.on('rpc_resp', (e) => {
    if (!e.from || !e.to) return;
    const s = store.get();
    const kind = packetKindFor(e);
    const duration = durationFor(kind, s.heartbeat_ms);
    const packet = {
      id: `p${++packetCounter}`,
      from: e.from,
      to: e.to,
      rpc: e.rpc,
      entries: e.entries || 0,
      kind,
      term: e.term,
      success: e.success,
      granted: e.granted,
      t_start: performance.now(),
      duration,
    };
    store.recordPacket(packet);
    setTimeout(() => store.removePacket(packet.id), duration + 50);

    // Silêncio observado: AppendEntriesResp valida o link nos dois sentidos.
    if (e.rpc === 'AppendEntriesResp') {
      store.markRespSeen(e.from, e.to, Date.now());
    }
  });

  bus.on('rpc_recv', (_e) => {
    // Não anima pacote — o `rpc_send` correspondente já cobre. Stream textual mostra.
  });
}
