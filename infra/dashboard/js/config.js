// Tempo fixo de UI (não escala com HEARTBEAT_MS — ver docs/TEMPO.md).
export const POLL_TICK_MS = 500;
export const LOG_WINDOW = 30;
export const STREAM_WINDOW = 80;

// Fallback de heartbeat usado antes do primeiro evento `state` chegar.
// O valor real vem do nó Go via campo `heartbeat_ms` do evento `state`.
export const HEARTBEAT_MS_FALLBACK = 5000;

// Frações de HEARTBEAT_MS para duração de animação de cada tipo de pacote.
// Ver docs/TEMPO.md e docs/GEOMETRIA.md.
export const PACKET_FRACTIONS = {
  heartbeat:   0.35,
  entries:     0.50,
  appendResp:  0.30,
  vote:        0.25,
  voteResp:    0.25,
  snapshot:    0.60,
};

export function durationFor(kind, heartbeatMs) {
  const f = PACKET_FRACTIONS[kind] ?? 0.12;
  return f * heartbeatMs;
}

// Cores de pacote — referenciam variáveis CSS para tema central.
export const PACKET_COLORS = {
  heartbeat:        'var(--rpc-heartbeat)',
  entries:          'var(--rpc-entries)',
  appendRespOk:     'var(--rpc-append-resp)',
  appendRespFail:   'var(--rpc-vote-denied)',
  vote:             'var(--rpc-vote)',
  voteGranted:      'var(--rpc-vote-granted)',
  voteDenied:       'var(--rpc-vote-denied)',
  snapshot:         'var(--rpc-snapshot)',
};

// Constantes geométricas (px).
export const NODE_BOX = { w: 160, h: 130 };
export const NODE_EXCLUSION_PAD = 8;

// Duração dos destaques visuais transitórios (ms). Disparados na chegada
// do evento real (apply, commit_idx avanço) e expiram após esse tempo.
export const HIGHLIGHT_APPLY_MS = 1500;
export const HIGHLIGHT_QUORUM_MS = 2000;
