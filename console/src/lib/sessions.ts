type Part = { kind: string; text: string; has_hint?: boolean };

function sessFenceRanges(raw: string) {
  const ranges: [number, number][] = [];
  let i = 0;
  while (true) {
    const a = raw.indexOf("```", i);
    if (a < 0) break;
    const b = raw.indexOf("```", a + 3);
    if (b < 0) break;
    ranges.push([a, b + 3]);
    i = b + 3;
  }
  return ranges;
}

export function annotateSessText(raw: string): Part[] {
  if (!raw) return [];
  const specs: [string, string, string][] = [
    ["map", "<heimdall-map>", "</heimdall-map>"],
    ["brief", "<heimdall-brief>", "</heimdall-brief>"],
  ];
  const fences = sessFenceRanges(raw);
  const hits: [number, number, string][] = [];
  for (const [kind, open, close] of specs) {
    let start = 0;
    while (true) {
      const i = raw.indexOf(open, start);
      if (i < 0) break;
      start = i + open.length;
      if (i > 0 && raw.charAt(i - 1) !== "\n") continue;
      if (fences.some(([a, b]) => i >= a && i < b)) continue;
      const j = raw.indexOf(close, i + open.length);
      if (j < 0) continue;
      hits.push([i, j + close.length, kind]);
      start = j + close.length;
    }
  }
  hits.sort((a, b) => a[0] - b[0] || b[1] - a[1] - (a[1] - a[0]));
  const kept: [number, number, string][] = [];
  for (const hit of hits) {
    if (kept.length && hit[0] < kept[kept.length - 1][1]) continue;
    kept.push(hit);
  }
  const parts: Part[] = [];
  let cursor = 0;
  for (const [i, j, kind] of kept) {
    if (i > cursor) parts.push({ kind: "text", text: raw.slice(cursor, i) });
    const block = raw.slice(i, j);
    const item: Part = { kind, text: block };
    if (kind === "map" && /PLATFORM HINT/i.test(block)) item.has_hint = true;
    parts.push(item);
    cursor = j;
  }
  if (cursor < raw.length) parts.push({ kind: "text", text: raw.slice(cursor) });
  return parts.filter((p) => p.text);
}

export function sessRefreshMessages(messages: { role?: string; parts?: { text?: string }[] }[]) {
  return (messages || []).map((msg) => {
    const raw = (msg.parts || []).map((p) => p.text || "").join("");
    return { ...msg, parts: annotateSessText(raw) };
  });
}

export function sessInjectKinds(messages: { parts?: Part[] }[]) {
  const seen: string[] = [];
  for (const msg of messages || []) {
    for (const part of msg.parts || []) {
      const kind = part.kind || "";
      if ((kind === "map" || kind === "brief") && !seen.includes(kind)) seen.push(kind);
      if (part.has_hint && !seen.includes("hint")) seen.push("hint");
    }
  }
  return seen;
}
