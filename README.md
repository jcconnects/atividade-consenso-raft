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
├── docker-compose.yml         ← orquestra cluster + dashboard
├── infra/
│   ├── node/                  ← binário Go: nó Raft + KV + event tap
│   ├── dashboard/             ← HTML+JS estático, visualizador ao vivo
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

Os três nós formam o cluster Raft, comunicando-se por RPCs `AppendEntries` e `RequestVote` entre si. O dashboard observa todos os três (via WebSocket), agrega seus eventos e desenha o estado do cluster no navegador em tempo real.

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

> **Importante:** No primeiro Nível, mantenha o toggle **`Slow motion`** ativado (canto superior direito do dashboard). Em produção, eleições Raft acontecem em ~150–300 ms — rápido demais para o olho humano. O modo lento bumpa o *election timeout* para ~5 s, tornando cada transição visível.

Você verá o cluster passar pelos seguintes estados em sequência:

1. Os três nós aparecem cinzas (papel `Follower`).
2. Após o primeiro timeout, **um deles fica amarelo** (papel `Candidate`) — incrementou o `term` e iniciou eleição.
3. Setas tracejadas azuis disparam do candidato em direção aos outros dois (`RequestVote`).
4. Setas azuis com `✓` retornam (votos concedidos).
5. O candidato fica **verde** (papel `Leader`).
6. A partir daí, setas verdes pequenas pulsam continuamente do líder para os seguidores (heartbeats — `AppendEntries` vazios).

**Observe e responda (anote no relatório):**

1. Qual nó virou candidato primeiro? Você consegue afirmar com certeza por que esse e não outro? (Dica: os *election timeouts* são randomizados; cada nó escolhe um valor diferente entre 150–300 ms — em modo lento, entre 3–6 s.)
2. Quantos votos o candidato precisou para virar líder? Por que esse número e não outro?
3. Após a eleição estabilizar, descreva o padrão de setas verdes que você observa. Qual a finalidade desses heartbeats?

Encerre com `Ctrl+C`.

---

## Nível 0b — Experimento: derrubar líder ao vivo

Antes de passar ao Nível 1, faça este experimento que torna concreto o mecanismo de recuperação automática de Raft.

**Passo 1:** Inicie o cluster e abra o dashboard:
```bash
docker compose up --build
```
Confirme no dashboard que um líder verde foi eleito. Anote qual nó é o líder e qual o `term` atual.

**Passo 2:** No dashboard, clique em `[Kill leader]`. (Alternativamente, em outro terminal: `./infra/scripts/kill-leader.sh`.)

**Observe:** o nó verde desaparece (vira vermelho — desconectado). Por alguns segundos, os outros dois nós continuam cinzas (followers órfãos — sem heartbeat chegando). Então um deles fica amarelo (candidato), inicia nova eleição com `term` incrementado, e vira verde (novo líder).

**Passo 3:** Reanime o nó derrubado:
```bash
docker compose start node<N>     # substitua <N> pelo nó morto, ex: node1
```

**Observe:** o nó volta cinza (follower). Veja o seu log: ele recebe `AppendEntries` do novo líder com o `term` atual e seu log se atualiza automaticamente.

**Responda:**

4. Quanto tempo (aproximadamente, em modo lento) passou entre a morte do líder e a eleição do novo líder? Esse tempo é o que se chama *recovery time* em sistemas de alta disponibilidade.
5. O `term` subiu ou desceu após a nova eleição? Por quê não pode descer?
6. Quando o nó morto voltou e virou follower, ele "esqueceu" que tinha sido líder anteriormente? Onde no dashboard você consegue ver essa transição registrada?
7. Compare com um servidor único (sem replicação): se ele cai, o que acontece com o serviço? Quanto tempo seu serviço fica indisponível?

---

## Nível 1 — Inspecionar

Agora você vai usar o dashboard como **instrumento de medida** sobre o comportamento do algoritmo. Em todos os experimentos deste nível, mantenha o modo **`Slow motion` ativado** para conseguir observar as transições.

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

**Experimento:** com o cluster estável (um líder verde), clique em `[Put random KV]` algumas vezes no dashboard. Observe **cuidadosamente** os tijolos de log de cada nó:

- Logo após o clique, uma entrada **branca** (não-comprometida) aparece no log do líder.
- Setas verdes maiores disparam do líder para os seguidores (`AppendEntries` com entrada nova).
- Quando os seguidores respondem, **a entrada vira verde no líder primeiro**, e logo depois nos seguidores.

**Responda:**

1. Quantas confirmações o líder precisou receber antes de marcar a entrada como verde (comprometida)? Comparou com o número total de nós?
2. Em um cluster de 3 nós, quantos nós precisam responder com sucesso ao `AppendEntries` para que a entrada seja comprometida? E se um nó está caído quando a entrada é proposta — ela ainda consegue ser comprometida?
3. A entrada **vira verde nos seguidores depois do líder**. Por que essa defasagem? Qual mensagem o líder envia para informar os seguidores sobre o novo `commitIndex`?

### 1.4 Partição minoritária

**Experimento:** com cluster estável (digamos `node2` é o líder), use o dashboard para criar uma partição que isola apenas `node1`:
```
[Partition (1) | (2,3)]
```

Equivalente via script: `./infra/scripts/partition.sh node1`.

**Observe:** o `node1` fica vermelho (desconectado). `node2` e `node3` permanecem juntos, com `node2` ainda como líder.

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

Restaure a rede:
```
[Heal all]    (ou ./infra/scripts/heal.sh)
```

### 1.5 Partição majoritária e reconciliação de log

Este é o experimento mais importante do Nível 1. Ele demonstra a propriedade **Leader Completeness** diretamente.

**Setup:** com o cluster estável, identifique o líder atual no dashboard. Suponha que seja `node1` no `term=3`.

**Passo 1 — Isolar o líder no lado minoritário:**
```
[Partition (1) | (2,3)]
```
`node1` (o líder antigo) fica isolado. `node2` e `node3` ainda estão conectados entre si — eles são a maioria.

**Passo 2 — Escrever no líder isolado:** tente algumas escritas contra `node1`:
```bash
./infra/scripts/put.sh node1 chave_zumbi_a valor_a
./infra/scripts/put.sh node1 chave_zumbi_b valor_b
```

**Observe:** essas entradas aparecem **brancas** no log de `node1` (ele as registrou localmente), mas **nunca viram verdes** — ele não consegue alcançar maioria, porque está sozinho.

**Passo 3 — Observar o lado majoritário:** olhe `node2` e `node3` no dashboard. Após alguns segundos, um deles deve ter incrementado `term` e virado novo líder.

**Passo 4 — Escrever no novo líder:**
```bash
./infra/scripts/put.sh node2 chave_real valor_real
```
(use o nó que virou novo líder; se for `node3`, ajuste o comando)

Esta entrada deve virar verde no log do novo líder e do follower companheiro.

**Passo 5 — Curar a partição:**
```
[Heal all]
```

**Observe cuidadosamente o log de `node1`:**

- Ele recebe `AppendEntries` do novo líder com `term` maior que o seu.
- Ele atualiza `currentTerm`, volta a ser follower.
- **As entradas brancas que ele escreveu enquanto isolado desaparecem do log dele.**
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
- Volume de dados separado por nó.

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

Restaure o cluster original de 3 nós antes de seguir para a Modificação B.

### Modificação B — Adicionar operação CAS (compare-and-swap) (aberta)

A FSM atual suporta `PUT` (escreve incondicional) e `GET` (lê). Operações concorrentes via PUT podem causar perda de atualização: cliente A lê `x=1`, cliente B lê `x=1`, ambos escrevem `x=2` e `x=3` respectivamente — uma das escritas é silenciosamente perdida.

Sua tarefa: adicionar operação **`CAS(key, expected, new)`** — "atualize `key` para `new` se e somente se o valor atual for `expected`; caso contrário, falhe". CAS é a primitiva clássica usada para implementar contadores, locks otimistas e estruturas concorrentes em sistemas distribuídos.

**Passos sugeridos:**

1. Em `infra/node/fsm.go`, identifique o `switch` em `Apply()`. Adicione um novo `case` para o tipo de comando `CAS`.
2. Em `infra/node/http.go`, adicione uma rota `POST /cas` que recebe `{key, expected, new}` e submete o comando ao Raft.
3. Reconstrua: `docker compose up --build`.
4. Teste:
   ```bash
   curl -X POST localhost:9001/put -d '{"key":"contador","value":"0"}'
   curl -X POST localhost:9001/cas -d '{"key":"contador","expected":"0","new":"1"}'   # sucesso
   curl -X POST localhost:9001/cas -d '{"key":"contador","expected":"0","new":"2"}'   # falha (já é "1")
   ```

**Responda no relatório:**

1. Por que o CAS **precisa obrigatoriamente** passar pelo log Raft, mesmo que pareça uma simples leitura-seguida-de-escrita? O que aconteceria se cada nó decidisse o resultado do CAS localmente, sem replicar?
2. Linearizabilidade é a propriedade que garante que operações concorrentes parecem ocorrer em alguma ordem sequencial consistente. Como Raft + CAS produzem operações linearizáveis mesmo com replicação assíncrona entre nós?
3. Cole no relatório o trecho do `Apply()` que você modificou e o trecho da rota HTTP que você adicionou.

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
