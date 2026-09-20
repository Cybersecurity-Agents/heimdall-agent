/** Deterministic dependency layout. This module does not interpret coverage or priority. */
type GNode = Record<string, unknown>;
type GEdge = Record<string, unknown>;

export function sugiyamaLayout(
  nodes: GNode[],
  edges: GEdge[],
  opts: { col?: number; padX?: number; padY?: number; nw?: number; nh?: number; gapY?: number } = {},
): { width: number; height: number } {
  const col = opts.col ?? 260;
  const padX = opts.padX ?? 48;
  const padY = opts.padY ?? 40;
  const nw = opts.nw ?? 188;
  const nh = opts.nh ?? 68;
  const gapY = opts.gapY ?? 32;
  if (!nodes.length) return { width: padX * 2, height: padY * 2 };
  const byId: Record<string, GNode> = Object.create(null);
  for (const n of nodes) byId[String(n.id)] = n;
  const pred: Record<string, string[]> = Object.create(null);
  const succ: Record<string, string[]> = Object.create(null);
  for (const i of Object.keys(byId)) {
    pred[i] = [];
    succ[i] = [];
  }
  for (const e of edges) {
    const a = String(e.from || "");
    const b = String(e.to || "");
    if (a in byId && b in byId && a !== b) {
      succ[a]!.push(b);
      pred[b]!.push(a);
    }
  }
  // Longest-path layering: every dependency advances at least one column,
  // including direction -> direction and recon -> scan.
  const remaining = new Map(Object.keys(byId).map((id) => [id, pred[id]!.length]));
  const queue = Object.keys(byId).filter((id) => remaining.get(id) === 0);
  for (const n of nodes) n.rank = 0;
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    for (const next of succ[id]!) {
      byId[next]!.rank = Math.max(Number(byId[next]!.rank), Number(byId[id]!.rank) + 1);
      remaining.set(next, remaining.get(next)! - 1);
      if (remaining.get(next) === 0) queue.push(next);
    }
  }
  if (queue.length !== nodes.length) throw new Error("cannot lay out a cyclic graph");
  const ranks = [...new Set(nodes.map((n) => Number(n.rank || 0)))].sort((a, b) => a - b);
  const index: Record<number, number> = {};
  ranks.forEach((r, i) => {
    index[r] = i;
  });
  const layers: Record<number, string[]> = {};
  for (let i = 0; i < ranks.length; i++) layers[i] = [];
  for (const n of nodes) layers[index[Number(n.rank || 0)]!]!.push(String(n.id));

  const orderLayer = (layer: string[], neigh: Record<string, string[]>, pos: Record<string, number>): string[] => {
    const scored: [number, number, string][] = [];
    layer.forEach((nid, i) => {
      const xs = (neigh[nid] || []).filter((x) => x in pos).map((x) => pos[x]!);
      const bary = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : i;
      scored.push([bary, i, nid]);
    });
    scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return scored.map((x) => x[2]);
  };

  const order: Record<number, string[]> = {};
  for (const [r, ids] of Object.entries(layers)) order[Number(r)] = [...ids];
  const maxR = Math.max(0, ...Object.keys(order).map(Number));
  for (let pass = 0; pass < 4; pass++) {
    for (let r = 1; r <= maxR; r++) {
      const pos: Record<string, number> = Object.create(null);
      (order[r - 1] || []).forEach((nid, i) => {
        pos[nid] = i;
      });
      order[r] = orderLayer(order[r] || [], pred, pos);
    }
    for (let r = maxR - 1; r >= 0; r--) {
      const pos: Record<string, number> = Object.create(null);
      (order[r + 1] || []).forEach((nid, i) => {
        pos[nid] = i;
      });
      order[r] = orderLayer(order[r] || [], succ, pos);
    }
  }

  const sizes: Record<string, [number, number]> = {
    start: [128, 44],
    recon: [nw, nh],
    direction: [Math.max(nw, 228), 76],
    endpoint: [nw, nh],
    path: [nw, nh],
    scan: [nw, nh],
    flag: [nw, 64],
    next: [nw, nh],
  };
  for (const [rStr, ids] of Object.entries(order)) {
    const r = Number(rStr);
    let y = padY;
    ids.forEach((nid) => {
      const n = byId[nid]!;
      const [w, h] = sizes[String(n.group || "")] || [nw, nh];
      n.x = padX + r * col;
      n.y = y;
      y += h + gapY;
      n.width = w;
      n.height = h;
    });
  }
  for (const r of Object.keys(order)
    .map(Number)
    .sort((a, b) => a - b)) {
    if (r === 0) continue;
    const placed = (order[r] || []).map((nid) => byId[nid]!);
    for (const n of placed) {
      const mids = (pred[String(n.id)] || [])
        .filter((p) => p in byId)
        .map((p) => Number(byId[p]!.y) + Number(byId[p]!.height) / 2);
      if (mids.length) n.y = mids.reduce((a, b) => a + b, 0) / mids.length - Number(n.height) / 2;
    }
    placed.sort((a, b) => Number(a.y) - Number(b.y));
    placed.forEach((n, i) => {
      if (i === 0) n.y = Math.max(padY, Number(n.y));
      else {
        const floor = Number(placed[i - 1]!.y) + Number(placed[i - 1]!.height) + gapY;
        if (Number(n.y) < floor) n.y = floor;
      }
    });
  }
  const maxX = Math.max(...nodes.map((n) => Number(n.x) + Number(n.width))) + padX;
  const maxY = Math.max(...nodes.map((n) => Number(n.y) + Number(n.height))) + padY;
  return { width: Math.trunc(maxX), height: Math.trunc(maxY) };
}

