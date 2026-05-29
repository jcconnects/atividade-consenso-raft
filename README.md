# Atividade Prática: Consenso com Raft e Visualizador ao Vivo

## Pré-requisitos

- [Git](https://git-scm.com/)
- [Docker](https://docs.docker.com/get-docker/) com [Docker Compose](https://docs.docker.com/compose/)
- Um navegador web moderno (Firefox, Chrome, Safari) — o visualizador roda em `localhost:8080`

Verifique com:
```bash
docker compose version
```

Nenhuma instalação de Go é necessária — o compilador e todas as dependências (incluindo a biblioteca `hashicorp/raft`) estão dentro dos contêineres.

---

## Material Teórico

Os slides do professor são a fonte principal e podem ser encontrados no Moodle da disciplina; o [arquivo de contexto teórico](./contexto-teorico.md) é um complemento.

---

## Contexto histórico

Em 1989, Leslie Lamport propôs o **Paxos**, primeiro algoritmo de consenso provadamente correto. Paxos foi adotado em produção em sistemas como o Chubby do Google e o Spanner, mas mesmo Lamport reconhece que é notoriamente difícil de entender, descrever e implementar. Em 2014, Diego Ongaro e John Ousterhout publicaram o **Raft** com objetivo declarado de ser **equivalente em correção e desempenho ao Paxos, mas significativamente mais fácil de entender**.

Raft se tornou rapidamente o algoritmo de consenso padrão da indústria. Ele é o núcleo do **etcd** (coração do Kubernetes), do **Consul**, **Nomad** e **Vault** (HashiCorp), do **TiKV/TiDB**, do **CockroachDB**, das versões modernas do **MongoDB**, e do **Kafka KRaft** (que aposentou o ZooKeeper em 2022).

Esta atividade coloca você frente a frente com um cluster Raft **real**, usando a biblioteca `hashicorp/raft` — a mesma que mantém o Consul rodando em produção em milhares de empresas. A diferença em relação a outras atividades é que aqui você não vai depender só de logs de texto para entender o que acontece: um **visualizador ao vivo** mostra cada papel, cada term, cada entrada de log e cada RPC fluindo entre os nós em tempo real.

---

## Objetivos

Ao final desta atividade, você será capaz de:

1. Identificar os **três papéis** de um nó Raft (Follower, Candidate, Leader) e os gatilhos que causam transições entre eles.
2. Explicar o conceito de **term** como relógio lógico que ordena eleições e justificar por que ele deve ser monotonicamente não-decrescente.
3. Reconhecer a importância do **quórum** (maioria estrita) para eleição de líder e comprometimento de entradas, e justificar por que clusters Raft são tipicamente de tamanho ímpar.
4. Observar empiricamente os efeitos de **falhas e partições de rede** sobre o cluster, e relacionar comportamentos observados às cinco garantias de segurança de Raft (Election Safety, Leader Append-Only, Log Matching, Leader Completeness, State Machine Safety).

---

## Estrutura do projeto

```
atividade-consenso-raft/
├── docker-compose.yml         ← orquestra cluster + dashboard + broker
├── infra/
│   ├── node/                  ← binário Go: nó Raft + KV + event tap (com iptables)
│   ├── dashboard/             ← HTML+JS estático, visualizador ao vivo
│   ├── broker/                ← serviço Python que traduz cliques do dashboard
│   │                            em ações de controle (kill, partition via iptables, heal)
│   └── scripts/
│       ├── kill-leader.sh     ← identifica líder atual e o derruba
│       ├── partition.sh       ← isola subconjunto de nós da rede
│       ├── heal.sh            ← restaura conectividade total
│       └── put.sh             ← helper para enviar comandos KV
└── relatorio-template.md
```

### Topologia da rede

```
              ┌─────────────────────────────────────────┐
              │           rede-raft                     │
              │                                         │
              │   ┌───────┐    ┌───────┐    ┌───────┐   │
              │   │ node1 │◄──►│ node2 │◄──►│ node3 │   │
              │   └───┬───┘    └───┬───┘    └───┬───┘   │
              │       │            │            │       │
              │       └────────────┼────────────┘       │
              │                    │                    │
              │              ┌─────▼──────┐             │
              │              │ dashboard  │             │
              │              │ (web UI)   │             │
              │              └─────┬──────┘             │
              └────────────────────┼────────────────────┘
                                   │
                              localhost:8080
                                   │
                                seu navegador
```

Os três nós formam o cluster Raft, comunicando-se por RPCs `AppendEntries` e `RequestVote` entre si. O dashboard observa todos os três (via Server-Sent Events), agrega seus eventos e desenha o estado do cluster no navegador em tempo real.

Os nós são renderizados em **layout circular** e ligados por **linhas tracejadas cinzas** que representam a topologia ativa da rede: enquanto dois nós podem se comunicar, existe uma linha entre eles; quando uma partição é aplicada, a linha se torna vermelha.

Cada RPC enviado é representado por um **pacote animado** (círculo colorido) que parte do nó remetente e viaja até o destinatário: verde para `AppendEntries`, azul para `RequestVote`.

### Legenda visual do dashboard

| Elemento | Significado |
|---|---|
| Caixa cinza | Nó no papel `Follower` |
| Caixa amarela | Nó no papel `Candidate` (eleição em andamento) |
| Caixa verde | Nó no papel `Leader` |
| Caixa vermelha (`DISCONNECTED`) | Processo do nó **parado** (após `Matar` no card, `Matar líder` no header, ou `docker stop`) |
| Borda tracejada vermelha em um card | Nó marcado como `Isolar` pendente, aguardando `Aplicar partição` |
| Linha tracejada cinza entre dois nós | Conectividade ativa na porta Raft (7000) entre eles |
| Ausência de linha entre dois nós | Partição observada: pacotes Raft entre esses nós não estão chegando (silêncio acima de `2 × HEARTBEAT_MS`) |
| Pacote verde em movimento | RPC `AppendEntries` (heartbeat ou replicação de log) |
| Pacote azul em movimento | RPC `RequestVote` (eleição) |
| Célula verde pulsando no painel `Logs replicados` | Entrada **acabou de ser aplicada** naquele nó (destaque ~1.5 s após o evento `apply`) |
| Badge `QUÓRUM ATINGIDO idx=N` no card do líder | Líder **acabou de contabilizar maioria** de acks no índice N (destaque ~2 s após o avanço de `commit_idx`) |

**Botões no header** (ações globais): `Matar líder`, `Curar tudo`, `Put aleatório`, e `Aplicar partição (N marcados)` aparece quando há nós marcados.

**Botões em cada card** (ações por nó): `Matar`, `Isolar` (vira `Cancelar` se pendente e `Liberar` se aplicado), `Curar este nó` (aparece só quando o nó está parado).

### Como acompanhar a consolidação de uma escrita

Clique em `Put aleatório` no header e observe a sequência:

1. **No card do líder** (verde): `last_log` sobe imediatamente (entrada anexada localmente).
2. **Pacote verde escuro** parte do líder para cada seguidor — replicação (`AppendEntries` com entries > 0).
3. **Pacote verde-amarelado** volta de cada seguidor — ack (`AppendEntriesResp success=true`).
4. **Badge `QUÓRUM ATINGIDO`** aparece momentaneamente no card do líder no instante em que ele recebeu acks da maioria. `commit` no card sobe.
5. **Linha do painel `Logs replicados`** correspondente ao índice começa a pulsar verde, primeiro na coluna do líder.
6. **Próximo `AppendEntries` heartbeat** carrega `leader_commit` atualizado para os seguidores.
7. **Coluna de cada seguidor** no painel pulsa verde quando o respectivo nó aplica a entrada.

A defasagem temporal entre passos 4–5 (líder) e 7 (seguidores) é a **defasagem real do Raft**, não atraso artificial do dashboard. Em `HEARTBEAT_MS=5000`, isso pode ficar entre o instante do ack e o próximo heartbeat (até ~5 s).

**Importante:** *partição* (criada via `Isolar` + `Aplicar partição`, ou via `./infra/scripts/partition.sh`) e *parada do processo* (via `Matar` no card ou `Matar líder` no header) são coisas diferentes. Uma partição mantém o nó vivo — ele continua emitindo estado para o dashboard pela porta 8100 (que não é bloqueada), só não consegue trocar pacotes Raft com os pares isolados. Já um *kill* derruba o processo todo.

---

## Nível 0 — Observar

Execute:

```bash
docker compose up --build
```

Aguarde até ver, nos logs do terminal, que os três nós estão prontos. Em seguida, abra no navegador:

```
http://localhost:8080
```

> O cluster já vem configurado em ritmo de observação humana: `RAFT_HEARTBEAT_MS=5000` no `docker-compose.yml`, o que coloca o intervalo de heartbeat em 5 s e o *election timeout* em 10 s. Em produção, Raft opera em ~150–300 ms — rápido demais para acompanhar visualmente. Se quiser observar com ainda mais calma, edite `RAFT_HEARTBEAT_MS` para `10000` em todos os nós e refaça `docker compose down -v && docker compose up --build`.

Você verá o cluster passar pelos seguintes estados em sequência:

1. Os três nós aparecem cinzas (papel `Follower`), dispostos em círculo e conectados por linhas tracejadas cinzas (topologia inicial: todos se enxergam).
2. Após o primeiro timeout, **um deles fica amarelo** (papel `Candidate`) — incrementou o `term` e iniciou eleição.
3. **Pacotes azuis** partem do candidato em direção aos outros dois (`RequestVote`).
4. Pacotes azuis de resposta retornam (votos concedidos).
5. O candidato fica **verde** (papel `Leader`).
6. A partir daí, **pacotes verdes** pulsam continuamente do líder para os seguidores (heartbeats — `AppendEntries` vazios).

**Observe e responda (anote no relatório):**

1. Qual nó virou candidato primeiro? Você consegue afirmar com certeza por que esse e não outro? (Dica: os *election timeouts* são randomizados; cada nó escolhe um valor diferente entre 150–300 ms em produção; com `RAFT_HEARTBEAT_MS=5000` o intervalo equivalente fica entre 5 e 10 s.)
2. Quantos votos o candidato precisou para virar líder? Por que esse número e não outro?
3. Após a eleição estabilizar, descreva o padrão de pacotes verdes que você observa. Qual a finalidade desses heartbeats?

Encerre com `Ctrl+C`.

---

## Nível 0b — Experimento: derrubar líder ao vivo

Antes de passar ao Nível 1, faça este experimento que torna concreto o mecanismo de recuperação automática de Raft.

**Passo 1:** Inicie o cluster e abra o dashboard:
```bash
docker compose up --build
```
Confirme no dashboard que um líder verde foi eleito. Anote qual nó é o líder e qual o `term` atual.

**Passo 2:** No dashboard, clique em `Matar líder` no header. (Alternativamente, em outro terminal: `./infra/scripts/kill-leader.sh`.)

**Observe:** o nó verde desaparece (vira vermelho — desconectado). Por alguns segundos, os outros dois nós continuam cinzas (followers órfãos — sem heartbeat chegando). Então um deles fica amarelo (candidato), inicia nova eleição com `term` incrementado, e vira verde (novo líder).

**Passo 3:** Reanime o nó derrubado clicando em `Curar este nó` no card do nó morto. (Alternativamente, em outro terminal: `docker compose start node<N>`, substituindo `<N>` pelo nó morto.)

**Observe:** o nó volta cinza (follower). Veja o seu log: ele recebe `AppendEntries` do novo líder com o `term` atual e seu log se atualiza automaticamente.

**Responda:**

4. Quanto tempo (aproximadamente, no `HEARTBEAT_MS` configurado) passou entre a morte do líder e a eleição do novo líder? Esse tempo é o que se chama *recovery time* em sistemas de alta disponibilidade.
5. O `term` subiu ou desceu após a nova eleição? Por quê não pode descer?
6. Quando o nó morto voltou e virou follower, ele "esqueceu" que tinha sido líder anteriormente? Onde no dashboard você consegue ver essa transição registrada?
7. Compare com um servidor único (sem replicação): se ele cai, o que acontece com o serviço? Quanto tempo seu serviço fica indisponível?

---

## Nível 1 — Inspecionar

Agora você vai usar o dashboard como **instrumento de medida** sobre o comportamento do algoritmo. Mantenha o `RAFT_HEARTBEAT_MS` padrão (5000ms) ou aumente para 10000ms se quiser cronometrar com mais calma.

### 1.1 Os três papéis

Preencha a tabela no relatório baseando-se em tudo que você já observou no dashboard:

| Papel | Cor no dashboard | Pode receber `AppendEntries`? | Pode enviar `AppendEntries`? | Como sai desse papel? |
|-------|------------------|-------------------------------|------------------------------|----------------------|
| Follower | | | | |
| Candidate | | | | |
| Leader | | | | |

### 1.2 Term é monotônico

**Experimento:** com o cluster rodando, derrube o líder **três vezes seguidas**. A cada vez, espere a nova eleição estabilizar, anote o `term` atual visível no dashboard, e derrube o líder novo.

| Iteração | Term observado após eleição |
|----------|----------------------------|
| Inicial | |
| Após 1ª morte | |
| Após 2ª morte | |
| Após 3ª morte | |

**Responda:**

1. A sequência de `term`s observada é estritamente crescente, ou houve repetição/decremento?
2. Imagine que `term` pudesse decrementar. Construa um cenário onde isso quebraria a propriedade *Election Safety* (no máximo um líder por term).
3. Qual mecanismo concreto em Raft garante que `term` nunca decremente? (Dica: revisite a regra "ao receber mensagem com `term > currentTerm`...".)

### 1.3 Quórum e comprometimento de entradas

**Experimento:** com o cluster estável (um líder verde), clique em `[Put random KV]` algumas vezes no dashboard. Observe **cuidadosamente** os logs de cada nó:

- Logo após o clique, uma entrada **branca** (não-comprometida) aparece no log do líder.
- Pacotes verdes maiores partem do líder em direção aos seguidores (`AppendEntries` com entrada nova).
- Quando os seguidores respondem, **a entrada vira verde no líder primeiro**, e logo depois nos seguidores.

**Responda:**

1. Quantas confirmações o líder precisou receber antes de marcar a entrada como verde (comprometida)? Comparou com o número total de nós?
2. Em um cluster de 3 nós, quantos nós precisam responder com sucesso ao `AppendEntries` para que a entrada seja comprometida? E se um nó está caído quando a entrada é proposta — ela ainda consegue ser comprometida?
3. A entrada **vira verde nos seguidores depois do líder**. Por que essa defasagem? Qual mensagem o líder envia para informar os seguidores sobre o novo `commitIndex`?

### 1.4 Partição minoritária

**Experimento:** com cluster estável (digamos `node2` é o líder), use o dashboard para criar uma partição que isola apenas `node1`:

1. No card de `node1`, clique em `Isolar`. A borda do card vira tracejada vermelha (estado pendente).
2. No header surge o botão `Aplicar partição (1 marcado)`. Clique nele.

Equivalente via script: `./infra/scripts/partition.sh node1`.

**Observe:** as linhas tracejadas que ligavam `node1` aos demais **desaparecem** — visualmente o cluster fica dividido em dois grupos. `node1` permanece **vivo e visível** no dashboard (não fica vermelho, porque o processo continua rodando — apenas os pacotes Raft na porta 7000 estão bloqueados via `iptables`), mas seu `term` começa a subir sozinho. `node2` e `node3` continuam ligados entre si, com `node2` ainda como líder.

**Passo a:** Tente fazer uma escrita contra `node1`:
```bash
./infra/scripts/put.sh node1 key_isolado valor_x
```

**Passo b:** Tente uma escrita contra `node2` (o líder vivo):
```bash
./infra/scripts/put.sh node2 key_majoritario valor_y
```

**Passo c:** Observe `node1` no dashboard ao longo dos próximos 30 segundos. Veja o `term` dele.

**Responda:**

1. A escrita contra `node1` falhou ou foi redirecionada? O que o script reportou?
2. A escrita contra `node2` foi bem-sucedida? Apareceu no log dele como entrada verde?
3. O `node1` isolado tentou virar candidato? O que aconteceu com o `term` dele durante o isolamento?
4. Por que `node1` sozinho não consegue eleger líder próprio? Qual regra de Raft impede isso?

Restaure a rede clicando em `Curar tudo` no header do dashboard (ou rode `./infra/scripts/heal.sh` em outro terminal).

### 1.5 Partição majoritária e reconciliação de log

Este é o experimento mais importante do Nível 1. Ele demonstra a propriedade **Leader Completeness** diretamente.

**Setup:** com o cluster estável, identifique o líder atual no dashboard. Suponha que seja `node1` no `term=3`.

**Passo 1 — Isolar o líder no lado minoritário:** no card de `node1`, clique em `Isolar` e depois em `Aplicar partição` no header. `node1` (o líder antigo) fica isolado. `node2` e `node3` ainda estão conectados entre si — eles são a maioria.

**Passo 2 — Escrever no líder isolado:** tente algumas escritas contra `node1`:
```bash
./infra/scripts/put.sh node1 chave_zumbi_a valor_a
./infra/scripts/put.sh node1 chave_zumbi_b valor_b
```

**Passo 3 — Observar o lado majoritário:** olhe `node2` e `node3` no dashboard. Após alguns segundos, um deles deve ter incrementado `term` e virado novo líder.

**Passo 4 — Escrever no novo líder:**
```bash
./infra/scripts/put.sh node2 chave_real valor_real
```
(use o nó que virou novo líder; se for `node3`, ajuste o comando)

Esta entrada deve virar verde no log do novo líder e do follower companheiro.

**Passo 5 — Curar a partição:** clique em `Curar tudo` no header do dashboard.

**Observe cuidadosamente o log de `node1`:**

- Ele recebe `AppendEntries` do novo líder com `term` maior que o seu.
- Ele atualiza `currentTerm`, volta a ser follower.
- O log dele converge para o do líder atual.

**Responda:**

1. As entradas que `node1` escreveu enquanto isolado (`chave_zumbi_a`, `chave_zumbi_b`) sobreviveram após a reconciliação? Onde elas foram parar?
2. Por que `node1` aceitou ter seu log reescrito ao receber `AppendEntries` do novo líder? Qual campo da mensagem o convenceu?
3. Esse comportamento corresponde a qual das cinco garantias de segurança de Raft (§5.2 do paper)? Descreva-a com suas palavras.
4. Imagine que essas entradas tivessem sido comprometidas antes da partição (ou seja, alcançado maioria). Elas poderiam ser descartadas após a reconciliação? Por quê não?

---

## Nível 2 — Modificar

### Modificação A — Escalar para cluster de 5 nós (guiada)

Atualmente o cluster tem 3 nós e tolera 1 falha. Vamos escalar para 5 e observar como isso afeta a tolerância a falhas.

**Passo 1:** Abra `docker-compose.yml` e adicione dois novos serviços (`node4` e `node5`) copiando o padrão dos existentes. Ajuste:
- Nomes de hostname e container.
- Variável `RAFT_PEERS` em **todos** os nós para listar os 5 endereços.
- Variável `RAFT_NODES` nos serviços `dashboard` e `broker` para `"node1,node2,node3,node4,node5"`.
- Variável `RAFT_HEARTBEAT_MS` em cada nó novo (mantenha o mesmo valor dos existentes).
- Volume de dados separado por nó (adicione `node4-data` e `node5-data` ao bloco `volumes:`).

A receita completa está em `infra/dashboard/docs/EXTENSAO.md`, seção "Adicionar um nó".

**Passo 2:** Recompile e suba o cluster:
```bash
docker compose down -v
docker compose up --build
```

**Passo 3:** No dashboard, observe agora **5 caixas de nó**. O cabeçalho deve mostrar `quorum: 3/5`.

**Passo 4 — Tolerância a 2 falhas:** derrube dois nós (incluindo o líder, se possível):
```bash
docker compose stop node1 node2
```
Observe: o cluster sobrevive. Um dos três nós restantes vira líder (se um deles era a maioria sem o `node1`/`node2`). Escritas continuam funcionando.

**Passo 5 — Tolerância esgotada:** derrube um terceiro nó:
```bash
docker compose stop node3
```
Observe: o cluster trava. Os dois nós restantes (`node4`, `node5`) tentam eleição mas nenhum consegue maioria (precisariam de 3 votos, só existem 2). Você verá no dashboard candidatos amarelos com `term` subindo perpetuamente, sem nenhum virar verde.

**Responda:**

1. Com 5 nós, quantas falhas simultâneas o cluster tolera? Compare com cluster de 3.
2. Se você escalasse para 6 nós (par), quantas falhas tolera? Por que tamanhos pares são desencorajados?
3. Qual o trade-off de aumentar o tamanho do cluster? (Dica: pense em latência de comprometimento e overhead de mensagens.)
4. Em que cenário real (em termos de operação de produção) você escolheria 5 nós em vez de 3?

---

## Entregável

1. Faça um *fork* (ou clone) deste repositório.
2. Complete os Níveis 1 e 2, incluindo as modificações nos arquivos indicados.
3. **Capture screenshots do dashboard** em momentos-chave: eleição inicial, partição majoritária com líder isolado, log do nó isolado após reconciliação, cluster de 5 nós com quorum esgotado. Cole no relatório.
4. Preencha o `relatorio-template.md` com suas respostas e screenshots.
5. Envie o link do repositório com seus commits (ou o arquivo `.zip` do projeto com o relatório preenchido), conforme orientação do professor.

---

## Dúvidas

Abra uma *issue* neste repositório ou traga sua pergunta para a próxima aula.
