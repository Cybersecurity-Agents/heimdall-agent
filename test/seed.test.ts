import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withWorkspacePlaybook } from "../src/agent/prompts.js";
import { seedWorkspace } from "../src/control/seed.js";

const REPO = process.cwd();

describe("workspace seed", () => {
  it.each(["all", "web", "cve", "pwn", "intranet", "evasion"])(
    "seeds shared findings and the common WAF skill for %s",
    (challengeType) => {
      const ws = mkdtempSync(join(tmpdir(), "heimdall-seed-common-"));
      seedWorkspace(ws, REPO, { challengeType });
      expect(readFileSync(join(ws, "findings.json"), "utf8")).toBe(
        readFileSync(join(REPO, "resources/workspaces/base/findings.json"), "utf8"),
      );
      expect(readFileSync(join(ws, ".claude/skills/waf-bypass/SKILL.md"), "utf8")).toBe(
        readFileSync(join(REPO, "resources/skills/catalog/waf-bypass/_en/SKILL.md"), "utf8"),
      );
    },
  );

  it("preserves collected findings and the common skill when switching types", () => {
    const ws = mkdtempSync(join(tmpdir(), "heimdall-seed-resume-"));
    seedWorkspace(ws, REPO, { challengeType: "web" });
    const findings = '{"findings":[{"title":"existing evidence"}]}\n';
    writeFileSync(join(ws, "findings.json"), findings);
    seedWorkspace(ws, REPO, { challengeType: "cve" });
    expect(readFileSync(join(ws, "findings.json"), "utf8")).toBe(findings);
    expect(existsSync(join(ws, ".claude/skills/waf-bypass/SKILL.md"))).toBe(true);
  });

  it("dispatches CLAUDE.md by type and copies web skills", () => {
    const ws = mkdtempSync(join(tmpdir(), "heimdall-seed-"));
    seedWorkspace(ws, REPO, { challengeType: "web", forceClaudeMd: true });
    expect(existsSync(join(ws, "CLAUDE.md"))).toBe(true);
    const body = readFileSync(join(ws, "CLAUDE.md"), "utf8");
    expect(body.length).toBeGreaterThan(20);
    expect(existsSync(join(ws, "artifacts"))).toBe(true);
  });

  it("seeds cve playbook with bash grep path", () => {
    const ws = mkdtempSync(join(tmpdir(), "heimdall-seed-cve-"));
    seedWorkspace(ws, REPO, { challengeType: "cve", forceClaudeMd: true });
    const body = readFileSync(join(ws, "CLAUDE.md"), "utf8");
    expect(body).toContain("grep -Ril");
    expect(body).toContain("/root/nuclei-templates/http/cves");
    expect(body).toContain("heimdall-cve CVE-");
    expect(existsSync(join(ws, ".claude/skills/waf-bypass/SKILL.md"))).toBe(true);
    expect(body).not.toContain("烤库");
  });

  it("drops leftover skill dirs that the current overlays no longer ship", () => {
    const ws = mkdtempSync(join(tmpdir(), "heimdall-seed-stale-"));
    mkdirSync(join(ws, ".claude", "skills", "web-ctf"), { recursive: true });
    writeFileSync(join(ws, ".claude", "skills", "web-ctf", "SKILL.md"), "stale\n");
    seedWorkspace(ws, REPO, { challengeType: "intranet", forceClaudeMd: true });
    expect(readFileSync(join(ws, "CLAUDE.md"), "utf8")).toContain("Intranet pentest workspace");
    expect(readFileSync(join(ws, "CLAUDE.md"), "utf8")).not.toContain("内网渗透工作区");
    expect(existsSync(join(ws, ".claude", "skills", "web-ctf"))).toBe(false);
    expect(existsSync(join(ws, ".claude", "skills", "ai-app-ctf"))).toBe(false);
    expect(existsSync(join(ws, ".claude", "skills", "cloud-ctf"))).toBe(false);
    expect(existsSync(join(ws, ".claude", "skills", "waf-bypass"))).toBe(true);
  });

  it("inlines the seeded workspace-root CLAUDE.md into system for every type", () => {
    const expected: Record<string, string> = {
      intranet: "Intranet pentest workspace",
      web: "Web workspace",
      pwn: "Pwn / binary workspace",
      cve: "CVE / generic vuln",
      evasion: "Defense-evasion workspace",
      all: "Unified CTF workspace",
    };
    for (const [ctype, title] of Object.entries(expected)) {
      const ws = mkdtempSync(join(tmpdir(), `heimdall-sys-${ctype}-`));
      seedWorkspace(ws, REPO, { challengeType: ctype, forceClaudeMd: true });
      const system = withWorkspacePlaybook("Heimdall CTF solver\n", ws);
      expect(system).toContain("Heimdall CTF solver");
      expect(system).toContain("# Workspace playbook (CLAUDE.md)");
      expect(system).toContain(title);
      expect(system).not.toContain("内网渗透工作区");
    }
  });
});
