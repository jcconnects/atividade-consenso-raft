# Arquitetura do Dashboard

Este documento descreve a arquitetura interna do dashboard de visualização do cluster Raft. O dashboard é uma aplicação web estática (HTML + CSS + JavaScript puro com ES modules) servida por nginx. Não há build step, não há framework: a meta é manter o código auditável por estudantes de graduação enquanto preserva separação de responsabilidades suficiente para suportar extensões.

## Visão geral em camadas

```
┌──────────────────────────────────────────────────────────────┐
│ Navegador                                                    │
│ ┌──────────┐  ┌──────────┐  ┌────────────────────────────┐   │
│ │ Views    │←─│ Store    │←─│ Handlers                   │   │
│ │ (DOM/SVG)│  │ (estado) │  │ (mutadores por tipo)       │   │
│ └────┬─────┘  └────▲─────┘  └──────────▲─────────────────┘   │
│      │             │                   │                     │
│      │    (subscribe/notify)           │ (bus.on/onAny)      │
│      ▼             │                   │                     │
│  Eventos DOM   ┌───┴───────────────────┴───┐                 │
│  (cliques) ───▶│   Event bus (dispatcher)  │                 │
│                └───────────▲───────────────┘                 │
│                            │                                 │
│                    ┌───────┴────────┐                        │
│                    │ SSE (EventSrc) │                        │
│                    └───────▲────────┘                        │
└────────────────────────────┼─────────────────────────────────┘
                             │ HTTP SSE
        ┌────────────────────┴───────────────────────┐
        │ /events/node1   /events/node2   /events/N  │  ← nginx
        │      ▼               ▼               ▼     │     proxy
        │   node1:8100      node2:8100     nodeN:8100│
        └────────────────────────────────────────────┘
```

Caminho de um evento qualquer: o nó publica no seu próprio bus interno (Go); o nó serve `/events` como SSE; o nginx do dashboard repassa cada `/events/nodeX` para o nó correto; o `EventSource` no navegador recebe; o `sse.js` decodifica JSON e chama `bus.dispatch(evt)`; cada handler registrado para `evt.type` muta o `store`; o `store` notifica seus inscritos; cada view re-renderiza apenas o que mudou.

## Padrões de projeto aplicados

| Padrão | Onde | Por quê |
|---|---|---|
| **Event bus / Pub-sub** | `js/eventBus.js` | Desacopla origem do evento (SSE) dos consumidores. Permite múltiplos handlers para o mesmo tipo. |
| **Reactive store** | `js/store.js` | Única fonte de verdade do estado da UI. Views reagem a `subscribe`, não a eventos brutos. |
| **Handler registry** | `js/handlers/*.js` | Cada tipo de evento tem seu próprio módulo. Adicionar evento = adicionar arquivo + registrar. Não há `switch` gigante. |
| **View modules** | `js/views/*.js` | Cada view expõe `mount(root, store)` e se auto-inscreve. Sem framework, sem estado global de UI. |
| **Strategy chain (filtros)** | `js/filters.js` | Composição de filtros para o stream textual (ex.: esconder heartbeats) sem mutar a store. |
| **Façade de DOM/SVG** | `js/geometry.js` | Cálculos geométricos isolados; views consomem coordenadas, não trigonometria. |

## Contratos entre camadas

### `eventBus.js`

```js
createBus() → {
  on(type: string, handler: (evt) => void): () => void,  // retorna unsubscribe
  onAny(handler: (evt) => void): () => void,
  dispatch(evt: { type: string, ... }): void
}
```

Regras:
- Handlers de `on(type, ...)` recebem apenas eventos do tipo correspondente.
- `onAny` é usado pelo `eventStreamView` para o log textual.
- Erros em handlers são capturados e logados; nunca derrubam o bus.

### `store.js`

```js
createStore({ nodeIds, heartbeatMs }) → {
  get(): State,                                  // snapshot imutável
  getNode(id): NodeState,
  subscribe(listener: (state) => void): () => void,
  update(mutator: (draft) => void): void          // mutator estilo Immer-light (cópia rasa)
}
```

Formato do estado (versionado por simplicidade):

```js
{
  nodes: {
    [id]: {
      role: 'follower'|'candidate'|'leader'|'shutdown',
      term: number,
      commit_idx: number,
      last_log_idx: number,
      last_applied: number,
      last_seen: number,                  // Date.now() do último evento recebido deste nó
      match_index: { [peerId]: number },  // só preenchido quando o nó é líder
    }
  },
  links: {
    [aLessB]: {                           // chave canônica menor|maior
      last_resp: number,                  // Date.now() do último AppendEntriesResp ida-volta
      down: boolean,                      // derivado pelo tick de silêncio
    }
  },
  logs: {
    [id]: [{ index, term, command, key, value, committed }]
  },
  packets: [{ id, from, to, rpc, entries, t_start, duration }], // em-voo
  leader: string|null,
  max_term: number,
  declared_partitions: Array<Array<string>>,   // grupos aplicados via botão "Aplicar partição"
  pending_isolations: Set<string>,             // cards marcados via "Isolar", ainda não enviados
  applied_isolations: Set<string>,             // cards já aplicados (iptables ativo); botão vira "Liberar"
  heartbeat_ms: number,                        // recebido no primeiro evento `state`; usado por `durationFor`
  recently_applied: { [nodeId]: { [index]: timestamp_ms } },     // destaques transitórios em cells
  recently_committed_leader: { [nodeId]: { index, t_ms } },      // dispara badge "quórum" no card do líder
}
```

Mutadores expostos (todos passam por `update` internamente):

- `updateNode(id, partial)` — para `state`, `role_change`, `peer_change`.
- `setLeader(id)` — para `leader_change`.
- `recordPacket(packet)` — para `rpc_send` (anima 1 vez, depois auto-remove no fim da duração).
- `markRespSeen(a, b)` — para `rpc_resp` (atualiza `links[a|b].last_resp`).
- `appendLog(id, entry)` — para `apply`; também marca `recently_applied[id][index]` para o destaque transitório.
- `setMatchIndex(leader, peer, index)` — para `replication`.
- `setDeclaredPartitions(groups)` — chamado por `controlsView` após sucesso em `/control/partition`.
- `togglePendingIsolation(id)` — chamado por `nodeCardView` ao clicar `Isolar`/`Liberar`; muta `pending_isolations`.
- `clearPending()` — após sucesso em `/control/partition`, esvazia `pending_isolations` (a lista marcada vira persistente via `declared_partitions`).
- `setHeartbeatMs(ms)` — chamado pelo `stateHandler` quando o primeiro evento `state` chega com `heartbeat_ms`.
- `tickSilence(now)` — chamado pelo loop a cada 500ms; recomputa `links[*].down`.

### Handlers

Cada handler em `js/handlers/` exporta uma única função `register(bus, store)`. Convenção:

```js
// js/handlers/stateHandler.js
export function register(bus, store) {
  bus.on('state', (e) => {
    store.update(s => {
      const n = s.nodes[e.node];
      if (!n) return;
      n.role = e.role;
      n.term = e.term;
      n.commit_idx = e.commit_idx;
      n.last_log_idx = e.last_log_idx;
      n.last_applied = e.last_applied;
      n.last_seen = Date.now();
    });
  });
}
```

`main.js` apenas importa e chama `register(bus, store)` para cada handler. Adicionar um novo tipo de evento é uma alteração de um único arquivo (ver `EXTENSAO.md`).

### Views

```js
// padrão de qualquer view
export function mount(root, store) {
  // 1) cria a estrutura DOM/SVG inicial
  // 2) inscreve-se: const unsub = store.subscribe(state => render(state))
  // 3) retorna { destroy: () => unsub() }
}
```

Convenções:
- Views nunca leem `bus` diretamente (exceção: `eventStreamView` usa `bus.onAny`).
- Views nunca escrevem na `store` exceto via callbacks de UI (ex.: `controlsView` chama `store.setDeclaredPartitions` após sucesso da API).
- Toda re-renderização é idempotente; não há ciclo de vida além de `mount`/`destroy`.

#### `logPanelView` — formato matricial

O painel `Logs replicados` usa layout matriz: uma linha por **índice** do log Raft (decrescente, mais recente no topo), uma coluna por **nó**. Cada célula representa o estado da entrada *daquele índice* *naquele nó*. Quatro estados visuais:

| Visual | Significado | Origem da informação |
|---|---|---|
| `PUT chave=valor` em verde | Entrada aplicada na FSM (comprometida e replicada localmente) | evento `apply` |
| `em voo` em amarelo itálico | `last_log_idx ≥ índice > commit_idx` neste nó: anexada mas não comprometida | derivado de `state` (last_log_idx vs commit_idx) |
| `· comprometida ·` em cinza | `commit_idx ≥ índice` mas evento `apply` não foi capturado nesta sessão (refresh do navegador mid-flight) | derivado de `state` |
| `—` (traço) | Nó ainda não recebeu/aplicou essa entrada | ausência em `logs[id]` e `last_log_idx < índice` |

Diferenças entre células do mesmo índice tornam visualmente óbvio: replicação em andamento, log zumbi de nó isolado, ou divergência de term (célula com fundo avermelhado).

##### Destaques transitórios

Para tornar a sequência de consolidação observável a olho nu, dois destaques temporários são acionados por eventos reais (sem antecipar nem atrasar nada):

- **`.recem-aplicado` (1500ms, fade-out)** — célula que acaba de virar comprometida pulsa verde forte com contorno. Dispara na chegada do evento `apply` daquele nó. Líder pulsa primeiro (aplica logo após `commit_idx` subir); seguidores pulsam depois (quando o próximo heartbeat carregando `leader_commit` chega e cada um aplica). A defasagem temporal é a defasagem real do Raft.
- **`.badge-quorum` no card do líder (2000ms)** — surge quando o evento `state` daquele nó traz `commit_idx` maior que o anterior, e o nó é líder. Marca o momento exato em que o líder contabilizou maioria de acks. O badge mostra o índice consolidado.

Ambos os destaques são puramente visuais: o estado subjacente (célula verde, valor de `commit_idx`) é o mesmo antes, durante e depois do destaque. Removê-los não muda o que o dashboard "sabe", só a chamada de atenção.

## Fluxo do `main.js`

```js
import { createStore } from './store.js';
import { createBus } from './eventBus.js';
import { connectSSE } from './sse.js';
import * as state from './handlers/stateHandler.js';
import * as role from './handlers/roleHandler.js';
import * as rpc from './handlers/rpcHandler.js';
import * as apply from './handlers/applyHandler.js';
import * as replication from './handlers/replicationHandler.js';
import * as topology from './views/topologyView.js';
import * as cards from './views/nodeCardView.js';
import * as logs from './views/logPanelView.js';
import * as stream from './views/eventStreamView.js';
import * as controls from './views/controlsView.js';
import * as partitions from './views/partitionsView.js';
import { HEARTBEAT_MS_FALLBACK } from './config.js';

const NODES = (window.RAFT_NODES || 'node1,node2,node3').split(',');

const bus = createBus();
// heartbeatMs inicial é fallback; o valor real chega no primeiro evento `state`
// (campo heartbeat_ms) e `stateHandler` chama `store.setHeartbeatMs` para atualizar.
const store = createStore({ nodeIds: NODES, heartbeatMs: HEARTBEAT_MS_FALLBACK });

state.register(bus, store);
role.register(bus, store);
rpc.register(bus, store);
apply.register(bus, store);
replication.register(bus, store);

topology.mount(document.getElementById('topologia'), store);
cards.mount(document.getElementById('cards'), store);
logs.mount(document.getElementById('logs'), store);
stream.mount(document.getElementById('stream'), bus);
controls.mount(document.getElementById('controles'), store);
partitions.mount(document.getElementById('particoes'), store);

connectSSE(NODES, bus);

setInterval(() => store.tickSilence(Date.now()), 500);
```

## Política de erros

- Falhas de `EventSource` são reconectadas pelo navegador automaticamente; `sse.js` registra reconnects.
- Falhas em handlers são logadas com `console.error` mas não propagam.
- Falhas em chamadas a `/control/*` aparecem como toasts no `controlsView` e não alteram a store (a store reflete apenas o que foi observado).

## O que não pertence a esta camada

- Lógica do algoritmo Raft. O dashboard é leitor passivo; toda a verdade vem do Go.
- Cache persistente. Refresh = estado zerado, re-hidratado pelos eventos `state` que chegam a cada 500ms.
- Autenticação. Atividade didática em rede local; broker e SSE são abertos.
