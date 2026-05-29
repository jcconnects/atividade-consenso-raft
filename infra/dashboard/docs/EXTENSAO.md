# Receitas de Extensão

Este documento lista, na forma de receitas curtas, como adicionar funcionalidades comuns ao dashboard. É a continuação prática de `ARQUITETURA.md` e `EVENTOS.md`.

## 1. Adicionar um nó (Modificação A — cluster de 5)

Três alterações em `docker-compose.yml` na raiz:

1. **Duplicar uma service `nodeN`** preservando bind ports/dependências:
   ```yaml
   node4:
     build:
       context: ./infra/node
     container_name: node4
     hostname: node4
     cap_add: [NET_ADMIN]
     networks: [rede-raft]
     environment:
       NODE_ID: node4
       RAFT_ADDR: 0.0.0.0:7000
       HTTP_ADDR: 0.0.0.0:9000
       EVENT_ADDR: 0.0.0.0:8100
       DATA_DIR: /data
       RAFT_PEERS: "node1=node1:7000,node2=node2:7000,node3=node3:7000,node4=node4:7000,node5=node5:7000"
       RAFT_BOOTSTRAP: "false"
       RAFT_HEARTBEAT_MS: "5000"
     volumes: [node4-data:/data]
     expose: ["7000", "8100", "9000"]
     ports: ["9004:9000"]
   ```
2. **Atualizar `RAFT_PEERS` em TODOS os nós** (inclusive node1, 2, 3) para listar os cinco. A configuração tem que ser idêntica.
3. **Atualizar `RAFT_NODES` na service `dashboard` e na `broker`** para `"node1,node2,node3,node4,node5"`.

Adicionar volume nomeado em `volumes:`:
```yaml
volumes:
  node1-data:
  node2-data:
  node3-data:
  node4-data:
  node5-data:
```

Aplicar:
```bash
docker compose down -v       # CRUCIAL: limpa cluster config persistida em bolt
docker compose up --build
```

Sem o `down -v`, o cluster bolt persistido em `/data` ainda guarda a configuração de 3 nós e ignora os novos.

O dashboard adapta o layout automaticamente porque `nginx.conf.template` injeta `window.RAFT_NODES` via `sub_filter`, e `js/main.js` faz `.split(',')`.

## 2. Adicionar um novo tipo de RPC ou evento

Ver `EVENTOS.md` → "Como adicionar um novo tipo de evento" (três pontos: emissão Go, handler JS, registro em `main.js`).

Se o novo evento corresponde a um pacote que deve animar:
1. Adicionar entrada na tabela em `js/config.js → RPC_COLORS` (cor, duração, tamanho).
2. `rpcHandler.js` já genericamente chama `store.recordPacket` para qualquer `rpc_send`; se o nome novo tiver visuais diferentes, o switch é em `RPC_COLORS`, não no handler.

## 3. Adicionar um novo painel

Exemplo: painel "Histórico de eleições" mostrando uma linha do tempo de `role_change` e `leader_change`.

Passos:

1. Adicionar uma `<section id="historico-eleicoes"></section>` em `index.html` (na coluna apropriada — typically a coluna direita junto com `#stream`).
2. Criar `js/views/electionHistoryView.js`:
   ```js
   export function mount(root, store) {
     const list = document.createElement('ol');
     list.className = 'election-history';
     root.appendChild(list);

     const events = [];
     const unsub = store.subscribe(state => {
       // Não precisa: melhor inscrever-se no bus diretamente para esta view,
       // já que ela é puramente histórica. Ver opção B abaixo.
     });
     return { destroy: () => unsub() };
   }
   ```
   **Opção B (recomendada para views históricas)**: receba o `bus` em vez do `store` e inscreva-se nos tipos relevantes:
   ```js
   export function mount(root, bus) {
     const list = document.createElement('ol');
     root.appendChild(list);
     bus.on('leader_change', e => {
       const li = document.createElement('li');
       li.textContent = `${new Date().toLocaleTimeString()} — novo líder: ${e.to}`;
       list.prepend(li);
       while (list.children.length > 50) list.lastChild.remove();
     });
   }
   ```
3. Em `main.js`:
   ```js
   import * as electionHistory from './views/electionHistoryView.js';
   electionHistory.mount(document.getElementById('historico-eleicoes'), bus);
   ```
4. Estilizar em `style.css` (siga o tema escuro existente via variáveis CSS).

## 4. Adicionar um novo controle (botão)

Regra de localização:

| Tipo de ação | Onde vive | Exemplos existentes |
|---|---|---|
| Afeta o cluster como um todo | `controlsView` (header) | `Matar líder`, `Curar tudo`, `Put aleatório`, `Aplicar partição` |
| Afeta um nó específico | `nodeCardView` (botões no card) | `Matar`, `Isolar`/`Liberar`, `Curar este nó` |

Por que isso importa: ações por-nó escalam automaticamente para N nós (cada card herda os mesmos botões); ações globais não precisam de seletor de nó. Estudantes encontram o controle no lugar espacial correto.

### Exemplo 1 — controle global ("Forçar snapshot em todos")

1. **Lado broker**: adicionar tratamento em `infra/broker/broker.py`:
   ```python
   if path == "/snapshot-all":
       for node in NODES:
           # ... executar docker exec node curl ... ou comando equivalente
           pass
       return reply(self, 200, {"ok": True})
   ```
2. **Lado dashboard**: em `controlsView.js`, adicionar um `<button>` no header:
   ```js
   const btn = document.createElement('button');
   btn.textContent = 'Forçar snapshot global';
   btn.onclick = () => fetch('/control/snapshot-all', { method: 'POST' });
   header.appendChild(btn);
   ```

### Exemplo 2 — controle por-nó ("Forçar snapshot deste nó")

1. **Lado broker**: tratamento similar, recebendo `{node}` no body:
   ```python
   if path == "/snapshot":
       node = body.get("node")
       # ...
       return reply(self, 200, {"ok": True})
   ```
2. **Lado dashboard**: em `nodeCardView.js`, dentro da função que constrói cada card, adicionar o botão na seção `.node-actions`:
   ```js
   const btn = el('button.snap', 'Forçar snapshot');
   btn.onclick = () => fetch('/control/snapshot', {
     method: 'POST',
     headers: {'Content-Type': 'application/json'},
     body: JSON.stringify({ node: id }),
   });
   actions.appendChild(btn);
   ```
3. **Visibilidade condicional**: se o botão só deve aparecer em certo estado (ex.: nó é líder), envolva em `if`:
   ```js
   if (n.role === 'leader') actions.appendChild(btn);
   ```

### Sem alteração em store/bus

Controles disparam efeitos colaterais; a store reage apenas a eventos SSE de volta dos nós. Exceções legítimas: ações que precisam de estado pendente local antes do commit, como `Isolar` (que acumula em `store.pending_isolations` antes de `Aplicar partição` enviar a request única).

## 5. Adicionar um campo novo no card de nó

Exemplo: mostrar `last_applied` separado de `commit_idx`.

1. Já está na struct `event` e na store (campo `last_applied`). Basta editar `nodeCardView.js`:
   ```js
   const stats = box.querySelector('.node-stats');
   stats.innerHTML = `
     term: ${n.term}<br>
     commit: ${n.commit_idx}<br>
     last_log: ${n.last_log_idx}<br>
     applied: ${n.last_applied}
   `;
   ```
2. Sem alteração em handlers, store ou Go.

## 6. Adicionar um filtro novo no stream textual

Exemplo: esconder `peer_change`.

1. Em `js/filters.js`, adicionar:
   ```js
   export const hidePeerChange = (evt) => evt.type !== 'peer_change';
   ```
2. Em `eventStreamView.js`, ligar via checkbox UI (mesmo padrão do `hide-heartbeats` existente). Filtros são composição funcional: `evt => filtros.every(f => f(evt))`.

## 7. Trocar a fonte de partições (opt-in)

Se algum dia quiser confiar nas partições declaradas em vez de silêncio observado:

1. Em `js/views/topologyView.js`, substituir a lógica de `down` por uma derivação de `state.declared_partitions`.
2. Remover o `tickSilence` do `main.js`.

**Não recomendado** — desfaz a propriedade documentada em `PARTICAO.md`.

## 8. Persistir o estado entre refresh

A store é volátil por design. Para persistir, em `main.js` envolva `store.subscribe`:

```js
store.subscribe(s => {
  localStorage.setItem('raft-dash', JSON.stringify({
    leader: s.leader,
    max_term: s.max_term,
    // ... só campos serializáveis e úteis
  }));
});
```

E hidrate no boot. Cuidado: estado persistido conflitará com o primeiro `state` real que chega — prefira ignorar o persistido e re-hidratar do SSE (chega em 500ms de qualquer forma).

## Checklist antes de fazer commit

- [ ] Strings de UI estão em pt-BR.
- [ ] Não adicionou dependência npm (este projeto é zero-build).
- [ ] Não adicionou comentário explicando "o que" o código faz; apenas "por quê" (ver `CLAUDE.md`).
- [ ] Eventos novos têm tipo único e estão em `EVENTOS.md`.
- [ ] Se mexeu em Go, rodou `docker compose up --build` e verificou no navegador.
