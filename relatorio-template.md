# Relatório — Atividade Prática: Consenso com Raft e Visualizador ao Vivo

**Disciplina:**
**Dupla:** /
**Data:**

---

## Nível 0 — Observar

### Eleição inicial

1. Qual nó virou candidato primeiro? Você consegue afirmar com certeza por que esse e não outro?

> _Resposta:_

2. Quantos votos o candidato precisou para virar líder? Por que esse número e não outro?

> _Resposta:_

3. Após a eleição estabilizar, descreva o padrão de pacotes verdes que você observa. Qual a finalidade desses heartbeats?

> _Resposta:_

**Screenshot — momento logo após eleição inicial estabilizar:**

> _(cole aqui)_

---

## Nível 0b — Derrubar líder ao vivo

4. Quanto tempo (aproximadamente, no `HEARTBEAT_MS` configurado) passou entre a morte do líder e a eleição do novo líder?

> _Resposta:_

5. O `term` subiu ou desceu após a nova eleição? Por quê não pode descer?

> _Resposta:_

6. Quando o nó morto voltou e virou follower, ele "esqueceu" que tinha sido líder anteriormente? Onde no dashboard você consegue ver essa transição registrada?

> _Resposta:_

7. Compare com um servidor único (sem replicação): se ele cai, o que acontece com o serviço? Quanto tempo seu serviço fica indisponível?

> _Resposta:_

---

## Nível 1 — Inspecionar

### 1.1 Os três papéis

| Papel | Cor no dashboard | Pode receber `AppendEntries`? | Pode enviar `AppendEntries`? | Como sai desse papel? |
|-------|------------------|-------------------------------|------------------------------|----------------------|
| Follower | | | | |
| Candidate | | | | |
| Leader | | | | |

---

### 1.2 Term é monotônico

Sequência de `term`s observada após derrubadas sucessivas do líder:

| Iteração | Term observado após eleição |
|----------|----------------------------|
| Inicial | |
| Após 1ª morte | |
| Após 2ª morte | |
| Após 3ª morte | |

1. A sequência é estritamente crescente, ou houve repetição/decremento?

> _Resposta:_

2. Imagine que `term` pudesse decrementar. Construa um cenário onde isso quebraria a propriedade *Election Safety*.

> _Resposta:_

3. Qual mecanismo concreto em Raft garante que `term` nunca decremente?

> _Resposta:_

---

### 1.3 Quórum e comprometimento de entradas

1. Quantas confirmações o líder precisou receber antes de marcar a entrada como verde (comprometida)?

> _Resposta:_

2. Em um cluster de 3 nós, quantos nós precisam responder com sucesso ao `AppendEntries` para que a entrada seja comprometida? Se um nó está caído, ainda dá pra comprometer?

> _Resposta:_

3. A entrada vira verde nos seguidores **depois** do líder. Por que essa defasagem? Qual mensagem informa os seguidores sobre o novo `commitIndex`?

> _Resposta:_

**Screenshot — entrada não-comprometida no líder antes de virar verde:**

> _(cole aqui)_

---

### 1.4 Partição minoritária

1. A escrita contra `node1` (isolado) falhou ou foi redirecionada? O que o script reportou?

> _Resposta:_

```
(cole a saída do script ./infra/scripts/put.sh aqui)
```

2. A escrita contra `node2` (líder, lado majoritário) foi bem-sucedida? Apareceu no log dele como entrada verde?

> _Resposta:_

3. O `node1` isolado tentou virar candidato? O que aconteceu com o `term` dele durante o isolamento?

> _Resposta:_

4. Por que `node1` sozinho não consegue eleger líder próprio? Qual regra de Raft impede isso?

> _Resposta:_

---

### 1.5 Partição majoritária e reconciliação de log

**Screenshot — antes da cura: log de `node1` com entradas brancas e log do novo líder em outro term:**

> _(cole aqui)_

**Screenshot — depois da cura: log de `node1` convergido para o do líder atual:**

> _(cole aqui)_

1. As entradas que `node1` escreveu enquanto isolado (`chave_zumbi_a`, `chave_zumbi_b`) sobreviveram após reconciliação? Onde foram parar?

> _Resposta:_

2. Por que `node1` aceitou ter seu log reescrito ao receber `AppendEntries` do novo líder? Qual campo da mensagem o convenceu?

> _Resposta:_

3. Esse comportamento corresponde a qual das cinco garantias de segurança de Raft? Descreva-a com suas palavras.

> _Resposta:_

4. Imagine que essas entradas tivessem sido **comprometidas antes da partição**. Elas poderiam ser descartadas após reconciliação? Por quê não?

> _Resposta:_

---

## Nível 2 — Modificar

### Modificação A — Cluster de 5 nós

**Screenshot — cabeçalho do dashboard com `quorum: 3/5`:**

> _(cole aqui)_

**Screenshot — cluster paralisado após 3 falhas (candidatos amarelos com term subindo, sem virar verde):**

> _(cole aqui)_

1. Com 5 nós, quantas falhas simultâneas o cluster tolera? Compare com cluster de 3.

> _Resposta:_

2. Se escalasse para 6 nós (par), quantas falhas tolera? Por que tamanhos pares são desencorajados?

> _Resposta:_

3. Qual o trade-off de aumentar o tamanho do cluster?

> _Resposta:_

4. Em que cenário real (operação de produção) você escolheria 5 nós em vez de 3?

> _Resposta:_

---

## Observações livres

_(Comportamentos inesperados, erros encontrados, dificuldades técnicas — descreva o que aconteceu e como você resolveu)_

>

---

## Dúvida para a próxima aula

_(Formule uma pergunta substantiva que surgiu durante a atividade)_

>
