import { createBus } from './eventBus.js';
import { createStore } from './store.js';
import { connectSSE } from './sse.js';
import { HEARTBEAT_MS_FALLBACK, POLL_TICK_MS } from './config.js';

import * as stateHandler from './handlers/stateHandler.js';
import * as roleHandler from './handlers/roleHandler.js';
import * as rpcHandler from './handlers/rpcHandler.js';
import * as applyHandler from './handlers/applyHandler.js';
import * as replicationHandler from './handlers/replicationHandler.js';
import * as logEntryHandler from './handlers/logEntryHandler.js';

import * as topology from './views/topologyView.js';
import * as nodeCard from './views/nodeCardView.js';
import * as logs from './views/logPanelView.js';
import * as stream from './views/eventStreamView.js';
import * as controls from './views/controlsView.js';
import * as partitions from './views/partitionsView.js';
import * as summary from './views/summaryView.js';

const NODES = (window.RAFT_NODES || 'node1,node2,node3').split(',').map(s => s.trim()).filter(Boolean);

const bus = createBus();
// heartbeatMs inicial é fallback; o valor real chega no primeiro evento `state`
// e `stateHandler` chama `store.setHeartbeatMs` para atualizar.
const store = createStore({ nodeIds: NODES, heartbeatMs: HEARTBEAT_MS_FALLBACK });

stateHandler.register(bus, store);
roleHandler.register(bus, store);
rpcHandler.register(bus, store);
applyHandler.register(bus, store);
replicationHandler.register(bus, store);
logEntryHandler.register(bus, store);

topology.mount(document.getElementById('topologia'), store);
nodeCard.mount(document.getElementById('cards'), store);
logs.mount(document.getElementById('logs'), store);
stream.mount(document.getElementById('stream'), bus);
controls.mount(document.getElementById('controles'), store);
partitions.mount(document.getElementById('particoes'), store);
summary.mount(null, store);

connectSSE(NODES, bus);

setInterval(() => store.tickSilence(Date.now()), POLL_TICK_MS);
