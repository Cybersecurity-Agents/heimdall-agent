import { describe, expect, it } from "vitest";
import {
  INJECT_MARKER,
  findInjectHits,
  injectBriefIntoMessages,
  injectMapIntoMessages,
  requestHasRealInject,
} from "../src/shared/inject.js";

const MAP = `${INJECT_MARKER}\nLOCK: x\n</heimdall-map>\n`;
const BRIEF = `<heimdall-brief>\ntry login\n</heimdall-brief>\n`;

function parse(raw: Buffer): Record<string, unknown> {
  return JSON.parse(raw.toString()) as Record<string, unknown>;
}

describe("map inject", () => {
  it("removes cached system maps when no current publication is available", () => {
    const example = "```\n" + MAP + "```\n";
    const raw = Buffer.from(JSON.stringify({ system: [
      { type: "text", text: "base\n" + MAP },
      { type: "text", text: MAP },
      { type: "text", text: example },
    ], messages: [{ role: "user", content: "question" }] }));
    const out = parse(injectMapIntoMessages(raw, null));
    expect(out.system).toEqual([{ type: "text", text: "base\n" }, { type: "text", text: example }]);
    expect(out.messages).toEqual([{ role: "user", content: "question" }]);
    const clean = Buffer.from(JSON.stringify({ messages: [] }));
    expect(injectMapIntoMessages(clean, null)).toBe(clean);
  });

  it("turns a Pi string system into text blocks instead of appending a string", () => {
    const raw = Buffer.from(JSON.stringify({ system: "base", messages: [] }));
    const out = parse(injectMapIntoMessages(raw, MAP));
    expect(out.system).toEqual([
      { type: "text", text: "base" },
      { type: "text", text: MAP },
    ]);
    expect(injectMapIntoMessages(Buffer.from("not-json"), MAP).toString()).toBe("not-json");
  });

  it("normalizes a string[] system the way Pi sometimes sends", () => {
    const raw = Buffer.from(JSON.stringify({ system: ["base"], messages: [] }));
    const out = parse(injectMapIntoMessages(raw, MAP));
    expect(out.system).toEqual([
      { type: "text", text: "base" },
      { type: "text", text: MAP },
    ]);
  });

  it("does not set a bare string system when Claude Code omits system", () => {
    const raw = Buffer.from(JSON.stringify({ messages: [{ role: "user", content: "q" }] }));
    const out = parse(injectMapIntoMessages(raw, MAP));
    expect(out.system).toEqual([{ type: "text", text: MAP }]);
  });

  it("appends a text block onto Claude Code system blocks", () => {
    const raw = Buffer.from(
      JSON.stringify({
        system: [{ type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } }],
        messages: [],
      }),
    );
    const out = parse(injectMapIntoMessages(raw, MAP));
    const system = out.system as { type: string; text: string }[];
    expect(system).toHaveLength(2);
    expect(system[0]).toEqual({
      type: "text",
      text: "You are Claude Code.",
      cache_control: { type: "ephemeral" },
    });
    expect(system[1]).toEqual({ type: "text", text: MAP });
    expect(typeof out.system).not.toBe("string");
    expect(system.some((item) => typeof item === "string")).toBe(false);
  });

  it("skips when the map already lives in a text block", () => {
    const raw = Buffer.from(
      JSON.stringify({
        system: [{ type: "text", text: "prefix\n" + MAP }],
        messages: [],
      }),
    );
    const injected = injectMapIntoMessages(raw, MAP);
    expect(injected.toString()).toBe(raw.toString());
  });

  it("wraps a single system object instead of overwriting it", () => {
    const raw = Buffer.from(JSON.stringify({ system: { type: "text", text: "base" }, messages: [] }));
    const out = parse(injectMapIntoMessages(raw, MAP));
    expect(out.system).toEqual([
      { type: "text", text: "base" },
      { type: "text", text: MAP },
    ]);
  });

  it("injects brief as a text block on the same SDK shape", () => {
    const raw = Buffer.from(
      JSON.stringify({
        system: [{ type: "text", text: "sdk" }],
        messages: [],
      }),
    );
    const out = parse(injectBriefIntoMessages(raw, BRIEF));
    expect(out.system).toEqual([
      { type: "text", text: "sdk" },
      { type: "text", text: BRIEF },
    ]);
  });

  it("still injects when the protocol only mentions the marker inline", () => {
    const protocol =
      "| `<heimdall-map>` | 本题覆盖图 |\n" +
      "后续 `system` 轮次可能出现 `<heimdall-map>`。\n";
    const raw = Buffer.from(JSON.stringify({ system: protocol, messages: [] }));
    const out = parse(injectMapIntoMessages(raw, MAP));
    const system = out.system as { type: string; text: string }[];
    expect(system).toHaveLength(2);
    expect(system[0]?.text).toBe(protocol);
    expect(system[1]?.text).toBe(MAP);
    expect(requestHasRealInject(Buffer.from(JSON.stringify(out)), "map")).toBe(true);
  });

  it("replaces an old map block instead of skipping or duplicating", () => {
    const oldMap = `${INJECT_MARKER}\nANGLES:\n- spray POST /login\n</heimdall-map>\n`;
    const newMap = `${INJECT_MARKER}\nANGLES:\n- SQLi on POST /login\n</heimdall-map>\n`;
    const raw = Buffer.from(
      JSON.stringify({
        system: [
          { type: "text", text: "base\n" },
          { type: "text", text: oldMap },
        ],
        messages: [],
      }),
    );
    const out = parse(injectMapIntoMessages(raw, newMap));
    const system = out.system as { type: string; text: string }[];
    expect(system.map((b) => b.text)).toEqual(["base\n", newMap]);
    expect(JSON.stringify(out)).not.toContain("spray POST /login");
  });

  it("collapses a second real map block after replacing the first", () => {
    const oldMap = `${INJECT_MARKER}\nLOCK: old\n</heimdall-map>\n`;
    const newMap = `${INJECT_MARKER}\nLOCK: new\n</heimdall-map>\n`;
    const raw = Buffer.from(
      JSON.stringify({
        system: [
          { type: "text", text: `prefix\n${oldMap}` },
          { type: "text", text: oldMap },
        ],
      }),
    );
    const out = parse(injectMapIntoMessages(raw, newMap));
    const system = out.system as { type: string; text: string }[];
    const maps = findInjectHits(system.map((b) => b.text).join("\n"), ["map"]);
    expect(maps).toHaveLength(1);
    expect(system.some((b) => b.text.includes("LOCK: new"))).toBe(true);
    expect(system.some((b) => b.text.includes("LOCK: old"))).toBe(false);
  });

  it("does not treat a fenced example as a live map", () => {
    const fenced = "example:\n\n```\n<heimdall-map>\nLOCK: demo\n</heimdall-map>\n```\n";
    const raw = Buffer.from(JSON.stringify({ system: fenced, messages: [] }));
    const out = parse(injectMapIntoMessages(raw, MAP));
    const system = out.system as { type: string; text: string }[];
    expect(system).toHaveLength(2);
    expect(system[1]?.text).toBe(MAP);
  });
});
