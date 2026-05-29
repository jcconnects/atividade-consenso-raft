import { NODE_BOX, NODE_EXCLUSION_PAD } from './config.js';

// Posições dos N nós em torno de um círculo. Primeiro no topo, sentido horário.
export function layout(nodeIds, width, height) {
  const cx = width / 2;
  const cy = height / 2;
  const minDim = Math.min(cx, cy);
  const r = Math.max(120, minDim - Math.max(NODE_BOX.w, NODE_BOX.h) / 2 - 24);
  const positions = {};
  const N = nodeIds.length;
  for (let i = 0; i < N; i++) {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / N;
    positions[nodeIds[i]] = {
      cx: cx + r * Math.cos(angle),
      cy: cy + r * Math.sin(angle),
    };
  }
  return { positions, center: { x: cx, y: cy }, radius: r };
}

// Distância de ponto Q ao segmento P0–P1.
function distSegPoint(p0, p1, q) {
  const vx = p1.cx - p0.cx, vy = p1.cy - p0.cy;
  const wx = q.cx  - p0.cx, wy = q.cy  - p0.cy;
  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return Math.hypot(q.cx - p0.cx, q.cy - p0.cy);
  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) return Math.hypot(q.cx - p1.cx, q.cy - p1.cy);
  const b = c1 / c2;
  const pbx = p0.cx + b * vx, pby = p0.cy + b * vy;
  return Math.hypot(q.cx - pbx, q.cy - pby);
}

// Calcula caminho do pacote — linha reta ou bezier desviando do nó obstáculo.
export function routePacket(from, to, otherNodes, center) {
  const exclusion = Math.max(NODE_BOX.w, NODE_BOX.h) / 2 + NODE_EXCLUSION_PAD;
  let obstacle = null;
  for (const n of otherNodes) {
    if (distSegPoint(from, to, n) < exclusion) {
      obstacle = n; break;
    }
  }
  if (!obstacle) {
    return { kind: 'line', p0: from, p1: to };
  }
  const mid = { cx: (from.cx + to.cx) / 2, cy: (from.cy + to.cy) / 2 };
  const dx = to.cx - from.cx, dy = to.cy - from.cy;
  const len = Math.hypot(dx, dy) || 1;
  const perpX = -dy / len, perpY = dx / len;
  // Afasta do centro do cluster.
  const dirX = mid.cx - center.x, dirY = mid.cy - center.y;
  const sign = Math.sign(perpX * dirX + perpY * dirY) || 1;
  const offset = 2 * exclusion + 12;
  return {
    kind: 'quad',
    p0: from,
    ctrl: { cx: mid.cx + perpX * offset * sign, cy: mid.cy + perpY * offset * sign },
    p1: to,
  };
}

// Constrói o atributo `d` para um <path> SVG.
export function pathD(route) {
  const { p0, p1 } = route;
  if (route.kind === 'line') {
    return `M ${p0.cx} ${p0.cy} L ${p1.cx} ${p1.cy}`;
  }
  return `M ${p0.cx} ${p0.cy} Q ${route.ctrl.cx} ${route.ctrl.cy} ${p1.cx} ${p1.cy}`;
}
