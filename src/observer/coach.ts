import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./render.js";
import { jobFlagsMd, llmDir, workspaceDir } from "../shared/paths.js";

export function mainLlmInFlight(workspace?: string | null): boolean {
  const p = join(llmDir(workspace), "in_flight");
  if (!existsSync(p)) return false;
  try {
    return Number.parseInt(readFileSync(p, "utf8").trim() || "0", 10) > 0;
  } catch {
    return false;
  }
}

export function writeJobFlags(workspace?: string | null): string {
  const dest = jobFlagsMd(workspace);
  const envCode = (process.env.UNIQUE_CODE || "").trim();
  let code = envCode;
  if (!code) {
    const inp = join(workspaceDir(workspace), "input.json");
    if (existsSync(inp)) {
      try {
        const doc = JSON.parse(readFileSync(inp, "utf8")) as { unique_code?: unknown };
        code = String(doc.unique_code || "").trim();
      } catch {
        code = "";
      }
    }
  }
  if (!code) code = workspaceDir(workspace).split(/[/\\]/).pop() || "";
  const rows = thisJobFlagRows(workspaceDir(workspace), code);
  const lines = [`# This job: ${code || "(unknown)"}`, "# Only this unique_code. Flag values omitted.", ""];
  if (!rows.length) lines.push("No scored flags for this job yet.");
  else {
    for (const rec of rows) {
      const bits: string[] = [];
      if ("correct" in rec) bits.push(`correct=${rec.correct}`);
      const note = String(rec.note || "").trim();
      if (note) bits.push(`note=${note}`);
      const hop = String(rec.hop || "").trim();
      if (hop) bits.push(`hop=${hop}`);
      if (rec.flag_index != null) bits.push(`flag_index=${rec.flag_index}`);
      lines.push(bits.length ? "- " + bits.join(" ") : "- submitted (value omitted)");
    }
  }
  atomicWrite(dest, lines.join("\n") + "\n");
  return dest;
}

function thisJobFlagRows(workspace: string, code: string): Record<string, unknown>[] {
  const path = join(workspace, "flags.json");
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const items = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
    const out: Record<string, unknown>[] = [];
    for (const item of items) {
      if (typeof item === "string") {
        out.push({});
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const other = String(rec.unique_code || "").trim();
      if (other && code && other !== code) continue;
      const row: Record<string, unknown> = {};
      for (const k of ["correct", "note", "hop", "flag_index"]) {
        if (k in rec) row[k] = rec[k];
      }
      out.push(row);
    }
    return out;
  } catch {
    return [];
  }
}
