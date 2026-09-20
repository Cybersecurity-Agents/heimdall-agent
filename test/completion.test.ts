import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  decideExitCode,
  forgetStaleCorrectFlags,
  hasCorrectSubmit,
  isChallengeComplete,
} from "../src/shared/completion.js";

function ws(): string {
  return mkdtempSync(join(tmpdir(), "heimdall-comp-"));
}

describe("completion", () => {
  it("ignores solver-written correct:true without via=heimdall-submit", () => {
    const dir = ws();
    writeFileSync(
      join(dir, "flags.json"),
      JSON.stringify([{ flag: "flag{x}", correct: true }]) + "\n",
    );
    expect(hasCorrectSubmit(dir)).toBe(false);
    expect(isChallengeComplete(dir)).toBe(false);
  });

  it("does not let exit zero or a partial accepted flag complete the task", () => {
    const dir = ws();
    writeFileSync(join(dir, "input.json"), JSON.stringify({ flag_count: 6 }));
    writeFileSync(join(dir, "flags.json"), JSON.stringify([{ flag: "flag{a}", correct: true, via: "heimdall-submit" }]));
    expect(decideExitCode({ workspace: dir, backendOk: true, backendExit: 0 })).toBe(1);
  });

  it("requires platform completion when the total flag count is unknown", () => {
    const dir = ws();
    writeFileSync(join(dir, "input.json"), JSON.stringify({ flag_count: 0 }));
    writeFileSync(join(dir, "flags.json"), JSON.stringify([{ flag: "flag{a}", correct: true, via: "heimdall-submit" }]));
    expect(isChallengeComplete(dir)).toBe(false);
  });

  it("stops on platform submit when flag_count is 1", () => {
    const dir = ws();
    writeFileSync(join(dir, "input.json"), JSON.stringify({ flag_count: 1 }) + "\n");
    writeFileSync(
      join(dir, "flags.json"),
      JSON.stringify([{ flag: "flag{x}", correct: true, via: "heimdall-submit" }]) + "\n",
    );
    expect(hasCorrectSubmit(dir)).toBe(true);
    expect(isChallengeComplete(dir)).toBe(true);
    expect(decideExitCode({ workspace: dir, backendOk: true, backendExit: 0 })).toBe(0);
  });

  it("keeps multi-flag jobs open after first submit", () => {
    const dir = ws();
    writeFileSync(join(dir, "input.json"), JSON.stringify({ flag_count: 2 }) + "\n");
    writeFileSync(
      join(dir, "flags.json"),
      JSON.stringify([{ flag: "flag{a}", correct: true, via: "heimdall-submit" }]) + "\n",
    );
    expect(hasCorrectSubmit(dir)).toBe(true);
    expect(isChallengeComplete(dir)).toBe(false);
  });

  it("keeps heimdall-submit rows when the platform row is still 0/6", () => {
    const dir = ws();
    const rows = [
      { flag: "flag{one}", correct: true, via: "heimdall-submit" },
      { flag: "flag{two}", correct: true, via: "heimdall-submit" },
    ];
    writeFileSync(join(dir, "flags.json"), JSON.stringify(rows) + "\n");
    expect(forgetStaleCorrectFlags(dir, { chRow: { flag_count: 6, correct_flag_count: 0 } })).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "flags.json"), "utf8"))).toEqual(rows);
  });

  it("clears the flag ledger only on rotation or force", () => {
    const dir = ws();
    writeFileSync(
      join(dir, "flags.json"),
      JSON.stringify([{ flag: "flag{old}", correct: true, via: "heimdall-submit" }]) + "\n",
    );
    expect(forgetStaleCorrectFlags(dir, { instanceRotated: true, chRow: { flag_count: 6, correct_flag_count: 0 } })).toBe(
      true,
    );
    expect(JSON.parse(readFileSync(join(dir, "flags.json"), "utf8"))).toEqual([]);
  });

  it("maps hard backend 2 through", () => {
    const dir = ws();
    expect(decideExitCode({ workspace: dir, backendOk: false, backendExit: 2 })).toBe(2);
  });
});
