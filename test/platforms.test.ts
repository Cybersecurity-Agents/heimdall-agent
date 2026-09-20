import { describe, expect, it } from "vitest";
import { createBench, DirectBench, hasRemoteBench, TsecClient } from "../src/platforms/index.js";

describe("createBench", () => {
  it("uses DirectBench when url or token is missing", () => {
    expect(hasRemoteBench({ base_url: "", token: "" })).toBe(false);
    expect(hasRemoteBench({ base_url: "http://x", token: "" })).toBe(false);
    expect(createBench({ base_url: "", token: "" })).toBeInstanceOf(DirectBench);
  });

  it("uses the remote bench client when both url and token are set", () => {
    expect(hasRemoteBench({ base_url: "http://bench.example.invalid", token: "t" })).toBe(true);
    expect(createBench({ base_url: "http://bench.example.invalid", token: "t" })).toBeInstanceOf(TsecClient);
  });

  it("DirectBench start/close/hint do not need a platform", async () => {
    const b = new DirectBench();
    expect(await b.listChallenges()).toEqual([]);
    expect(await b.start("url-abc")).toEqual({ container_addr: [], container_status: "direct" });
    expect(await b.close("url-abc")).toEqual({ closed: true });
    expect(await b.hint?.("url-abc")).toBeNull();
    const rec = await b.submit("url-abc", "flag{x}");
    expect(rec.correct).toBe(false);
    expect(rec.raw).toEqual({ source: "direct" });
  });
});
