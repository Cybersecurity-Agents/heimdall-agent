import { resourcePath } from "../../shared/resources.js";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Config } from "../../shared/config.js";
import { bundledTemplate, loadProtocolFile } from "../../agent/prompts.js";
import * as llmIo from "./llm-io.js";

const MAX_BYTES = 256_000;

type Spec = {
  id: string;
  group: string;
  title_zh: string;
  title_en: string;
  kind: "overlay" | "file";
  injected: boolean;
  inject_zh: string;
  inject_en: string;
};

const CATALOG: Spec[] = [
  {
    id: "solver-protocol",
    group: "solver",
    title_zh: "求解协议",
    title_en: "Solver protocol",
    kind: "overlay",
    injected: true,
    inject_zh: "Regular / Loop 开跑时写入 .pi/SYSTEM.md，作为求解 Agent 的 system。控制台保存过则覆盖内置 PROTOCOL，并拷到 workspace/.heimdall/operator_prompt.md。工具表和打法不在这份里。",
    inject_en: "Written to .pi/SYSTEM.md when a Regular or Loop job starts. A saved overlay replaces the built-in PROTOCOL and is copied to workspace/.heimdall/operator_prompt.md. Tools and playbooks are not in this overlay.",
  },
  {
    id: "solver-user",
    group: "solver",
    title_zh: "开场 user",
    title_en: "Opening user prompt",
    kind: "overlay",
    injected: true,
    inject_zh: "Regular / Loop 第一轮的 user 消息。运行时填入 {{task_lines}}、hint、LOCK、brief。{{#name}}...{{/name}} 在 name 为空时整段省略。",
    inject_en: "User message for the first Regular / Loop turn. Runtime fills {{task_lines}}, hint, LOCK, brief. {{#name}}...{{/name}} is omitted when name is empty.",
  },
  {
    id: "solver-loop",
    group: "solver",
    title_zh: "Loop 续跑",
    title_en: "Loop follow-up",
    kind: "overlay",
    injected: true,
    inject_zh: "until-flag 求解提前停下时的下一轮 user。运行时填入轮次、覆盖图、剩余 flag。",
    inject_en: "User message for the next until-flag turn after the solver stops early. Runtime fills the iteration, coverage map, and remaining flags.",
  },
  {
    id: "workspace-all",
    group: "workspace",
    title_zh: "全量手册",
    title_en: "Unified playbook",
    kind: "file",
    injected: true,
    inject_zh: "平台未分赛道、或缺省 Workspace 时，seed 成该题 workspace/CLAUDE.md。含工具总表 + Web / Pwn / 内网 / 通用漏洞 / 对抗规避各一节。",
    inject_en: "Seeded as the job CLAUDE.md when the platform reports no type, or the desk leaves the default. Full tool table plus one section each for web / pwn / intranet / CVE / evasion.",
  },
  {
    id: "workspace-web",
    group: "workspace",
    title_zh: "Web 手册",
    title_en: "Web playbook",
    kind: "file",
    injected: false,
    inject_zh: "工作台把该题 Workspace 选成 Web 时，seed 成该题 workspace/CLAUDE.md。HTTP / Playwright / OCR / 提示注入。`ai` / `llm` 是 Web 的别名。",
    inject_en: "Seeded as the job CLAUDE.md when the desk picks Web. HTTP / Playwright / OCR / prompt injection. `ai` / `llm` alias to Web.",
  },
  {
    id: "workspace-pwn",
    group: "workspace",
    title_zh: "Pwn 手册",
    title_en: "Pwn playbook",
    kind: "file",
    injected: false,
    inject_zh: "工作台把该题 Workspace 选成 Pwn 时，seed 成该题 workspace/CLAUDE.md。加载公共 waf-bypass 技能。",
    inject_en: "Seeded as the job CLAUDE.md when the desk picks Pwn. Loads the shared waf-bypass skill.",
  },
  {
    id: "workspace-intranet",
    group: "workspace",
    title_zh: "内网手册",
    title_en: "Intranet playbook",
    kind: "file",
    injected: false,
    inject_zh: "工作台把该题 Workspace 选成内网时，seed 成该题 workspace/CLAUDE.md。Regular Pi 和 SDK loop 都内联进 system；SDK 排除 user 侧 claudeMd。默认 overlay 已烤 chisel / AD 工具。",
    inject_en: "Seeded as the job CLAUDE.md when the desk picks Intranet. Regular Pi and the SDK loop both inline it into system; the SDK excludes user-side claudeMd. Default overlay bakes chisel / AD tools.",
  },
  {
    id: "workspace-cve",
    group: "workspace",
    title_zh: "通用漏洞手册",
    title_en: "CVE playbook",
    kind: "file",
    injected: false,
    inject_zh: "工作台选通用漏洞时 seed 成 workspace/CLAUDE.md。grep 产品字样，heimdall-cve 打开编号。",
    inject_en: "Seeded as workspace/CLAUDE.md when the desk picks CVE. Grep the product, heimdall-cve opens the id.",
  },
  {
    id: "workspace-evasion",
    group: "workspace",
    title_zh: "对抗规避手册",
    title_en: "Evasion playbook",
    kind: "file",
    injected: false,
    inject_zh: "工作台把该题 Workspace 选成对抗规避时，seed 成该题 workspace/CLAUDE.md。免杀手法分类 + 脱壳/对抗。`edr` / `fud` 是别名。",
    inject_en: "Seeded as the job CLAUDE.md when the desk picks Evasion. AV/EDR technique classes plus unpack/counter. `edr` / `fud` alias here.",
  },
  {
    id: "observer",
    group: "observer",
    title_zh: "观察者",
    title_en: "Observer",
    kind: "file",
    injected: true,
    inject_zh: "观察者 Pi 每个 tick 作为 system。带 --no-context-files，不读题 workspace 的 CLAUDE.md。",
    inject_en: "Observer Pi uses this as system on every tick. It runs with --no-context-files, so it does not read the job CLAUDE.md.",
  },
  {
    id: "observer-spray",
    group: "observer",
    title_zh: "内网动态凭据字典生成",
    title_en: "Intranet dynamic credential dictionary generation",
    kind: "file",
    injected: true,
    inject_zh: "根据观察到的账号、凭据和命名线索，持续生成并更新凭据字典。",
    inject_en: "Continuously generate and update credential dictionaries from observed accounts, credentials, and naming clues.",
  },
  {
    id: "observer-recap",
    group: "observer",
    title_zh: "观察者复盘",
    title_en: "Observer recap",
    kind: "file",
    injected: true,
    inject_zh: "独立复盘 system：平台接受 flag 时立即使用；任务成功或超时后补齐最终图。失败和手动停止不触发。不会注入 solver。",
    inject_en: "Independent observer system after accepted flags, succeeded jobs or timeouts. Not used for failed/cancelled jobs or injected into the solver.",
  },
  {
    id: "summarizer",
    group: "observer",
    title_zh: "Loop 摘要",
    title_en: "Loop summarizer",
    kind: "file",
    injected: true,
    inject_zh: "Regular 没解出、生成 generated_brief.md 时作为摘要 Pi 的 system。模型和密钥与观察者相同（设置页 Pi Agent）。Loop 再把这份 brief 包进 <heimdall-brief>。",
    inject_en: "System for the summarizer Pi that writes generated_brief.md after a regular miss. Same model and key as the observer (Settings → Pi Agent). The Loop job wraps that brief in <heimdall-brief>.",
  },
];

const BY_ID = new Map(CATALOG.map((s) => [s.id, s]));

const SLOTS: Record<string, [string, string, string][]> = {
  "solver-user": [
    ["task_lines", "本题字段列表（题号、地址、flag 进度等）", "Task field list (code, addrs, flag progress)"],
    ["advisor", "顾问路径 brief", "Advisor brief"],
    ["loop_rotated", "Loop 且实例已轮换时显示本段", "Shown on a loop job after instance rotation"],
    ["loop_direct", "跳过常规 Pi 的首次 loop 时显示本段", "Shown on a skip-Pi first loop"],
    ["loop_from_loop", "上一轮也是 loop 时显示本段", "Shown when the previous job was also a loop"],
    ["loop_same", "常规 Pi 超时后的 loop 时显示本段", "Shown on a loop after a regular timeout"],
    ["direct", "直连 URL 任务时显示本段", "Shown on a direct URL engagement"],
    ["hint", "磁盘 hint.txt 正文", "hint.txt body"],
    ["flags_json", "flags.json 摘录", "flags.json excerpt"],
    ["obligation", "观察者 LOCK 建议", "Observer LOCK note"],
    ["map_notice", "题型支持覆盖图时显示本段", "Shown when the type supports a coverage map"],
    ["handoff", "控制面交接 JSON", "Control-plane handoff JSON"],
    ["prior_brief", "上一轮交接摘录", "Prior-attempt excerpt"],
    ["closing_multi", "已知多个 flag 时的收尾", "Closing when flag_count > 1"],
    ["closing_one", "已知 1 个 flag 时的收尾", "Closing when flag_count is 1"],
    ["closing_unknown", "平台未报 flag_count 时的收尾", "Closing when flag_count is unknown"],
    ["flag_count", "flag 总数", "Total flag count"],
    ["scored", "已计分数", "Scored flags"],
    ["remaining", "剩余 flag 数", "Remaining flags"],
  ],
  "solver-loop": [
    ["iteration", "until-flag 轮次", "until-flag iteration"],
    ["advisor", "顾问路径 brief", "Advisor brief"],
    ["remaining_flags", "剩余 flag 一行", "Remaining-flags line"],
    ["map", "当前覆盖图正文", "Current coverage map"],
    ["no_map", "还没有覆盖图时显示本段", "Shown when no map exists yet"],
    ["no_workspace", "没有工作区路径时显示本段", "Shown when no workspace path is passed"],
  ],
};

function overlayDefault(promptId: string, root?: string): string {
  if (promptId === "solver-protocol") return loadProtocolFile(root);
  const names: Record<string, string> = { "solver-user": "user.md", "solver-loop": "loop_followup.md" };
  const name = names[promptId];
  if (!name) return "";
  try {
    return bundledTemplate(name, root);
  } catch {
    return "";
  }
}

function slotItems(promptId: string): Record<string, string>[] {
  return (SLOTS[promptId] || []).map(([name, zh, en]) => ({ name, zh, en }));
}

function spec(promptId: string): Spec | undefined {
  return BY_ID.get((promptId || "").trim());
}

function safeFile(cfg: Config, rel: string): string {
  const root = resolve(cfg.repo_root);
  const path = resolve(join(root, rel));
  if (!relative(root, path) || relative(root, path).startsWith("..")) {
    throw new Error("path escape");
  }
  return path;
}

function fileStat(path: string): { exists: boolean; size: number; mtime: number | null } {
  if (!existsSync(path)) return { exists: false, size: 0, mtime: null };
  try {
    const st = statSync(path);
    return { exists: true, size: st.size, mtime: st.mtimeMs / 1000 };
  } catch {
    return { exists: false, size: 0, mtime: null };
  }
}

function item(cfg: Config, s: Spec): Record<string, unknown> {
  if (s.kind === "overlay") {
    const custom = llmIo.readOverlayPrompt(cfg, s.id);
    const usingDefault = !custom.trim();
    const content = usingDefault ? overlayDefault(s.id, cfg.repo_root) : custom;
    const overlay = llmIo.overlayPromptPath(cfg, s.id);
    const st = fileStat(overlay);
    return {
      id: s.id,
      group: s.group,
      title_zh: s.title_zh,
      title_en: s.title_en,
      kind: s.kind,
      path: relative(cfg.repo_root, overlay),
      injected: s.injected,
      inject_zh: s.inject_zh,
      inject_en: s.inject_en,
      exists: st.exists && !usingDefault,
      using_default: usingDefault,
      resettable: true,
      bytes: Buffer.byteLength(content, "utf8"),
      mtime: st.mtime,
      content,
      slots: slotItems(s.id),
    };
  }
  const path = safeFile(cfg, relative(cfg.repo_root, resourcePath(s.id, cfg.repo_root)));
  const st = fileStat(path);
  let content = "";
  if (st.exists) {
    try {
      content = readFileSync(path, "utf8");
    } catch {
      content = "";
    }
  }
  return {
    id: s.id,
    group: s.group,
    title_zh: s.title_zh,
    title_en: s.title_en,
    kind: s.kind,
    path: relative(cfg.repo_root, path),
    language: /\/(?:_en|en)\//.test(path) ? "en" : "zh",
    injected: s.injected,
    inject_zh: s.inject_zh + " 当前编辑实际加载的版本；新任务 / 下次 Agent 启动生效，恢复任务的手册沿用现有保留规则。",
    inject_en: s.inject_en + " Editing the effective resource. Applies to new jobs / the next agent start; resumed playbooks retain existing preservation rules.",
    exists: st.exists,
    using_default: false,
    resettable: false,
    bytes: st.size,
    mtime: st.mtime,
    content,
    slots: slotItems(s.id),
  };
}

export function listPrompts(cfg: Config): Record<string, unknown>[] {
  return CATALOG.map((s) => item(cfg, s));
}

export function getPrompt(cfg: Config, promptId: string): Record<string, unknown> | null {
  const s = spec(promptId);
  return s ? item(cfg, s) : null;
}

export function writePrompt(cfg: Config, promptId: string, text: string): Record<string, unknown> {
  const s = spec(promptId);
  if (!s) throw new Error("unknown prompt");
  const body = text ?? "";
  if (Buffer.byteLength(body, "utf8") > MAX_BYTES) throw new Error("prompt too large");
  if (s.kind === "overlay") {
    llmIo.writeOverlayPrompt(cfg, s.id, body);
    return item(cfg, s);
  }
  const path = safeFile(cfg, relative(cfg.repo_root, resourcePath(s.id, cfg.repo_root)));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body, "utf8");
  return item(cfg, s);
}

export function resetPrompt(cfg: Config, promptId: string): Record<string, unknown> {
  const s = spec(promptId);
  if (!s) throw new Error("unknown prompt");
  if (s.kind !== "overlay") throw new Error("this prompt has no built-in default");
  llmIo.writeOverlayPrompt(cfg, s.id, "");
  return item(cfg, s);
}

export function defaultProtocol(): string {
  try {
    return loadProtocolFile();
  } catch {
    return "";
  }
}
