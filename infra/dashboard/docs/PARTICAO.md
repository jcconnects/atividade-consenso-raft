# Partição: Declarada vs Observada

Este documento explica como o dashboard representa partições de rede e por que escolhe inferir conectividade a partir do tráfego observado em vez de confiar apenas em cliques de botão.

## Mecanismo único: iptables na porta 7000

A atividade usa um único mecanismo para isolar nós: regras `iptables` que dropam tráfego TCP na porta 7000 (RPC Raft) entre os nós envolvidos. O contêiner segue rodando e respondendo na porta 8100 (event stream), portanto o nó **continua visível no dashboard** — seu card permanece, seu term sobe conforme tenta eleições solitárias, mas nenhum pacote Raft atravessa a barreira.

Esse mecanismo é compartilhado por duas interfaces:

| Interface | Implementação |
|---|---|
| Botões `Isolar` nos cards + `Aplicar partição` no header | POST `/control/partition` → broker `infra/broker/broker.py` executa `docker exec <node> iptables ...` |
| Script `./infra/scripts/partition.sh` | mesmo `docker exec <node> iptables ...` em loop, sem passar pelo broker |

`heal` (botão ou `./infra/scripts/heal.sh`) sempre executa `iptables -F INPUT && iptables -F OUTPUT` em cada nó. Isso garante restauração simétrica e idempotente.

**Decisão histórica**: versões anteriores do `partition.sh` usavam `docker network disconnect`. Foi removido porque modelava "host completamente offline" (sem SSE, dashboard perdia o nó), que já é coberto pelo botão `Kill node`. Partição de rede no mundo real é exatamente "nós vivos sem se falar" — `iptables` modela isso fielmente.

## Solução: silêncio observado como fonte de verdade

A nova arquitetura deriva o estado de cada link a partir do tráfego que **realmente** chega ao SSE. Conceito-chave: em operação normal, o líder envia `AppendEntries` heartbeat para cada seguidor a cada `HEARTBEAT_MS` (default 5000ms, configurável via env `RAFT_HEARTBEAT_MS` no `docker-compose.yml`), e cada seguidor responde com `AppendEntriesResp`. Se um link estiver quebrado em qualquer direção, esse fluxo para — e o dashboard nota.

### Chave canônica de link

Liks são bidirecionais; usar chave ordenada lexicograficamente:

```js
linkKey(a, b) = (a < b) ? `${a}|${b}` : `${b}|${a}`
```

### Marcação de "vivo"

Em cada `rpc_resp` do tipo `AppendEntriesResp`:

```js
store.update(s => {
  s.links[linkKey(e.from, e.to)].last_resp = Date.now();
});
```

`from` é quem respondeu e `to` é o líder. A direção da resposta confirma que ambos os sentidos do TCP estão funcionando (TCP exige ack para entregar o request original), então um único `rpc_resp` valida o link inteiro.

### Tick de silêncio

A cada 500ms, recomputar `down`:

```js
const limite = 2 * HEARTBEAT_MS;
store.update(s => {
  const agora = Date.now();
  for (const k in s.links) {
    s.links[k].down = (agora - s.links[k].last_resp) > limite;
  }
});
```

O fator 2× tolera um heartbeat perdido sem alarme falso. No default (`HEARTBEAT_MS = 5000`), o limite é 10s — confortavelmente acima do election timeout (`2 × HEARTBEAT_MS`), então a UI não pisca durante eleições normais.

### Caso especial: nó sem SSE

Se o EventSource para `nodeX` cair (contêiner parado via `docker stop` ou `Kill node`), `nodeX` para de emitir qualquer evento, e nenhum outro nó emite `rpc_resp` envolvendo ele. Resultado: **todos os links incidentes em `nodeX` ficam `down`**, e o card de `nodeX` ganha `class="stale"` (último `state` há mais de 2 segundos). Isso comunica visualmente "nó sumiu" sem precisar de mecanismo separado.

## Camada secundária: partições declaradas

A interface de criação de partição vive nos próprios cards de nó. Cada card tem um botão **`Isolar`** (toggle: vira **`Liberar`** quando ativo). O fluxo é:

1. Estudante clica `Isolar` em um ou mais cards. Cada clique adiciona o nó a `store.pending_isolations` e marca o card com borda tracejada vermelha (estado pendente, ainda não aplicado).
2. Enquanto há nós pendentes, um botão flutuante surge no header: **`Aplicar partição (N marcados)`**.
3. Estudante clica `Aplicar partição`. O dashboard envia POST `/control/partition` com `{isolate: [...marcados], majority: [resto dos nós conhecidos]}`. Em sucesso:
   - `store.setDeclaredPartitions([isolate, majority])` registra a intenção declarada.
   - `pending_isolations` é mantido para que cada card individual saiba que está em estado "isolado aplicado".
4. `partitionsView` exibe um banner pt-BR: *"Partição declarada: (node1) | (node2, node3)"*.
5. Para reverter, estudante clica `Liberar` no card individual (limpa só aquele nó), ou `Curar tudo` no header (limpa todos os iptables via `/control/heal`).

Esse desenho é trivialmente extensível para N nós: a UI percorre `RAFT_NODES` em vez de carregar presets como `(1)|(2,3)`. Adicionar `node4`/`node5` ao compose habilita partições com eles automaticamente.

A camada visual de links **ignora** esse estado declarado. Ele é puramente informativo — diz ao estudante o que ele pediu, não o que está acontecendo.

Isso elimina toda a possibilidade de descompasso entre intenção e realidade:

| Cenário | Banner declarado | Links no diagrama |
|---|---|---|
| Estudante clica `Isolar` em `node1` e depois `Aplicar partição` | mostra `(node1) | (node2, node3)` | n1↔n2 e n1↔n3 ficam cinza após ~1s |
| Estudante marca `Isolar` em `node1` e `node2`, depois `Aplicar partição` | mostra `(node1, node2) | (node3)` | n1↔n3 e n2↔n3 ficam cinza após ~1s |
| Estudante roda `./partition.sh node2` no terminal | vazio | n2↔n1 e n2↔n3 ficam cinza após ~1s |
| Estudante clica `Liberar` no card de `node1` ou `Curar tudo` no header | vazio | links restauram após primeiro heartbeat bem-sucedido |
| Estudante clica `Matar` no card de `node3` (ou `Kill leader` se for líder) | vazio | card `node3` fica "stale", links incidentes ficam cinza |
| Estudante clica `Curar este nó` em `node3` parado | vazio | card volta ao normal; links incidentes restauram |

A leitura "links cinza = não há tráfego entre estes nós" é sempre verdadeira, qualquer que seja a causa.

## Implementação

| Responsabilidade | Onde |
|---|---|
| Marcar `last_resp` por link | `js/handlers/rpcHandler.js` |
| Tick de silêncio | `js/main.js` (`setInterval(500)` → `store.tickSilence`) |
| Recomputar `down` | `js/store.js` (`tickSilence`) |
| Renderizar link cinza | `js/views/topologyView.js` (CSS class `broken` na linha SVG) |
| Banner declarado | `js/views/partitionsView.js` |
| Botão | `js/views/controlsView.js` |

## Trade-off explícito

A camada observada **leva 1 a 2× `HEARTBEAT_MS` para refletir uma partição**. No default isso é 5–10s — o estudante percebe visualmente que houve um atraso entre clicar e ver o link sumir. Esse atraso é **didaticamente útil**: corresponde ao tempo real durante o qual o líder ainda acha que tem o cluster (antes de perder seu lease) e dá ao estudante uma percepção visceral do "lease timeout" do Raft. Para tornar a observação ainda mais lenta, editar `RAFT_HEARTBEAT_MS=10000` no compose e fazer `docker compose down -v && up --build`.

Se o usuário quiser feedback instantâneo, ele pode olhar o stream textual de eventos — `rpc_send` continua sendo emitido pelo líder mesmo quando os pacotes estão sendo dropados pelo iptables (o `transport.go` publica antes de retornar erro). Os "resps" é que não chegam.
