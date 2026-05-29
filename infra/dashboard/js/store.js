import { LOG_WINDOW } from './config.js';

// Store reativo: muta um draft via `update`, notifica inscritos.
// Cópia de referência rasa (Object.assign) por chamada de update para
// invalidar comparações === em views se quiserem.

export function createStore({ nodeIds, heartbeatMs }) {
  const nodes = {};
  for (const id of nodeIds) {
    nodes[id] = {
      id,
      role: 'follower',
      term: 0,
      commit_idx: 0,
      last_log_idx: 0,
      last_applied: 0,
      last_seen: 0,
      match_index: {},
    };
  }
  const links = {};
  for (let i = 0; i < nodeIds.length; i++) {
    for (let j = i + 1; j < nodeIds.length; j++) {
      links[linkKey(nodeIds[i], nodeIds[j])] = {
        last_resp: Date.now(),
        down: false,
      };
    }
  }

  let state = {
    node_ids: nodeIds.slice(),
    nodes,
    links,
    logs: Object.fromEntries(nodeIds.map(id => [id, []])),
    packets: [],
    leader: null,
    max_term: 0,
    declared_partitions: [],
    pending_isolations: new Set(),
    applied_isolations: new Set(),
    heartbeat_ms: heartbeatMs,
    // Destaques transitórios — guardam timestamp do evento real (não do dashboard).
    // Cada view decide quanto tempo manter o destaque após o timestamp.
    recently_applied: {},      // { [nodeId]: { [index]: timestamp_ms } }
    recently_committed_leader: {}, // { [nodeId]: { index, t_ms } } — só preenche quando o nó é líder e commit_idx subiu
  };

  const subs = new Set();

  function notify() {
    state = { ...state }; // novo handle de referência
    for (const fn of subs) {
      try { fn(state); } catch (err) { console.error('store subscriber', err); }
    }
  }

  function update(mutator) {
    mutator(state);
    notify();
  }

  return {
    get: () => state,
    getNode: (id) => state.nodes[id],
    subscribe(fn) {
      subs.add(fn);
      fn(state);
      return () => subs.delete(fn);
    },
    update,

    updateNode(id, partial) {
      update(s => {
        const n = s.nodes[id];
        if (!n) return;
        const oldCommit = n.commit_idx;
        const oldRole = n.role;
        Object.assign(n, partial);
        n.last_seen = Date.now();
        if (n.term > s.max_term) s.max_term = n.term;
        if (n.role === 'leader') s.leader = id;
        // D: badge "quórum atingido" — disparado quando commit_idx avança
        // num nó que é líder. Reflete o exato momento em que o líder
        // contabilizou maioria de acks para uma entrada.
        const isLeader = n.role === 'leader' || partial.role === 'leader' || oldRole === 'leader';
        if (isLeader && partial.commit_idx !== undefined && partial.commit_idx > oldCommit) {
          s.recently_committed_leader = {
            ...s.recently_committed_leader,
            [id]: { index: partial.commit_idx, t_ms: Date.now() },
          };
        }
      });
    },

    setLeader(id) {
      update(s => { if (id) s.leader = id; });
    },

    recordPacket(packet) {
      update(s => { s.packets = [...s.packets, packet]; });
    },

    removePacket(id) {
      update(s => { s.packets = s.packets.filter(p => p.id !== id); });
    },

    markRespSeen(a, b, t) {
      update(s => {
        const k = linkKey(a, b);
        if (!s.links[k]) s.links[k] = { last_resp: t, down: false };
        else s.links[k].last_resp = t;
      });
    },

    appendLog(id, entry) {
      update(s => {
        const arr = s.logs[id] || (s.logs[id] = []);
        const existing = arr.findIndex(e => e.index === entry.index);
        if (existing >= 0) {
          // Preserva committed=true se já era — `log_entry` chegando depois
          // de `apply` não pode regredir o estado.
          const prev = arr[existing];
          arr[existing] = {
            ...prev,
            ...entry,
            committed: prev.committed || entry.committed,
          };
        } else {
          arr.push(entry);
        }
        if (arr.length > LOG_WINDOW) arr.splice(0, arr.length - LOG_WINDOW);
        // Destaque transitório só quando a entrada foi de fato aplicada.
        if (entry.committed) {
          if (!s.recently_applied[id]) s.recently_applied[id] = {};
          s.recently_applied[id] = { ...s.recently_applied[id], [entry.index]: Date.now() };
        }
      });
    },

    setMatchIndex(leader, peer, index) {
      update(s => {
        const n = s.nodes[leader];
        if (!n) return;
        n.match_index = { ...n.match_index, [peer]: index };
      });
    },

    setDeclaredPartitions(groups) {
      update(s => { s.declared_partitions = groups; });
    },

    clearDeclaredPartitions() {
      update(s => {
        s.declared_partitions = [];
        s.pending_isolations = new Set();
        s.applied_isolations = new Set();
      });
    },

    togglePendingIsolation(id) {
      update(s => {
        const next = new Set(s.pending_isolations);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        s.pending_isolations = next;
      });
    },

    commitPending() {
      // Após /control/partition bem-sucedido: move pendentes para applied.
      update(s => {
        const applied = new Set(s.applied_isolations);
        for (const id of s.pending_isolations) applied.add(id);
        s.applied_isolations = applied;
        s.pending_isolations = new Set();
      });
    },

    releaseApplied(id) {
      // Após /control/heal-node bem-sucedido para um nó já aplicado.
      update(s => {
        const next = new Set(s.applied_isolations);
        next.delete(id);
        s.applied_isolations = next;
        // Recalcula declared_partitions: se aplicados ficou vazio, limpa banner.
        if (next.size === 0) s.declared_partitions = [];
        else {
          const isolate = [...next];
          const majority = s.node_ids.filter(n => !next.has(n));
          s.declared_partitions = [isolate, majority];
        }
      });
    },

    setHeartbeatMs(ms) {
      update(s => { if (ms && s.heartbeat_ms !== ms) s.heartbeat_ms = ms; });
    },

    tickSilence(now) {
      update(s => {
        const limit = 2 * s.heartbeat_ms;
        const newLinks = {};
        for (const k in s.links) {
          const l = s.links[k];
          newLinks[k] = { ...l, down: (now - l.last_resp) > limit };
        }
        s.links = newLinks;
      });
    },
  };
}

export function linkKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
