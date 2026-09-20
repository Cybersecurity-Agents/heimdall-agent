export function emptyTok() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    calls: 0,
    total_tokens: 0,
  };
}

export function fmtTok(n: number | string | undefined | null) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  if (abs < 1000) return String(v);
  if (abs < 1e6) return (v / 1e3).toFixed(abs < 10000 ? 1 : 0).replace(/\.0$/, "") + "k";
  if (abs < 1e9) return (v / 1e6).toFixed(abs < 1e7 ? 1 : 0).replace(/\.0$/, "") + "M";
  return (v / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
}

export function fmtTs(ts: number | string | undefined, lang: string) {
  const n = Number(ts);
  if (!n) return "—";
  const d = new Date(n * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(lang === "en" ? "en-GB" : "zh-CN", { hour12: false });
}
