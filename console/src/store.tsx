import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { I18N, translate, type Lang } from "./i18n";
import { api, withProject } from "./api";
import { emptyTok } from "./lib/format";
import { resolveWorkspace } from "./lib/workspace";
import type { ObserverRecap, GraphPayload, Project, PromptItem, Task, Tokens, WorkspaceItem } from "./types";

type Flash = { id: string; msg: string; kind?: string } | null;

type DeskState = {
  theme: "light" | "dark";
  lang: Lang;
  t: (key: string, vars?: Record<string, string | number>) => string;
  setTheme: (theme: "light" | "dark") => void;
  setLang: (lang: Lang) => void;
  projects: Project[];
  tasks: Task[];
  projectId: string;
  taskId: string;
  workspaces: WorkspaceItem[];
  status: Record<string, unknown>;
  tokens: Tokens;
  settings: Record<string, unknown>;
  llm: Record<string, unknown>;
  platform: Record<string, unknown>;
  prompts: PromptItem[];
  promptId: string;
  setPromptId: (id: string) => void;
  graph: GraphPayload | null;
  graphWarming: boolean;
  graphRecap: ObserverRecap | null;
  nodeId: string | null;
  setNodeId: (id: string | null) => void;
  flags: Record<string, unknown>[];
  progress: Record<string, unknown> | null;
  challenges: Record<string, unknown>[];
  sessionList: Record<string, unknown>[];
  sessionCalls: Record<string, unknown>[];
  sessionCall: Record<string, unknown> | null;
  vpn: Record<string, unknown> | null;
  flash: Flash;
  setFlash: (id: string, msg: string, kind?: string) => void;
  currentProject: () => Project | null;
  currentTask: () => Task | null;
  displayProjectName: (p: Project | null | undefined) => string;
  displayProjectNote: (p: Project | null | undefined) => string;
  deskWsValue: (task: Task | null) => string;
  selectProject: (id: string) => Promise<void>;
  selectTask: (id: string) => void;
  loadWorkspace: () => Promise<void>;
  loadStatus: () => Promise<void>;
  loadTokens: () => Promise<void>;
  loadSettings: () => Promise<void>;
  loadPrompts: () => Promise<void>;
  loadDesk: () => Promise<void>;
  loadSessions: (code?: string, callId?: string) => Promise<void>;
  loadVpn: () => Promise<void>;
};

const Ctx = createContext<DeskState | null>(null);

function readTheme(): "light" | "dark" {
  const v = localStorage.getItem("heimdall-theme");
  return v === "light" ? "light" : "dark";
}

function readLang(): Lang {
  const v = localStorage.getItem("heimdall-lang");
  return v === "en" ? "en" : "zh";
}

export function DeskProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<"light" | "dark">(readTheme);
  const [lang, setLangState] = useState<Lang>(readLang);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projectId, setProjectId] = useState(localStorage.getItem("heimdall-project") || "");
  const [taskId, setTaskId] = useState(localStorage.getItem("heimdall-task") || "");
  const [workspaces, setWorkspaces] = useState<WorkspaceItem[]>([]);
  const [status, setStatus] = useState<Record<string, unknown>>({});
  const [tokens, setTokens] = useState<Tokens>({ total: emptyTok(), projects: [], unassigned: [], challenges: [] });
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [llm, setLlm] = useState<Record<string, unknown>>({});
  const [platform, setPlatform] = useState<Record<string, unknown>>({});
  const [prompts, setPrompts] = useState<PromptItem[]>([]);
  const [promptId, setPromptId] = useState("");
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const deskGeneration = useRef(0);
  const deskScope = useRef("");
  deskScope.current = `${projectId}:${taskId}`;
  const [graph, setGraph] = useState<GraphPayload | null>(null);
  const [graphWarming, setGraphWarming] = useState(true);
  const [graphRecap, setGraphRecap] = useState<ObserverRecap | null>(null);
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [flags, setFlags] = useState<Record<string, unknown>[]>([]);
  const [progress, setProgress] = useState<Record<string, unknown> | null>(null);
  const [challenges, setChallenges] = useState<Record<string, unknown>[]>([]);
  const [sessionList, setSessionList] = useState<Record<string, unknown>[]>([]);
  const [sessionCalls, setSessionCalls] = useState<Record<string, unknown>[]>([]);
  const [sessionCall, setSessionCall] = useState<Record<string, unknown> | null>(null);
  const [vpn, setVpn] = useState<Record<string, unknown> | null>(null);
  const [flash, setFlashState] = useState<Flash>(null);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => translate(I18N[lang], key, vars),
    [lang]
  );

  const setTheme = useCallback((next: "light" | "dark") => {
    setThemeState(next);
    localStorage.setItem("heimdall-theme", next);
    document.documentElement.setAttribute("data-theme", next);
    document.documentElement.style.colorScheme = next;
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute("content", next);
  }, []);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    localStorage.setItem("heimdall-lang", next);
    document.documentElement.lang = next === "en" ? "en" : "zh-CN";
  }, []);

  useEffect(() => {
    setTheme(theme);
    document.documentElement.lang = lang === "en" ? "en" : "zh-CN";
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const currentProject = useCallback(
    () => projects.find((p) => p.id === projectId) || projects[0] || null,
    [projects, projectId]
  );
  const currentTask = useCallback(
    () => tasks.find((x) => x.id === taskId) || null,
    [tasks, taskId]
  );

  const displayProjectName = useCallback(
    (p: Project | null | undefined) => {
      if (p && p.name === "Ledger" && p.note === "Default book") return t("defaultProject");
      return p ? p.name : t("noProject");
    },
    [t]
  );
  const displayProjectNote = useCallback(
    (p: Project | null | undefined) => {
      if (p && p.note === "Default book") return t("defaultNote");
      return (p && p.note) || t("noNote");
    },
    [t]
  );

  const deskWsValue = useCallback(
    (task: Task | null) => {
      if (!task) return "all";
      if (task.workspace === "auto") {
        const proj = currentProject();
        return resolveWorkspace(proj && proj.workspace_strategy, task.code || "");
      }
      return task.workspace || "all";
    },
    [currentProject]
  );

  const setFlash = useCallback((id: string, msg: string, kind?: string) => {
    setFlashState({ id, msg, kind });
  }, []);

  const loadTokens = useCallback(async () => {
    try {
      const rec = await api<Tokens>("/api/tokens");
      setTokens(rec || { total: emptyTok() });
    } catch {
      /* keep last */
    }
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const rec = await api<Record<string, unknown>>("/api/status");
      setStatus(rec || {});
    } catch {
      /* keep last */
    }
  }, []);

  const loadWorkspace = useCallback(async () => {
    const rec = await api<{ items?: Project[]; error?: string }>("/api/projects");
    if (!Array.isArray(rec.items)) {
      setFlash("work", rec.error || "Cannot load project data", "bad");
      return;
    }
    const items = rec.items;
    setProjects(items);
    let pid = projectId;
    if (!pid || !items.some((p) => p.id === pid)) pid = (items[0] && items[0].id) || "";
    if (pid !== projectId) setProjectId(pid);
    if (pid) {
      const listed = await api<{ items?: Task[] }>("/api/projects/" + pid + "/tasks");
      if (Array.isArray(listed.items)) setTasks(listed.items);
    } else {
      setTasks([]);
    }
    try {
      const book = await api<{ items?: WorkspaceItem[] }>("/api/workspaces");
      setWorkspaces(book.items || []);
    } catch {
      /* keep */
    }
    await loadTokens();
  }, [projectId, loadTokens, setFlash]);

  const selectProject = useCallback(async (id: string) => {
    if (!id) return;
    deskGeneration.current++;
    setGraph(null); setNodeId(null); setProgress(null); setGraphRecap(null);
    setProjectId(id);
    localStorage.setItem("heimdall-project", id);
    const listed = await api<{ items?: Task[] }>("/api/projects/" + id + "/tasks");
    setTasks(listed.items || []);
    const rec = await api<{ items?: Project[] }>("/api/projects");
    setProjects(rec.items || []);
    await loadTokens();
  }, [loadTokens]);

  const selectTask = useCallback((id: string) => {
    deskGeneration.current++;
    setGraph(null); setNodeId(null); setProgress(null); setGraphRecap(null);
    setTaskId(id);
    localStorage.setItem("heimdall-task", id);
  }, []);

  const loadSettings = useCallback(async () => {
    const rec = await api<{
      settings?: Record<string, unknown>;
      llm?: Record<string, unknown>;
      platform?: Record<string, unknown>;
    }>("/api/settings");
    setSettings(rec.settings || {});
    setLlm(rec.llm || {});
    setPlatform(rec.platform || {});
  }, []);

  const loadPrompts = useCallback(async () => {
    const rec = await api<{ items?: PromptItem[] }>("/api/prompts");
    const items = rec.items || [];
    setPrompts(items);
    setPromptId((cur) => (cur && items.some((p) => p.id === cur) ? cur : (items[0] && items[0].id) || ""));
  }, []);

  const loadDesk = useCallback(async () => {
    const generation = ++deskGeneration.current;
    const scope = `${projectId}:${taskId}`;
    const current = () => generation === deskGeneration.current && scope === deskScope.current;
    const [st, ch] = await Promise.all([
      api<Record<string, unknown>>("/api/status"),
      api<{ items?: Record<string, unknown>[] }>("/api/challenges"),
    ]);
    if (!current()) return;
    setStatus(st || {});
    setChallenges(ch.items || []);
    let taskList = tasksRef.current;
    const pid = projectId || localStorage.getItem("heimdall-project") || "";
    if (pid) {
      const listed = await api<{ items?: Task[] }>("/api/projects/" + pid + "/tasks");
      if (!current()) return;
      taskList = listed.items || [];
      setTasks(taskList);
    }
    const tid = taskId || localStorage.getItem("heimdall-task") || "";
    const task = taskList.find((x) => x.id === tid) || null;
    const code = (task && task.code) || "";
    if (!code) {
      setProgress(null);
      setGraphRecap(null);
      setGraph(null);
      setGraphWarming(true);
      setFlags([]);
      return;
    }
    const [prog, g, fl] = await Promise.all([
      api<Record<string, unknown>>(withProject("/api/progress/" + encodeURIComponent(code), pid)),
      api<{ warming_up?: boolean; graph?: GraphPayload; updated?: string; recap?: ObserverRecap }>(
        withProject("/api/graph/" + encodeURIComponent(code), pid)
      ),
      api<{ items?: Record<string, unknown>[] }>(withProject("/api/flags?code=" + encodeURIComponent(code), pid)),
    ]);
    if (!current()) return;
    setProgress(prog);
    setGraphRecap(g.recap || null);
    if (g.warming_up) {
      setGraph(null);
      setGraphWarming(true);
    } else if (!g.graph) {
      setGraph(null);
      setGraphWarming(false);
    } else {
      setGraph(g.graph);
      setGraphWarming(false);
    }
    setFlags(fl.items || []);
  }, [projectId, taskId]);

  const loadSessions = useCallback(async (code?: string, callId?: string) => {
    const pid = projectId;
    const board = await api<{ items?: Record<string, unknown>[] }>(withProject("/api/sessions", pid));
    setSessionList(board.items || []);
    if (!code) {
      setSessionCalls([]);
      setSessionCall(null);
      return;
    }
    const listed = await api<{ items?: Record<string, unknown>[] }>(
      withProject("/api/sessions/" + encodeURIComponent(code), pid)
    );
    setSessionCalls(listed.items || []);
    if (!callId) {
      setSessionCall(null);
      return;
    }
    const rec = await api<Record<string, unknown>>(
      withProject("/api/sessions/" + encodeURIComponent(code) + "/" + encodeURIComponent(callId), pid)
    );
    setSessionCall(rec && rec.ok ? rec : null);
  }, [projectId]);

  const loadVpn = useCallback(async () => {
    const rec = await api<Record<string, unknown>>("/api/vpn");
    setVpn(rec);
  }, []);

  const value = useMemo<DeskState>(
    () => ({
      theme,
      lang,
      t,
      setTheme,
      setLang,
      projects,
      tasks,
      projectId,
      taskId,
      workspaces,
      status,
      tokens,
      settings,
      llm,
      platform,
      prompts,
      promptId,
      setPromptId,
      graph,
      graphWarming,
      graphRecap,
      nodeId,
      setNodeId,
      flags,
      progress,
      challenges,
      sessionList,
      sessionCalls,
      sessionCall,
      vpn,
      flash,
      setFlash,
      currentProject,
      currentTask,
      displayProjectName,
      displayProjectNote,
      deskWsValue,
      selectProject,
      selectTask,
      loadWorkspace,
      loadStatus,
      loadTokens,
      loadSettings,
      loadPrompts,
      loadDesk,
      loadSessions,
      loadVpn,
    }),
    [
      theme, lang, t, setTheme, setLang, projects, tasks, projectId, taskId, workspaces, status, tokens,
      settings, llm, platform, prompts, promptId, graph, graphWarming, graphRecap, nodeId, flags, progress, challenges,
      sessionList, sessionCalls, sessionCall, vpn, flash, setFlash, currentProject, currentTask,
      displayProjectName, displayProjectNote, deskWsValue, selectProject, selectTask, loadWorkspace,
      loadStatus, loadTokens, loadSettings, loadPrompts, loadDesk, loadSessions, loadVpn,
    ]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDesk() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useDesk outside provider");
  return ctx;
}
