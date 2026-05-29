# Tempo: o que escala com o heartbeat, o que é fixo

Este documento explica todas as constantes temporais do sistema, sua origem, e por que algumas são proporcionais ao intervalo de heartbeat e outras não. É o contrato de honestidade visual: o que o dashboard mostra reflete o que está realmente acontecendo no Raft, na medida certa.

## Princípio

> **Tempo do Raft escala. Tempo do observador é fixo.**

Constantes que representam dinâmica do algoritmo Raft (heartbeat, eleição, lease, animação de pacote, detecção de partição) são todas frações de um único parâmetro: `HEARTBEAT_MS`. Mudar esse parâmetro escala consistentemente toda a percepção visual.

Constantes que representam dinâmica da própria UI ou do observador (frequência de polling, tamanho de janelas, refresh de DOM) são fixas. Não fazem parte do que o estudante está observando — fazem parte de **como** está observando.

## `HEARTBEAT_MS` — único botão de controle

Definido via env `RAFT_HEARTBEAT_MS` em cada serviço de nó no `docker-compose.yml`. Default 5000.

- Para apresentar com calma: editar para `10000`, `docker compose down -v && docker compose up --build`.
- Para velocidade de produção: editar para `500`. Dashboard fica praticamente ilegível — sinaliza que esse não é o objetivo.

Não há toggle runtime. Reinício do cluster é parte explícita do experimento.

## Tempos do Raft (escalam com heartbeat)

### Lado Go — `infra/node/main.go`

| Parâmetro Raft | Valor | Razão |
|---|---|---|
| `HeartbeatTimeout` | `1 × HEARTBEAT_MS` | base do sistema |
| `ElectionTimeout` | `2 × HEARTBEAT_MS` | > heartbeat para evitar eleições espúrias |
| `LeaderLeaseTimeout` | `1 × HEARTBEAT_MS` | líder cede lease se não ouvir maioria por 1 intervalo |
| `CommitTimeout` | `0.2 × HEARTBEAT_MS` | reage rápido a novos writes |

Proporções vêm do paper original do Raft. Mantê-las garante comportamento qualitativamente idêntico em qualquer escala de `HEARTBEAT_MS`.

### Lado JS — `infra/dashboard/js/config.js`

**Duração de animação de pacote** = fração fixa de `HEARTBEAT_MS`:

| RPC | Fração | Duração com HB=5s | Duração com HB=10s |
|---|---|---|---|
| `AppendEntries` (heartbeat, entries=0) | 0.35 | 1750ms | 3500ms |
| `AppendEntries` (replicação, entries>0) | 0.50 | 2500ms | 5000ms |
| `AppendEntriesResp` | 0.30 | 1500ms | 3000ms |
| `RequestVote` | 0.25 | 1250ms | 2500ms |
| `RequestVoteResp` | 0.25 | 1250ms | 2500ms |
| `InstallSnapshot` | 0.60 | 3000ms | 6000ms |

Garantia: todas as frações são menores que 1, então a animação termina antes do próximo heartbeat nascer. Pacotes do mesmo par não se sobrepõem visualmente em uso normal.

**Limite de silêncio para detecção de partição** = `2 × HEARTBEAT_MS`:

- Em HB=5s, link cai após 10s de silêncio.
- Em HB=10s, link cai após 20s.

Fator 2× tolera um heartbeat perdido (latência, GC pause) sem alarme falso.

## Tempos do observador (fixos)

Estes valores **não** representam tempo Raft. Não escalar com heartbeat — escalá-los introduziria latência de UI sem ganho.

| Constante | Valor | Onde | Função |
|---|---|---|---|
| `pollState` tick | 500ms | `infra/node/main.go:161` | frequência com que cada nó publica snapshot de estado no SSE |
| Tick de silêncio | 500ms | `infra/dashboard/js/main.js` (`setInterval`) | frequência com que o dashboard recomputa `down` por link |
| Reconexão SSE | ~3s | controlado pelo navegador | retry automático do `EventSource` |
| Janela do painel de logs | 30 índices (linhas da matriz) | `js/views/logPanelView.js` (`LOG_WINDOW`) | recorte visual |
| Janela do stream textual | 80 eventos | `js/views/eventStreamView.js` (`STREAM_WINDOW`) | recorte visual |
| Destaque "recém-aplicado" na célula | 1500ms | `js/config.js` (`HIGHLIGHT_APPLY_MS`) | duração do realce visual após evento `apply`; o estado da célula (comprometido) é o mesmo antes/depois |
| Badge "quórum atingido" no card | 2000ms | `js/config.js` (`HIGHLIGHT_QUORUM_MS`) | duração do realce após avanço de `commit_idx` no líder |
| `requestAnimationFrame` | ~16ms (60fps) | navegador | refresh da animação SVG |

Justificativa por linha:

- **`pollState` 500ms**: ortogonal ao heartbeat. Mesmo com HB=30s, o dashboard precisa de atualizações de estado mais frequentes que isso para parecer vivo. Independência preservada.
- **Tick de silêncio 500ms**: granularidade de detecção. Em HB=5s, detecta partição em até 10s + meio tick = 10.5s. Em HB=10s, 20.5s. Latência adicional desprezível.
- **Reconexão SSE**: controlada pelo browser. Não há motivo Raft para mudar.
- **Janelas (30, 50)**: quantidades, não tempos. Preferência visual.

## Caso especial: `pollState` e `state` event

`pollState` em `infra/node/main.go:161` dispara a cada 500ms e emite evento `state` com `heartbeat_ms` embutido. Razão:

- 500ms é menor que qualquer heartbeat sensato — dashboard sempre converge para o último estado em ≤ 500ms.
- Evento `state` carrega `heartbeat_ms` para o dashboard derivar todas as frações de animação localmente. Sem isso, dashboard precisaria de uma chamada HTTP separada na inicialização.

Esse é o único ponto onde "tempo fixo da UI" e "tempo escalável do Raft" se cruzam: o evento que **transporta** o valor escalável é emitido em frequência fixa.

## Verificação visual de honestidade

Estudante pode verificar empiricamente que a animação reflete tempo real:

1. Subir com `HEARTBEAT_MS=5000`. Cronometrar com smartphone o tempo entre dois heartbeats do mesmo líder no diagrama. Esperado: ~5s.
2. Editar compose para `HEARTBEAT_MS=10000`. `docker compose down -v && up --build`. Cronometrar de novo. Esperado: ~10s. Animação dos pacotes cresce na mesma proporção (2×).
3. Cronometrar o tempo entre derrubar líder (botão `Kill leader`) e nova eleição estabilizar. Esperado: tipicamente entre `1× HEARTBEAT_MS` e `2× HEARTBEAT_MS` (entre lease expiration e election timeout).

Se os números crescerem com fator diferente de 2× ao dobrar `HEARTBEAT_MS`, há bug — provavelmente alguma constante vazou hardcoded em vez de derivada.

## Limitações documentadas

- Heartbeat abaixo de ~1000ms torna a animação imperceptível (frações × 1000ms = 80–300ms). Esperado e didaticamente útil: deixa claro que sistemas Raft de produção operam em escala fora do alcance da observação humana direta.
- Heartbeat acima de ~30000ms torna a atividade tediosa (cada experimento leva minuto+). Use só para inspeção sob demanda.
- `pollState` 500ms é o piso de latência do dashboard. Heartbeat de 100ms não traz benefício porque o estado só é amostrado a cada 500ms de qualquer forma.

## Onde mexer se precisar mudar

Para adicionar novo parâmetro **escalável**: defina como fração em `js/config.js → PACKET_FRACTIONS` e use `durationFor(kind, state.heartbeat_ms)`.

Para adicionar novo parâmetro **fixo**: defina constante nomeada em `js/config.js → POLL_TICK_MS`, `LOG_WINDOW`, etc. Documente aqui (`TEMPO.md`) a categoria com justificativa.

Regra de bolso para classificar: se mudar `HEARTBEAT_MS` deveria mudar esse valor proporcionalmente, é escalável. Senão, fixo.
