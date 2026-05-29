# Contexto Teórico — Consenso com Raft

> **Fonte primária:** Os slides do professor são o ponto de entrada recomendado para este conteúdo. Este documento é um complemento de referência, não um substituto.
>
> **Nota sobre fontes:** A literatura primária sobre Raft é majoritariamente em inglês. Este documento oferece a base conceitual em português para que a atividade prática faça sentido; a leitura do artigo original (Ongaro & Ousterhout, 2014) é fortemente recomendada para aprofundamento.

---

## 1. O problema do consenso

Em um sistema distribuído com múltiplas réplicas, todas as réplicas precisam concordar sobre a sequência de operações executadas — caso contrário, cada réplica acabaria com um estado diferente, e o sistema deixaria de se comportar como uma máquina única. Esse problema é chamado de **consenso distribuído**.

O desafio não está em sistemas saudáveis: se todas as réplicas estão ativas, a rede é confiável e as mensagens chegam em ordem, qualquer mecanismo simples funcionaria. O desafio surge quando réplicas falham, mensagens se perdem, a rede particiona, ou pacotes chegam fora de ordem. Um algoritmo de consenso correto precisa preservar a consistência do sistema **mesmo nessas condições adversas**.

Em 1985, Fischer, Lynch e Paterson provaram o resultado conhecido como **impossibilidade FLP**: em um sistema assíncrono onde até um único processo pode falhar por parada, não existe algoritmo de consenso determinístico que termine em todos os cenários. Algoritmos práticos como Raft contornam essa impossibilidade ao assumir um modelo de **assincronia parcial** (períodos eventuais de estabilidade) e ao priorizar segurança (*safety* — nunca chegar a um estado incorreto) sobre vivacidade (*liveness* — sempre eventualmente progredir).

---

## 2. Origem histórica: de Paxos a Raft

O algoritmo de consenso de referência por décadas foi o **Paxos**, proposto por Leslie Lamport em 1989 (e publicado formalmente em 1998). Paxos é matematicamente correto e foi base de sistemas reais — o Chubby do Google, o Megastore, o Spanner, entre outros. Porém, mesmo Lamport reconhece que Paxos é notoriamente difícil de entender, descrever, implementar e ensinar. Implementações reais frequentemente acabam sendo variantes de Multi-Paxos que diferem do algoritmo formal em pontos não documentados.

Em 2014, **Diego Ongaro e John Ousterhout** publicaram no USENIX ATC o artigo *"In Search of an Understandable Consensus Algorithm"*, apresentando o **Raft**. O objetivo declarado dos autores era explícito: criar um algoritmo de consenso equivalente em correção e desempenho ao Multi-Paxos, mas significativamente mais fácil de entender. Para isso, Raft adota três princípios:

1. **Decomposição do problema** — separar consenso em três subproblemas independentes (eleição de líder, replicação de log, segurança).
2. **Redução do espaço de estados** — limitar o número de estados em que cada nó pode estar e reduzir a não-determinismo.
3. **Líder forte** — toda a coordenação flui através de um único líder eleito, simplificando o raciocínio.

Raft tornou-se rapidamente o algoritmo de consenso de fato em sistemas modernos. A lista de produtos que rodam Raft em produção é extensa: **etcd** (o coração do Kubernetes), **HashiCorp Consul / Nomad / Vault**, **TiKV / TiDB**, **CockroachDB**, **MongoDB** (variante de Raft desde a versão 3.2), e **Apache Kafka** (no modo KRaft, que substituiu o ZooKeeper em 2022). Praticamente toda infraestrutura distribuída moderna que você vai encontrar na prática usa Raft em algum lugar do seu núcleo.

---

## 3. Os três papéis de um nó

Em um cluster Raft, cada nó está, a todo momento, em exatamente um dos três papéis:

| Papel | O que faz | Transições |
|-------|-----------|------------|
| **Follower** (seguidor) | Recebe mensagens do líder. Responde a `RequestVote` e `AppendEntries`. Não inicia ações por conta própria. | Se não receber mensagem do líder dentro do *election timeout*, vira `Candidate`. |
| **Candidate** (candidato) | Inicia uma eleição: incrementa o `term`, vota em si mesmo, envia `RequestVote` aos outros nós. | Se receber maioria dos votos → `Leader`. Se descobrir líder válido → `Follower`. Se eleição empata → nova eleição. |
| **Leader** (líder) | Único nó autorizado a propor novas entradas no log. Envia `AppendEntries` (com entradas novas ou apenas heartbeats) a todos os seguidores. | Se descobrir outro nó com `term` maior → `Follower`. |

Esta atividade torna os papéis **visualmente observáveis**: o dashboard colore cada nó por papel (cinza = follower, amarelo = candidate, verde = leader). Você verá nós trocando de cor em tempo real durante eleições.

---

## 4. Term: o relógio lógico de Raft

Raft divide o tempo em **terms** (mandatos) numerados sequencialmente: `term 1`, `term 2`, `term 3`, etc. Cada term começa com uma eleição. Se a eleição produz um líder, esse líder governa pelo resto do term. Se a eleição falha (empate, partição), o term termina sem líder e um novo term começa.

Cada nó armazena o `currentTerm` que ele acredita ser o term atual. Algumas regras governam a propagação do term:

1. **Term é monotônico não-decrescente**: o `currentTerm` de um nó nunca diminui. Quando recebe uma mensagem com `term > currentTerm`, o nó atualiza `currentTerm` para o valor maior e vira `Follower`.
2. **Term identifica épocas**: dois nós podem estar em terms diferentes temporariamente, mas a regra acima garante convergência rápida.
3. **Term resolve conflitos**: se duas mensagens chegam a um nó com terms diferentes, a do term maior vence. Isso é o mecanismo central que impede *split-brain* e líderes obsoletos de causarem dano.

Você pode pensar no term como uma versão simplificada de um relógio lógico de Lamport, dedicada apenas a ordenar eleições.

---

## 5. As duas fases de Raft

Raft opera continuamente alternando entre duas fases:

### Fase 1 — Eleição de líder

1. Um follower não recebe `AppendEntries` dentro do *election timeout* (tipicamente 150–300 ms, escolhido aleatoriamente para reduzir colisões).
2. Ele incrementa `currentTerm`, vira `Candidate`, vota em si mesmo, e envia `RequestVote` aos outros nós.
3. Cada nó vota **no máximo uma vez por term**, no primeiro candidato cujo log seja pelo menos tão atual quanto o seu.
4. Se o candidato recebe `voto de maioria` (≥ ⌈(N+1)/2⌉ votos), ele vira `Leader` e começa a enviar heartbeats imediatamente.
5. Se outro nó vira líder primeiro (heartbeat com `term ≥ currentTerm`), o candidato volta a ser `Follower`.
6. Se houver empate (raro mas possível), o term termina sem líder e uma nova eleição começa após novo timeout aleatório.

### Fase 2 — Replicação de log

1. Cliente envia comando ao líder (ou é redirecionado a ele).
2. Líder anexa o comando como nova entrada no seu log local, marcando-a como **não comprometida**.
3. Líder envia `AppendEntries` contendo a nova entrada a todos os seguidores.
4. Cada seguidor que recebe a entrada (e cujo log é consistente com a posição anterior) anexa a entrada ao seu próprio log e responde com sucesso.
5. Quando o líder recebe confirmação de **maioria** dos nós (incluindo ele mesmo), a entrada é declarada **comprometida** (*committed*).
6. Líder informa o novo `commitIndex` aos seguidores no próximo `AppendEntries`. Cada nó aplica entradas comprometidas à sua máquina de estado local em ordem.

Este é o ponto-chave: **uma entrada só é considerada efetiva quando alcança maioria**. Se o líder cai antes de comprometer, o novo líder pode descartar a entrada — mas se ela foi comprometida (maioria alcançada), ela está garantida para sempre.

---

## 6. As cinco garantias de segurança

O artigo de Ongaro & Ousterhout (§5.2) define cinco propriedades que Raft preserva em todas as execuções, mesmo na presença de falhas:

1. **Election Safety** (segurança de eleição) — em qualquer term, no máximo um líder é eleito.
2. **Leader Append-Only** (líder só anexa) — um líder nunca sobrescreve nem deleta entradas do seu próprio log; só anexa novas entradas.
3. **Log Matching** (casamento de log) — se dois logs contêm uma entrada com mesmo `index` e mesmo `term`, então todas as entradas anteriores são idênticas nos dois logs.
4. **Leader Completeness** (completude do líder) — se uma entrada foi comprometida em algum term, ela estará presente nos logs de todos os líderes de terms posteriores.
5. **State Machine Safety** (segurança da máquina de estado) — se um nó aplicou uma entrada em determinado `index` à sua máquina de estado, nenhum outro nó aplicará entrada diferente naquele `index`.

A propriedade combinada garante que **todas as réplicas convergem para a mesma sequência de estados**, mesmo que falhas, partições e reordenações ocorram. Você vai testar a Leader Completeness diretamente na Atividade Nível 1.5, isolando um líder, escrevendo entradas no minoritário, e observando essas entradas serem descartadas quando a partição cura.

---

## 7. Quorum: por que clusters Raft tendem a ser ímpares

Raft requer **maioria estrita** (mais da metade dos nós) para qualquer ação significativa: eleger líder, comprometer entrada. A maioria em um cluster de `N` nós é `⌈(N+1)/2⌉`.

| N (nodes) | Maioria | Falhas toleradas |
|-----------|---------|------------------|
| 3 | 2 | 1 |
| 4 | 3 | 1 |
| 5 | 3 | 2 |
| 6 | 4 | 2 |
| 7 | 4 | 3 |

Note: clusters de tamanho par não aumentam a tolerância a falhas em relação ao tamanho ímpar imediatamente menor (4 tolera o mesmo que 3; 6 tolera o mesmo que 5), mas adicionam custo de mensagens. Por isso, **clusters Raft em produção são quase sempre ímpares**: 3, 5, ou 7 nós.

Esta atividade começa com cluster de 3 nós (tolera 1 falha) e, na Modificação A do Nível 2, escala para 5 nós (tolera 2 falhas).

---

## 8. Partições de rede e split-brain

A propriedade mais difícil de internalizar sobre Raft é o que acontece sob **partições de rede** — quando o cluster se divide em dois ou mais grupos isolados.

- **Lado majoritário** (≥ maioria de nós): consegue eleger líder, comprometer entradas, continuar operando.
- **Lado minoritário** (< maioria): não consegue eleger líder. Candidatos isolados tentam eleição repetidamente, incrementando `term`, mas nunca recebem votos suficientes. Líder isolado eventualmente percebe (via tentativa falha de comprometer) que perdeu o quórum e volta a ser follower (em algumas implementações; em outras, só descobre quando reconecta).
- **Quando a partição cura**: o lado que tinha `term` menor recebe `AppendEntries` com `term` maior, atualiza `currentTerm`, volta a ser follower, e **descarta qualquer entrada não-comprometida que tenha gravado durante o isolamento**.

Esse mecanismo é o que impede *split-brain*: duas metades não podem ambas operar com líderes diferentes, porque maioria estrita só existe em uma metade por vez (assumindo número total ímpar de nós e partição em duas metades).

A atividade Nível 1.4 e 1.5 reproduzem exatamente esses dois cenários — partição minoritária (Nível 1.4) e partição majoritária com líder no lado minoritário (Nível 1.5) — para que você observe o comportamento concretamente no dashboard.

---

## 9. Por que `hashicorp/raft`, Docker e visualizador ao vivo

### A escolha da biblioteca

A biblioteca [`hashicorp/raft`](https://github.com/hashicorp/raft) é a implementação de Raft em Go usada em produção pela HashiCorp em **Consul, Nomad, e Vault**. É o mesmo código que mantém clusters de serviço, agendamento e segredos em milhares de empresas. Usar essa biblioteca nesta atividade significa que o que você vê e manipula é o exato algoritmo rodando em sistemas reais — não uma versão didática simplificada que esconde detalhes de produção.

Outras opções consideradas: implementar Raft do zero (excelente para profundidade conceitual, mas remove o aspecto de transferência industrial), `etcd-io/raft` (também sólida, ligeiramente menos amigável a usos pedagógicos pequenos).

### Por que Docker

Um cluster Raft funcional requer **múltiplos processos isolados em rede**, com a capacidade de **simular falhas e partições**. Docker Compose permite:

- Iniciar 3 (ou 5) nós idênticos com uma única configuração declarativa.
- Isolar nós da rede (bloqueando a porta Raft via `iptables` dentro do contêiner) para experimentar partições sem afetar o sistema hospedeiro.
- Reiniciar nós individualmente para observar recuperação após falha.

Tentar reproduzir esses experimentos sem isolamento de contêineres exigiria configuração manual extensiva de portas, processos e regras de rede — invertendo a proporção entre infraestrutura e aprendizagem.

### Por que um visualizador

Os outros mecanismos de coordenação que você viu em atividades anteriores — sockets, espaços de tuplas, NTP — produzem efeitos diretamente observáveis: mensagem chega no terminal, tupla aparece no espaço, relógio se ajusta. Raft é diferente. Sua complexidade está nas **transições internas de estado**: papéis trocando, `term` incrementando, entradas migrando de não-comprometidas para comprometidas, RPCs `RequestVote` e `AppendEntries` fluindo entre nós dezenas de vezes por segundo.

Logs de texto capturam esses eventos, mas exigem que você reconstrua mentalmente o estado do cluster a cada instante — o que é exatamente o tipo de carga cognitiva que esconde o aprendizado conceitual sob detalhes de implementação. O dashboard ao vivo desta atividade torna **cada conceito do algoritmo diretamente visível**: você vê o nó amarelo (candidato) virando verde (líder), as setas verdes (heartbeats) pulsando, os tijolos de log brancos (não-comprometidos) virando verdes (comprometidos) quando a maioria confirma.

A inspiração direta é o [raftscope](https://github.com/ongardie/raftscope) do próprio Diego Ongaro, usado nas apresentações originais de Raft. A diferença é que aqui o visualizador é alimentado por um cluster **real** rodando `hashicorp/raft`, não por uma simulação — você manipula o sistema verdadeiro e o vê reagir.

---

## 10. Conexão com sistemas modernos

O Raft que você vai operar nesta atividade aparece, com nomenclatura levemente diferente, em praticamente toda infraestrutura distribuída moderna:

| Conceito em Raft | Equivalente em sistemas modernos |
|------------------|----------------------------------|
| Cluster de nós Raft | etcd cluster, Consul server cluster, MongoDB replica set, Kafka KRaft controller quorum |
| Leader | etcd leader, Consul leader, MongoDB primary, Kafka active controller |
| Follower | etcd follower, MongoDB secondary, Kafka standby controller |
| Log de comandos | etcd WAL (write-ahead log), MongoDB oplog, Kafka metadata log |
| Term | etcd term, MongoDB election ID |
| `AppendEntries` | etcd replication RPC, MongoDB oplog tailing |
| `RequestVote` | etcd vote request, MongoDB election protocol |
| `commitIndex` | etcd applied index, MongoDB majority commit point |
| Quorum (maioria) | etcd majority, MongoDB write concern `majority` |

Ao reconhecer Raft no fundo dessas tecnologias, você adquire vocabulário e modelo mental para depurar, operar e arquitetar sistemas que dependem de consenso — desde Kubernetes (cujo control plane inteiro depende de etcd/Raft) até bancos de dados distribuídos modernos.

---

## 11. Referências

**Fonte primária recomendada:** slides do professor.

ONGARO, D.; OUSTERHOUT, J. In Search of an Understandable Consensus Algorithm. In: **2014 USENIX Annual Technical Conference**, Philadelphia, PA, p. 305–319, jun. 2014.
> Artigo original que define Raft. Leitura obrigatória — escrito explicitamente para ser acessível. Disponível em https://raft.github.io/raft.pdf.

ONGARO, D. **Consensus: Bridging Theory and Practice**. Tese de doutorado, Stanford University, 2014.
> Versão estendida do artigo, com detalhes de implementação, snapshots, membership changes, e prova de correção. Disponível em https://web.stanford.edu/~ouster/cgi-bin/papers/OngaroPhD.pdf.

LAMPORT, L. The Part-Time Parliament. **ACM Transactions on Computer Systems**, v. 16, n. 2, p. 133–169, maio 1998.
> Artigo formal do Paxos. Útil como contraste para entender o que Raft simplificou.

FISCHER, M. J.; LYNCH, N. A.; PATERSON, M. S. Impossibility of Distributed Consensus with One Faulty Process. **Journal of the ACM**, v. 32, n. 2, p. 374–382, abr. 1985.
> Resultado FLP, fundamento teórico da impossibilidade de consenso determinístico em sistemas assíncronos.

The Raft Consensus Algorithm. **Site oficial**. Disponível em: https://raft.github.io. Acesso em: 2026.
> Página de referência mantida por Ongaro. Inclui o visualizador raftscope original que inspira o dashboard desta atividade, lista de implementações em diversas linguagens, e referências adicionais.

HashiCorp. **`hashicorp/raft` — Golang implementation of the Raft consensus protocol**. Disponível em: https://github.com/hashicorp/raft. Acesso em: 2026.
> Biblioteca utilizada nesta atividade. Documentação inclui exemplos de uso e detalhes da Observer API explorada pelo nosso event tap.
