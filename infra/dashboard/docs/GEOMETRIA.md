# Geometria do Layout e Animação de Pacotes

Documento sobre como o `topologyView` calcula posições, traça links e roteia pacotes animados. Implementado em `infra/dashboard/js/geometry.js`.

## Objetivo

1. Posicionar N nós (3, 5, 7...) sem que linhas entre dois nós passem **por cima** de um terceiro nó.
2. Animar pacotes (heartbeats, replicação, votos, snapshots) ao longo de caminhos que respeitem a mesma regra.
3. Permanecer responsivo a resize sem recalcular tudo.

## Layout circular

Dado `N` nós, posicionar cada nó `i` (0-indexado) em torno de um círculo de centro `(cx, cy)` e raio `R_layout`:

```
angle_i = -π/2 + (2π · i) / N        // primeiro nó no topo, sentido horário
x_i = cx + R_layout · cos(angle_i)
y_i = cy + R_layout · sin(angle_i)
```

Constantes:
- `nodeBox = { w: 160, h: 140 }` — caixa visual do nó.
- `R_layout = max(120, min(cx, cy) - max(w, h)/2 - 20)` — garante que a caixa nunca cole na borda do contêiner.
- Recálculo no resize via `ResizeObserver` sobre `#topologia`.

## Por que circular

**Propriedade geométrica chave**: dados três pontos distintos quaisquer sobre um círculo, a corda entre dois deles **não passa pelo terceiro ponto**. Demonstração rápida: três pontos colineares sobre um círculo só existem se o "círculo" for degenerado (raio infinito = reta). Como `R_layout` é finito e positivo, qualquer triplete tem três pontos não-colineares, logo a corda entre dois deles está estritamente fora do terceiro.

Em outras palavras: o **centro** do nó nunca está sobre uma corda entre outros dois nós. Esta propriedade é gratuita do layout circular.

## Quando a corda tangencia a *caixa* de outro nó

A propriedade acima protege o centro do nó, mas as caixas têm dimensão. Para `N ≥ 6`, a corda entre dois nós distantes pode passar dentro do retângulo de outro nó mesmo sem cruzar seu centro.

Critério: definir o **raio de exclusão** `R_excl = max(w, h)/2 + 8` (caixa circunscrita + folga). Se a distância do centro de algum nó intermediário até o segmento da corda for menor que `R_excl`, a corda intercepta a caixa.

```
distSegPoint(p0, p1, q):
    v = p1 - p0
    w = q - p0
    c1 = dot(w, v)
    if c1 <= 0: return |q - p0|
    c2 = dot(v, v)
    if c2 <= c1: return |q - p1|
    b = c1 / c2
    pb = p0 + b·v
    return |q - pb|
```

## Roteamento de pacotes

`routePacket(from, to, allNodes, R_excl)` retorna um descritor de caminho (linha ou bezier quadrático). Pseudo-código:

```
routePacket(from, to, allNodes, R_excl):
    p0 = from.center
    p1 = to.center
    obstaculo = first(n in allNodes where n != from && n != to
                       && distSegPoint(p0, p1, n.center) < R_excl)
    if obstaculo is null:
        return { kind: 'line', p0, p1 }

    mid  = midpoint(p0, p1)
    perp = unitPerp(p1 - p0)                         // perpendicular unitário
    sinal = sign( dot(perp, mid - clusterCenter) )   // empurra para FORA do centro
    if sinal == 0: sinal = +1
    offset = 2 · R_excl + 12
    ctrl = mid + perp · offset · sinal
    return { kind: 'quad', p0, ctrl, p1 }
```

A escolha de empurrar o ponto de controle **para fora** do centro do cluster tem dois efeitos:
- Bezier resultante se afasta dos nós internos.
- Pacotes simultâneos entre pares diferentes se separam visualmente (cada um arqueia para seu próprio lado de fora).

Se ainda assim o bezier interceptar outro nó (caso patológico em N muito alto), o algoritmo aumenta `offset` em incrementos de `R_excl/2` até no máximo `4·R_excl`. Acima disso, aceita o cruzamento como limitação visual (improvável em N ≤ 9, que cobre os casos didáticos).

## Renderização SVG

Dois `<svg>` empilhados dentro de `#topologia`:

1. **`svg.links`** — atrás dos cards. Contém `<line>` ou `<path>` tracejado para cada par de nós conectados. Atualizado por mutação direta em `tickSilence`: links com `down=true` recebem `class="broken"` (cor cinza, opacidade reduzida).
2. **`svg.arrows`** — na frente dos cards. Cada pacote em voo é um `<circle>` (ou `<path>` para "esteira") percorrendo o path retornado por `routePacket`. Posição amostrada a cada `requestAnimationFrame` com `path.getPointAtLength(progress · pathLen)`.

Os cards (`<div class="node">`) ficam em uma camada DOM separada com `position: absolute` por cima dos SVGs. Eventos de clique nos cards funcionam normalmente porque o SVG superior usa `pointer-events: none`.

## Tabela de pacotes

Duração com `HEARTBEAT_MS=5000` (default). Escala proporcionalmente para outros valores — ver `TEMPO.md`.

| RPC | `entries` | Cor | Duração | Tamanho |
|---|---|---|---|---|
| `AppendEntries` | 0 | verde claro | 1750ms | pequeno (heartbeat) |
| `AppendEntries` | >0 | verde escuro | 2500ms | médio com "rastro" |
| `AppendEntriesResp` (success) | qualquer | verde-amarelado | 1500ms | pequeno |
| `AppendEntriesResp` (fail) | qualquer | laranja | 1500ms | pequeno |
| `RequestVote` | — | azul | 1250ms | pequeno |
| `RequestVoteResp` (granted) | — | azul claro | 1250ms | pequeno |
| `RequestVoteResp` (denied) | — | vermelho | 1250ms | pequeno |
| `InstallSnapshot` | — | roxo | 3000ms | grande |

A direção do pacote é `from → to`. Para respostas, `from` é quem respondeu e `to` é quem originalmente perguntou — visualmente parece "voltar".

## Tratamento de re-render

- Reposicionar nós (resize): re-executa `layout(N, cx, cy)`. Os SVGs são limpos e redesenhados; pacotes em voo são descartados (são efêmeros, perda é aceitável).
- Mudança de N (adição de nó via `RAFT_NODES`): só ocorre em boot, então não há recálculo dinâmico.
- Pacote chegou ao destino: removido da lista `state.packets` pelo `requestAnimationFrame` quando `progress >= 1`.

## Limitações conhecidas

- Layout circular escala mal acima de ~15 nós (caixas começam a se sobrepor). Para didática (3–7 nós) é mais que suficiente.
- Não há "lanes" para pacotes simultâneos entre o mesmo par. Múltiplos heartbeats em rápida sucessão se sobrepõem visualmente — o offset bezier mitiga, mas não elimina.
- Bezier quadrático foi escolhido em vez de cubic por simplicidade. Cubic permitiria evitar dois obstáculos simultâneos; quadratic só evita um.
