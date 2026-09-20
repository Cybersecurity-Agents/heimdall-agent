import { atomicWrite } from "../shared/fsutil.js";

export { atomicWrite };

export function safeText(value: unknown, n = 180): string {
  let text = String(value || "")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ");
  text = text.replace("<heimdall-map>", "").replace("</heimdall-map>", "");
  text = text.replace(/</g, "‹").replace(/>/g, "›");
  if (text.length > n) return text.slice(0, n) + "…";
  return text;
}

export function renderHintObligation(hint: string, maxChars = 2000): string {
  let text = (hint || "").trim();
  if (!text) return "";
  text = text.replace("<heimdall-map>", "").replace("</heimdall-map>", "");
  if (text.length > maxChars) text = text.slice(0, maxChars) + "…";
  return (
    "PLATFORM HINT (runtime already injected; this direction is correct):\n" +
    `${text}\n` +
    "This hint is authoritative and outranks prior LOCK / brief. " +
    "Prefer this hint family first.\n"
  );
}

function dropPlatformHintSection(blob: string): string {
  const lines = blob.split(/(?<=\n)/);
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (line.startsWith("PLATFORM HINT")) {
      skipping = true;
      continue;
    }
    if (skipping) {
      const s = line.trim();
      if (s.startsWith("</heimdall-map>")) {
        skipping = false;
        out.push(line);
        continue;
      }
      const colon = s.indexOf(":");
      const head = (colon < 0 ? s : s.slice(0, colon)).trim();
      if (s.endsWith(":") && /^[A-Za-z_]+$/.test(head.replace(/_/g, "")) && head === head.toUpperCase()) {
        skipping = false;
        out.push(line);
        continue;
      }
      continue;
    }
    out.push(line);
  }
  return out.join("");
}

export function mergeHintIntoInject(blob: string | null | undefined, hint: string | null | undefined): string | null {
  const obligation = renderHintObligation(hint || "");
  let raw = (blob || "").trim();
  if (!obligation) {
    if (raw && raw.includes("<heimdall-map>")) return raw.endsWith("\n") ? raw : raw + "\n";
    return null;
  }
  let probe = "";
  for (const line of (hint || "").split("\n")) {
    if (line.trim()) {
      probe = line.trim().slice(0, 48);
      break;
    }
  }
  if (raw && raw.includes("<heimdall-map>") && probe && raw.includes(probe)) {
    return raw.endsWith("\n") ? raw : raw + "\n";
  }
  if (raw && raw.includes("<heimdall-map>")) {
    const stripped = dropPlatformHintSection(raw);
    const idx = stripped.indexOf("<heimdall-map>");
    if (idx >= 0) {
      let insertAt = idx + "<heimdall-map>".length;
      if (insertAt < stripped.length && stripped[insertAt] === "\n") insertAt += 1;
      const out = stripped.slice(0, insertAt) + obligation + stripped.slice(insertAt);
      return out.endsWith("\n") ? out : out + "\n";
    }
  }
  return "<heimdall-map>\n" + obligation + "</heimdall-map>\n";
}
