import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function jsonable(obj: unknown, depth = 0): unknown {
  if (depth > 8) return String(obj);
  if (obj === null || ["boolean", "number", "string"].includes(typeof obj)) return obj;
  if (typeof obj === "bigint") return Number(obj);
  if (Array.isArray(obj)) return obj.map((x) => jsonable(x, depth + 1));
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k.startsWith("_")) continue;
      out[k] = jsonable(v, depth + 1);
    }
    return out;
  }
  return String(obj).slice(0, 2000);
}

export class EventSink {
  turnCount = 0;
  toolUseCount = 0;
  messageCount = 0;
  lastError: string | null = null;
  private textLog: string | null;

  constructor(
    readonly eventsPath: string,
    textLog?: string | null,
    private readonly options: { stdout?: boolean; jobId?: string } = {},
  ) {
    mkdirSync(dirname(eventsPath), { recursive: true });
    this.textLog = textLog ?? null;
    if (this.textLog) mkdirSync(dirname(this.textLog), { recursive: true });
  }

  close(): void {
    /* appendFileSync is already flushed */
  }

  writeText(line: string): void {
    const text = line.endsWith("\n") ? line : line + "\n";
    if (this.options.stdout) { process.stdout.write(text); return; }
    if (!this.textLog) return;
    try {
      appendFileSync(this.textLog, text, "utf8");
    } catch {
      /* ignore */
    }
  }

  onMessage(message: unknown): void {
    const rec = message && typeof message === "object" ? (message as Record<string, unknown>) : {};
    const name = String(rec.type || rec.message_type || "");
    const subtype = String(rec.subtype || "");
    if (name.includes("stream") || name === "stream_event") return;
    if (subtype === "thinking_tokens") return;
    this.messageCount += 1;
    this.emit("message", rec, { message_type: name });
    const content = (rec.content || (rec.message as Record<string, unknown> | undefined)?.content) as unknown;
    if (name.includes("assistant") || name.includes("result") || name === "result") {
      this.turnCount += 1;
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        const btype = String(b.type || "");
        if (btype.includes("thinking")) continue;
        const tool = String(b.name || b.toolName || "");
        const isTool = btype.includes("tool") || (tool && (b.input || b.tool_input));
        if (isTool && !btype.includes("result") && !String(b.type || "").includes("Result")) {
          this.toolUseCount += 1;
          this.writeText(`[tool_use] ${tool || btype}`);
        } else if (typeof b.text === "string" && b.text.trim()) {
          this.writeText(`[assistant] ${b.text.replace(/\n/g, " ").slice(0, 500)}`);
        }
      }
      return;
    }
    const result = rec.result;
    if (subtype || result != null) {
      this.writeText(`[${name || "sdk"}] subtype=${subtype || ""} result=${String(result || "").slice(0, 300)}`);
    }
  }

  emit(kind: string, payload: unknown = null, extra: Record<string, unknown> = {}): void {
    const rec = {
      ts: Date.now() / 1000,
      ...(this.options.jobId ? { job_id: this.options.jobId } : {}),
      kind,
      payload: jsonable(payload),
      ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, jsonable(v)])),
    };
    try {
      writeFileSync(this.eventsPath, JSON.stringify(rec) + "\n", { encoding: "utf8", flag: "a" });
    } catch (e) {
      this.lastError = `events write failed: ${e}`;
    }
  }
}
