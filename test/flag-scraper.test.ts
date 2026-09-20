import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractFromText, scrapeWorkspace } from "../src/shared/flag-scraper.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("flag scraper", () => {
  it("extracts brace flags", () => {
    const flags = extractFromText("got it: flag{hello_world} and also CTF{abc}");
    expect(flags).toContain("flag{hello_world}");
    expect(flags.some((f) => f.toLowerCase().startsWith("ctf{"))).toBe(true);
    expect(extractFromText("noise data{not_a_flag} config{x} alert{y}")).toEqual([]);
  });

  it("scrapes workspace files", () => {
    const dir = mkdtempSync(join(tmpdir(), "heimdall-flags-"));
    dirs.push(dir);
    writeFileSync(join(dir, "flags.json"), '[{"flag": "flag{from_json}"}]');
    writeFileSync(join(dir, "progress.md"), "maybe flag{from_md}\n");
    const log = join(dir, "run.log");
    writeFileSync(log, "noise flag{from_log} noise\n");
    const got = scrapeWorkspace(dir, [log]);
    expect(got).toContain("flag{from_json}");
    expect(got).toContain("flag{from_md}");
    expect(got).toContain("flag{from_log}");
  });
});
