# Catálogo de Eventos SSE

Este documento lista todos os eventos publicados pelos nós Go e consumidos pelo dashboard. É o contrato entre `infra/node/` e `infra/dashboard/`. Qualquer alteração aqui deve refletir os três pontos de mudança (Go: emissão e struct; JS: handler) descritos no final.

## Origem comum

- Cada nó expõe `GET /events` em `:8100` como `text/event-stream`. Implementação em `infra/node/event.go` (`eventBus.serve`).
- O dashboard se conecta a `/events/nodeX` (proxy nginx) e abre um `EventSource` por nó.
- Todos os eventos compartilham a struct `event` em `infra/node/event.go`:

```go
type event struct {
    T           float64 `json:"t"`           // segundos desde boot do nó
    Type        string  `json:"type"`        // discriminador
    Node        string  `json:"node,omitempty"`
    Role        string  `json:"role,omitempty"`
    Term        uint64  `json:"term,omitempty"`
    CommitIndex uint64  `json:"commit_idx,omitempty"`
    LastLogIdx  uint64  `json:"last_log_idx,omitempty"`
    LastApplied uint64  `json:"last_applied,omitempty"`
    From        string  `json:"from,omitempty"`
    To          string  `json:"to,omitempty"`
    RPC         string  `json:"rpc,omitempty"`
    PrevIdx     uint64  `json:"prev_idx,omitempty"`
    Entries     int     `json:"entries,omitempty"`
    Success     bool    `json:"success,omitempty"`
    Granted     bool    `json:"granted,omitempty"`
    Index       uint64  `json:"index,omitempty"`
    Command     string  `json:"command,omitempty"`
    Key         string  `json:"key,omitempty"`
    Value       string  `json:"value,omitempty"`
}
```

Campos omitidos viram `undefined` no JS; sempre testar antes de usar.

## Tipos consumidos


### `state`

Snapshot periódico (a cada 500ms) de cada nó. Fonte de verdade para papel, term, índices.

| Campo | Significado |
|---|---|
| `node` | id do nó |
| `role` | `follower` / `candidate` / `leader` / `shutdown` |
| `term` | term Raft atual |
| `commit_idx` | maior índice comprometido conhecido |
| `last_log_idx` | maior índice já anexado ao log local |
| `last_applied` | maior índice já aplicado pela FSM |

Emissor: `pollState` em `infra/node/main.go`.

Handler: `js/handlers/stateHandler.js` → `store.updateNode`.

### `role_change`

Disparado pelo observer Raft quando o nó muda de papel.

| Campo | Significado |
|---|---|
| `node` | id do nó |
| `role` | novo papel |

Emissor: `observer.go` (caso `raft.RaftState`).

Handler: `js/handlers/roleHandler.js`.

Observação: pode chegar antes do próximo `state`, então o handler atualiza `role` direto na store.

### `leader_change`

Disparado quando o nó observa um novo líder no cluster.

| Campo | Significado |
|---|---|
| `node` | quem observou |
| `to` | id do novo líder |

Emissor: `observer.go` (caso `raft.LeaderObservation`).

Handler: `roleHandler.js` chama `store.setLeader(e.to)`.

### `peer_change`

Mudança de configuração de cluster.

| Campo | Significado |
|---|---|
| `node` | quem observou |
| `to` | id do peer adicionado/removido |

Emissor: `observer.go` (caso `raft.PeerObservation`).

Handler: `roleHandler.js` (apenas registra no stream; não muta topologia automaticamente porque `RAFT_NODES` é injetado em boot).

### `rpc_send`

RPC saindo deste nó.

| Campo | Significado |
|---|---|
| `node` | quem envia (= `from`) |
| `from` | id do remetente |
| `to` | id do destinatário |
| `rpc` | `AppendEntries` / `RequestVote` / `InstallSnapshot` |
| `term` | term anunciado |
| `prev_idx` | `PrevLogEntry` (só para AppendEntries) |
| `entries` | número de entradas anexadas (0 = heartbeat) |
| `index` | high-water mark tentativo (`prev_idx + entries`), só para AppendEntries com `entries>0` — preenchido pelo tracker de replicação |

Emissor: `transport.go` em `observingTransport.AppendEntries`, `.RequestVote`, `.InstallSnapshot`, e `observingPipeline.AppendEntries`.

Handler: `js/handlers/rpcHandler.js` → `store.recordPacket`.

### `rpc_resp`

Resposta de RPC chegando de volta.

| Campo | Significado |
|---|---|
| `node` | quem recebeu a resposta (= `to`) |
| `from` | id de quem respondeu |
| `to` | id de quem enviou a request |
| `rpc` | `AppendEntriesResp` / `RequestVoteResp` |
| `term` | term na resposta |
| `success` | só para AppendEntriesResp |
| `granted` | só para RequestVoteResp |
| `entries` | número de entradas que estavam na request original — distingue heartbeat-ack (0) de replication-ack (>0) |

**Truque importante**: como o `hashicorp/raft` usa um pipeline separado para AppendEntries de alta vazão (bypassa o método observado), `transport.go` envolve também o pipeline (`observingPipeline`) e correlaciona request com response. Sem isso, replicação não aparece. Ver `infra/node/transport.go:100-141`.

Handler: `rpcHandler.js` → atualiza `links[a|b].last_resp` no store (silêncio observado) e adiciona ao stream textual.

### `rpc_recv`

RPC chegando neste nó. **Apenas `RequestVote`** — `AppendEntries` recebido não gera `rpc_recv`. Razão e justificativa abaixo.

| Campo | Significado |
|---|---|
| `node` | quem recebe |
| `from` | quem enviou |
| `rpc` | `RequestVote` |
| `term` | term anunciado |

Emissor: `observer.go` (caso `raft.RequestVoteRequest`).

Handler: `rpcHandler.js` — apenas log textual; o `rpc_send` correspondente já gera o pacote animado.

#### Por que `AppendEntries` recebido não aparece aqui

`hashicorp/raft` expõe via `raft.Observer` somente um subconjunto fixo de observações: `RaftState`, `LeaderObservation`, `PeerObservation`, `RequestVoteRequest`, `FailedHeartbeatObservation`, `ResumedHeartbeatObservation`. **`AppendEntriesRequest` não está na lista** — a biblioteca não emite observação para AppendEntries chegando. Decisão upstream, provavelmente para evitar gargalo (AppendEntries é o caminho quente: heartbeats constantes + replicação).

Isso **não** é uma lacuna de telemetria no dashboard. Cada AppendEntries já aparece pelo lado do remetente:

```
nodeA (líder)                              nodeB (seguidor)
  │                                           │
  ├── rpc_send AppendEntries ────────────────▶│   visível (transport.go)
  │   (from=A, to=B, entries=N)               │
  │                                           │   chega aqui; nodeB NÃO emite rpc_recv
  │◀─── rpc_resp AppendEntriesResp ───────────┤   visível (observingPipeline)
       (from=B, to=A, success=true, entries=N)
```

O pacote animado no dashboard parte de A em direção a B (gerado por `rpc_send` de A). Emitir `rpc_recv` em B duplicaria visualmente o mesmo pacote. Para o painel textual de eventos, o par `rpc_send` + `rpc_resp` é informativo o suficiente — mostra ida e volta.

`RequestVote` é tratado de forma diferente porque o objetivo didático é evidenciar que **este nó recebeu um pedido de voto e tomou uma decisão** (concedeu ou negou). O candidato emite `rpc_send` para cada peer em broadcast; cada destinatário emite `rpc_recv` para deixar explícito no log textual quem recebeu o quê. O par `rpc_send`/`rpc_resp` por si só não tornaria evidente a decisão do receptor.

#### Como adicionar `rpc_recv` para `AppendEntries` se fosse necessário

Não é recomendado (duplica pacotes), mas para registro: seria preciso interceptar o canal `Consumer()` de `raft.Transport`, fazendo o `observingTransport` proxar todo o canal RPC antes de entregar à biblioteca. Custo: complexidade não-trivial em `transport.go` mais risco de perda de RPCs se o proxy travar. Fora do escopo desta atividade.

### `apply`

FSM aplicou um comando comprometido.

| Campo | Significado |
|---|---|
| `node` | id do nó |
| `index` | índice da entrada no log |
| `term` | term da entrada |
| `command` | `PUT` ou `DEL` (e `CAS` na Modificação B) |
| `key` | chave |
| `value` | valor (só para PUT) |

Emissor: `fsm.go` em `kvFSM.Apply`.

Handler: `js/handlers/applyHandler.js` → `store.appendLog(node, { ...e, committed: true })`.

### `replication` (novo)

Emitido pelo líder a cada 500ms, um por seguidor, com a sua visão do progresso de replicação daquele seguidor.

| Campo | Significado |
|---|---|
| `node` | id do líder |
| `to` | id do seguidor |
| `index` | maior índice já confirmado (`success=true`) por aquele seguidor (`match_index` na terminologia Raft) |

Emissor: `infra/node/replication.go` (novo arquivo) + hook em `transport.go` que alimenta o tracker em cada `AppendEntriesResp` com `success=true`.

Handler: `js/handlers/replicationHandler.js` → `store.setMatchIndex(leader, peer, index)`.

Renderizado em `nodeCardView` quando o nó é líder.

## Como adicionar um novo tipo de evento

São exatamente três pontos:

### 1. Lado Go — emissão

Em algum lugar do `infra/node/`, publique no bus:

```go
bus.publish(event{
    Type: "meu_evento",
    Node: nodeID,
    // ...campos relevantes
})
```

Se o seu evento precisar de um campo novo, edite `event.go` (struct `event`) e adicione o campo com `omitempty`. Mantenha o nome JSON em snake_case.

### 2. Lado JS — handler

Crie `infra/dashboard/js/handlers/meuEventoHandler.js`:

```js
export function register(bus, store) {
  bus.on('meu_evento', (e) => {
    store.update(s => {
      // mute o estado
    });
  });
}
```

Adicione um mutador correspondente em `store.js` se precisar.

### 3. Lado JS — registro

Em `main.js`, importe e chame `register`:

```js
import * as meuEvento from './handlers/meuEventoHandler.js';
// ...
meuEvento.register(bus, store);
```

Se quiser que o stream textual exiba o evento de forma legível, adicione um formatador em `eventStreamView.js` (caso default já mostra o JSON cru).

## Convenções

- **Term sempre logado** quando disponível — o invariante "term monotônico" é central; perder o term em um evento torna o dashboard inconsistente.
- **`from`/`to` sempre presentes em RPCs** — sem isso o pacote não pode ser animado.
- **`node` identifica o emissor da observação**, não o sujeito do evento. Em `peer_change`, `node` é quem observou e `to` é o peer afetado.
- **Tipos novos não devem reusar nomes de campos existentes com semântica diferente.** Se precisar de algo novo, adicione campo novo (cheap, `omitempty` cuida).
