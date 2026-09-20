import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Form, Input, Modal, Select, Segmented } from "antd";
import { useDesk } from "../store";
import { api } from "../api";
import { emptyTok, fmtTok } from "../lib/format";
import { PROJECT_CLOCK_KEYS, resolveWorkspace } from "../lib/workspace";
import { taskGroups } from "../lib/task-groups";
import { Flash } from "../components/Flash";
import type { Campaign, Task } from "../types";

function campaignOf(camp: Campaign | undefined): Campaign {
  return camp || { status: "idle", queued: 0, running: [], finished: 0, pending: [], done: [], codes: [], total: 0, synced: 0 };
}

export function ProjectsPage() {
  const desk = useDesk();
  const {
    t, projects, tasks, tokens, workspaces, settings, flash, setFlash,
    currentProject, displayProjectName, selectProject, selectTask, loadWorkspace,
  } = desk;
  const nav = useNavigate();
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [projOpen, setProjOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [taskKind, setTaskKind] = useState("url");
  const [projForm] = Form.useForm();
  const [taskForm] = Form.useForm();
  const [clocks, setClocks] = useState<Record<string, string>>({});
  const [clockPid, setClockPid] = useState("");
  const [stratDefault, setStratDefault] = useState("all");
  const [stratPreset, setStratPreset] = useState("");
  const [stratRules, setStratRules] = useState<{ kind: string; value: string; workspace: string }[]>([]);
  const [stratPid, setStratPid] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { loadWorkspace(); }, [loadWorkspace]);

  const proj = currentProject();
  const camp = campaignOf(proj?.campaign);
  const liveRun = camp.status === "running" || camp.status === "stopping";

  useEffect(() => {
    if (!proj) return;
    if (clockPid !== proj.id) {
      const over = proj.settings || {};
      const next: Record<string, string> = {};
      for (const [key] of PROJECT_CLOCK_KEYS) {
        const val = over[key];
        next[key] = val === undefined || val === null || val === "" ? "" : String(val);
      }
      setClocks(next);
      setClockPid(proj.id);
    }
    if (stratPid !== proj.id) {
      const strat = proj.workspace_strategy || { default: "all", rules: [] };
      setStratDefault(strat.default || "all");
      setStratPreset(strat.preset || "");
      setStratRules((strat.rules || []).map((r) => {
        if (r.codes && r.codes.length) return { kind: "codes", value: r.codes.join(", "), workspace: r.workspace || "all" };
        if (r.prefix && r.prefix.length) return { kind: "prefix", value: r.prefix.join(", "), workspace: r.workspace || "all" };
        return { kind: "match", value: r.match || "", workspace: r.workspace || "all" };
      }));
      setStratPid(proj.id);
    }
  }, [proj, clockPid, stratPid]);

  const groups = useMemo(() => taskGroups(tasks, camp), [tasks, camp]);

  const effective = filter || "all";
  const match = (item: Task) => {
    if (!query) return true;
    const needle = [item.name, item.code, item.url, item.workspace].join(" ").toLowerCase();
    return needle.includes(query.toLowerCase());
  };

  function resolvedWs(item: Task) {
    if (item.workspace === "auto") {
      return resolveWorkspace(proj?.workspace_strategy, item.code || "");
    }
    return item.workspace || "all";
  }

  function openDesk(id: string) {
    selectTask(id);
    nav("/desk");
  }

  async function removeTask(id: string) {
    await api("/api/tasks/" + id, { method: "DELETE" });
    await loadWorkspace();
  }

  async function runProject() {
    if (!proj) { setFlash("work", t("createProjectFirst"), "bad"); return; }
    setBusy(true);
    const rec = await api<{ ok?: boolean; empty?: boolean; campaign?: { total?: number }; error?: string }>(
      "/api/projects/" + encodeURIComponent(proj.id) + "/run",
      { method: "POST", body: "{}" }
    );
    setBusy(false);
    if (rec.ok) {
      const n = (rec.campaign && rec.campaign.total) || 0;
      setFlash("work", rec.empty ? t("campaignNone") : t("campaignStarted", { n }), "ok");
      await loadWorkspace();
    } else setFlash("work", rec.error || t("campaignFail"), "bad");
  }

  async function importUnsolved() {
    if (!proj) { setFlash("work", t("createProjectFirst"), "bad"); return; }
    setBusy(true);
    const rec = await api<{ ok?: boolean; created?: number; error?: string }>(
      "/api/projects/" + encodeURIComponent(proj.id) + "/import",
      { method: "POST", body: "{}" }
    );
    setBusy(false);
    if (rec.ok) {
      const n = rec.created || 0;
      setFlash("work", n ? t("importOk", { n }) : t("importNone"), "ok");
      await loadWorkspace();
    } else setFlash("work", rec.error || t("importFail"), "bad");
  }

  async function stopProject() {
    if (!proj) return;
    const rec = await api<{ ok?: boolean; error?: string }>(
      "/api/projects/" + encodeURIComponent(proj.id) + "/stop",
      { method: "POST", body: "{}" }
    );
    setFlash("work", rec.ok ? t("campaignStopped") : (rec.error || t("stopFail")), rec.ok ? "ok" : "bad");
    await loadWorkspace();
  }

  async function deleteProject(id: string, name: string) {
    Modal.confirm({
      title: t("deleteProject"),
      content: t("deleteProjectConfirm", { name: name || id }),
      okText: t("deleteProjectOk"),
      okType: "danger",
      cancelText: t("cancel"),
      centered: true,
      onOk: async () => {
        setBusy(true);
        try {
          const rec = await api<{ ok?: boolean; error?: string }>(
            "/api/projects/" + encodeURIComponent(id),
            { method: "DELETE" }
          );
          if (rec.ok) {
            if (localStorage.getItem("heimdall-project") === id) {
              localStorage.removeItem("heimdall-project");
            }
            setFlash("work", t("deleteProjectDone"), "ok");
            await loadWorkspace();
          } else {
            setFlash("work", rec.error || t("deleteProjectFail"), "bad");
          }
        } finally {
          setBusy(false);
        }
      },
    });
  }

  function taskLabel(item: Task) {
    const status = camp.task_states?.[item.code || ""];
    if (!status) return "";
    if (status.state === "running") return status.job_kind === "loop"
      ? t("taskLoopRunning", { n: status.loop_n || 1 }) : t("taskRegularRunning");
    if (status.state === "retry_wait") return t(status.reason === "timeout" ? "taskTimeoutRetry"
      : status.reason === "failed" ? "taskFailedRetry" : "taskWaitingRetry", {
        next: status.retry_kind === "loop" ? "Loop" : t("taskRetryRun"),
        phase: status.job_kind === "loop" ? t("taskLoopRunning", { n: status.loop_n || 1 }) : t("taskInitialAttempt"),
      });
    if (status.state === "unfinished") return t(status.reason === "cancelled" ? "taskStopped"
      : status.reason === "paused_budget" ? "taskBudgetPaused" : status.reason === "blocked" ? "taskBlocked"
        : status.reason === "attempt_limit" ? "taskAttemptLimit" : status.reason === "timeout" ? "taskTimeout" : "taskUnfinished");
    return "";
  }

  function chip(item: Task, kind: string) {
    const ws = resolvedWs(item);
    const code = item.kind === "url" ? (item.name || item.url || "url") : (item.code || item.name);
    const tok = (tokens.challenges || []).find((c) => c.code === item.code) || emptyTok();
    const extra = tok.total_tokens ? " · " + fmtTok(tok.total_tokens) : "";
    return (
      <span className={`task-chip ${kind}`} key={item.id}>
        <button type="button" className="chip-go" title={`${item.name || code} · ${ws}${extra}`} onClick={() => openDesk(item.id)}>
          <span className="code">{code}</span>
          <span className="ws">{ws}</span>
          {taskLabel(item) ? <span className="task-status">{taskLabel(item)}</span> : null}
        </button>
        <button type="button" className="chip-x" title={t("remove")} aria-label={t("remove")} onClick={() => removeTask(item.id)}>×</button>
      </span>
    );
  }

  function bookGroup(key: string, title: string, items: Task[], cap: number) {
    if (!items.length) return null;
    const isOpen = !!open[key] || !!query || cap <= 0;
    const shown = isOpen ? items : items.slice(0, cap);
    const more = items.length - shown.length;
    const toggle = more > 0 || (isOpen && items.length > cap && cap > 0);
    return (
      <section className="book-group" key={key}>
        <div className="book-head">
          <h4>{title} <span className="n">{items.length}</span></h4>
          {toggle ? (
            <button type="button" className="quiet small" onClick={() => setOpen((s) => ({ ...s, [key]: !isOpen }))}>
              {isOpen ? t("runCollapse") : t("runQueueMore", { n: more })}
            </button>
          ) : null}
        </div>
        <div className="chip-board">{shown.map((item) => chip(item, key))}</div>
      </section>
    );
  }

  const take = (items: Task[]) => items.filter(match);
  const live = take(groups.live);
  const queue = take(groups.queue);
  const done = take(groups.done);
  const retry = take(groups.retry);
  const unfinished = take(groups.unfinished);
  const urls = take(groups.urls);
  const rest = take(groups.rest);
  const restTitle = (liveRun || (camp.total || 0)) ? t("taskFilterRest") : t("taskFilterBook");
  const want = (key: string) => effective === "all" || effective === key;
  const capFor = (key: string) => (query || filter === key ? 0 : 24);

  let line = "";
  if (camp.status === "running") line = t("campaignRunning");
  else if (camp.status === "stopping") line = t("campaignStopping");
  else if (camp.status === "done") line = camp.total ? t("campaignDone") : t("campaignEmpty");
  else if (camp.status === "error") line = t("campaignError", { error: camp.error || "" });
  const finished = camp.finished || 0;
  const total = camp.total || 0;
  const liveN = groups.live.length;
  const showBoard = !!(total || liveN || liveRun || camp.status === "done" || camp.status === "error");
  const pctDone = total ? Math.min(100, (finished / total) * 100) : 0;
  const pctLive = total ? Math.min(100 - pctDone, (liveN / total) * 100) : 0;

  const tabs = [
    { value: "live", label: `${t("taskFilterLive")} ${groups.live.length}`, n: groups.live.length },
    { value: "queue", label: `${t("taskFilterQueue")} ${groups.queue.length}`, n: groups.queue.length },
    { value: "retry", label: `${t("taskFilterRetry")} ${groups.retry.length}`, n: groups.retry.length },
    { value: "done", label: `${t("taskFilterDone")} ${groups.done.length}`, n: groups.done.length },
    { value: "unfinished", label: `${t("taskFilterUnfinished")} ${groups.unfinished.length}`, n: groups.unfinished.length },
    { value: "url", label: `${t("taskFilterUrl")} ${groups.urls.length}`, n: groups.urls.length },
    { value: "rest", label: `${restTitle} ${groups.rest.length}`, n: groups.rest.length },
    { value: "all", label: `${t("taskFilterAll")} ${tasks.length}`, n: tasks.length },
  ].filter((row) => row.value === "all" || row.n > 0);

  const wsOpts = (workspaces.length ? workspaces : [{ id: "all" }]).map((w) => ({ value: w.id, label: w.id }));

  return (
    <section className="page">
      <div className="page-actions">
        <Button onClick={() => setProjOpen(true)}>{t("newProject")}</Button>
        <Button type="primary" onClick={() => {
          if (!proj) { setFlash("work", t("createProjectFirst"), "bad"); return; }
          setTaskKind("url");
          taskForm.resetFields();
          setTaskOpen(true);
        }}>{t("newTask")}</Button>
      </div>
      <Flash id="work" flash={flash} />
      <div className="work-desk">
        <aside className="work-nav" aria-label={t("navProjects")}>
          <p className="kicker">{t("navProjects")}</p>
          <ul className="work-projects">
            {!projects.length ? <li className="empty-hint">{t("noProjects")}</li> : projects.map((p) => {
              const tok = (tokens.projects || []).find((x) => x.id === p.id) || emptyTok();
              const label = displayProjectName(p);
              return (
                <li className="work-row" key={p.id}>
                  <button type="button" className="work-item" aria-current={proj?.id === p.id ? "true" : "false"} onClick={() => { setFilter(""); setQuery(""); setOpen({}); selectProject(p.id); }}>
                    <span className="name">{label}</span>
                    <span className="meta">{t("tokProject", { n: p.task_count || 0, total: fmtTok(tok.total_tokens) })}</span>
                  </button>
                  <button type="button" className="work-del" title={t("deleteProject")} aria-label={t("deleteProject")} disabled={busy} onClick={(e) => { e.stopPropagation(); deleteProject(p.id, label); }}>×</button>
                </li>
              );
            })}
          </ul>
        </aside>
        <div className="work-pane">
          <div className="work-pane-head">
            <div>
              <p className="kicker">{proj ? displayProjectName(proj) : t("navProjects")}</p>
              <h3>{proj ? t("navTasks") : t("selectProject")}</h3>
              {line && !showBoard ? <p className="campaign-meta">{line}</p> : null}
            </div>
            <div className="head-actions">
              <Button disabled={!proj || liveRun || busy} onClick={importUnsolved}>{t("importUnsolved")}</Button>
              <Button type="primary" disabled={!proj || liveRun || busy} onClick={runProject}>{t("runProject")}</Button>
              <Button danger disabled={!proj || !liveRun} onClick={stopProject}>{t("stopProject")}</Button>
              <Button danger disabled={!proj || busy} onClick={() => proj && deleteProject(proj.id, displayProjectName(proj))}>{t("deleteProject")}</Button>
            </div>
          </div>
          {showBoard ? (
            <div className="run-board">
              <div className="run-progress">
                <div>
                  <p className="kicker">{line || t("runAssigned")}</p>
                  <div className="read">{finished}<span>/{total || tasks.length}</span></div>
                </div>
                <div className="run-counts">
                  <span className="live">{t("runAssigned")} {liveN}</span>
                  <span>{t("runQueued")} {camp.queued || groups.queue.length}</span>
                  <span>{t("taskFilterRetry")} {groups.retry.length}</span>
                  <span className="ok">{t("runCleared")} {finished}</span>
                  <span>{t("taskFilterUnfinished")} {groups.unfinished.length}</span>
                </div>
              </div>
              <div className="run-bar" aria-hidden="true">
                <span className="mix-seg done" style={{ width: `${pctDone.toFixed(2)}%` }} />
                <span className="mix-seg live" style={{ width: `${pctLive.toFixed(2)}%` }} />
              </div>
              {groups.live.length ? (
                <div className="slot-grid">
                  {groups.live.map((item) => {
                    const tok = (tokens.challenges || []).find((c) => c.code === item.code) || emptyTok();
                    return (
                      <button type="button" className="slot-card" key={item.id} onClick={() => openDesk(item.id)}>
                        <span className="tag">{taskLabel(item) || t("taskFilterLive")}</span>
                        <span className="code">{item.code || item.name}</span>
                        <span className="meta">{resolvedWs(item)} · {tok.total_tokens ? fmtTok(tok.total_tokens) + " tok" : t("live")}</span>
                      </button>
                    );
                  })}
                </div>
              ) : liveRun ? <p className="run-empty">{t("runIdleSlots")}</p> : null}
            </div>
          ) : null}
          {proj && tasks.length ? (
            <div className="task-toolbar">
              <Segmented size="small" value={effective} onChange={(v) => setFilter(String(v))} options={tabs.map((x) => ({ label: x.label, value: x.value }))} />
              {tasks.length >= 8 ? (
                <Input className="task-find" allowClear placeholder={t("taskFind")} value={query} onChange={(e) => setQuery(e.target.value.trim())} />
              ) : null}
            </div>
          ) : null}
          <div className="task-book">
            {!proj ? <p className="empty-hint">{t("pickProjectFirst")}</p> : !tasks.length ? <p className="empty-hint">{t("noTasks")}</p> : (
              <>
                {want("live") && effective !== "all" ? bookGroup("live", t("taskFilterLive"), live, capFor("live")) : null}
                {want("queue") ? bookGroup("queue", t("taskFilterQueue"), queue, capFor("queue")) : null}
                {want("retry") ? bookGroup("retry", t("taskFilterRetry"), retry, capFor("retry")) : null}
                {want("done") ? bookGroup("done", t("taskFilterDone"), done, capFor("done")) : null}
                {want("unfinished") ? bookGroup("unfinished", t("taskFilterUnfinished"), unfinished, capFor("unfinished")) : null}
                {want("url") ? bookGroup("url", t("taskFilterUrl"), urls, 0) : null}
                {want("rest") ? bookGroup("rest", restTitle, rest, capFor("rest")) : null}
              </>
            )}
          </div>
          {proj ? (
            <form className="sheet project-clocks" onSubmit={async (e) => {
              e.preventDefault();
              const settingsPayload: Record<string, number> = {};
              for (const [k, v] of Object.entries(clocks)) {
                const raw = v.trim();
                if (!raw) continue;
                settingsPayload[k] = raw.includes(".") ? Number(raw) : parseInt(raw, 10);
              }
              const rec = await api<{ ok?: boolean; settings?: Record<string, number>; error?: string }>(
                "/api/projects/" + proj.id + "/settings",
                { method: "POST", body: JSON.stringify({ settings: settingsPayload }) }
              );
              if (rec.ok) {
                setFlash("work", t("projClocksSaved"), "ok");
                await loadWorkspace();
                setClockPid("");
              } else setFlash("work", rec.error || t("saveProjClocksFail"), "bad");
            }}>
              <header className="sheet-head">
                <h3>{t("projClocks")}</h3>
                <p className="sheet-lede">{t("projClocksLede")}</p>
              </header>
              <div className="form-grid">
                {PROJECT_CLOCK_KEYS.map(([key, unit]) => (
                  <div className="field" key={key}>
                    <label htmlFor={"pclk-" + key}>{t("clk_" + key)}</label>
                    <div className="input-affix">
                      <Input id={"pclk-" + key} inputMode="decimal" value={clocks[key] || ""} placeholder={t("inheritPh", { n: String(settings[key] ?? "") })} onChange={(e) => setClocks((s) => ({ ...s, [key]: e.target.value }))} />
                      {unit ? <span className="affix">{unit === "s" ? t("unitS") : t("unitInf")}</span> : null}
                    </div>
                  </div>
                ))}
              </div>
              <div className="sheet-foot">
                <Button type="primary" htmlType="submit">{t("saveProjClocks")}</Button>
              </div>
            </form>
          ) : null}
          {proj ? (
            <form className="sheet project-strategy" onSubmit={async (e) => {
              e.preventDefault();
              const rules = stratRules.map((r) => {
                const rule: { workspace: string; match?: string; codes?: string[]; prefix?: string[] } = { workspace: r.workspace };
                if (!r.value.trim()) return null;
                if (r.kind === "match") rule.match = r.value.trim();
                else rule[r.kind === "prefix" ? "prefix" : "codes"] = r.value.trim().split(/[,\s]+/).filter(Boolean);
                return rule;
              }).filter(Boolean);
              const rec = await api<{ ok?: boolean; workspace_strategy?: unknown; error?: string }>(
                "/api/projects/" + proj.id + "/strategy",
                { method: "POST", body: JSON.stringify({ workspace_strategy: { default: stratDefault, preset: stratPreset || undefined, rules } }) }
              );
              if (rec.ok) {
                setFlash("work", t("projStrategySaved"), "ok");
                await loadWorkspace();
                setStratPid("");
              } else setFlash("work", rec.error || t("projStrategyFail"), "bad");
            }}>
              <header className="sheet-head">
                <h3>{t("projStrategy")}</h3>
                <p className="sheet-lede">{t("projStrategyLede")}</p>
              </header>
              <div className="strategy-default">
                <label>{t("projStrategyPreset")}</label>
                <Select
                  value={stratPreset}
                  options={[
                    { value: "", label: t("stratPresetNone") },
                    ...(proj.solve_presets || []).map((p) => ({
                      value: p.id,
                      label: desk.lang === "en" ? (p.label_en || p.id) : (p.label_zh || p.id),
                    })),
                  ]}
                  onChange={(v) => {
                    setStratPreset(v);
                    if (!v) {
                      setStratDefault("all");
                      setStratRules([]);
                      return;
                    }
                    const hit = (proj.solve_presets || []).find((p) => p.id === v);
                    const s = hit && hit.workspace_strategy;
                    if (!s) return;
                    setStratDefault(s.default || "all");
                    setStratRules((s.rules || []).map((r) => {
                      if (r.codes && r.codes.length) return { kind: "codes", value: r.codes.join(", "), workspace: r.workspace || "all" };
                      if (r.prefix && r.prefix.length) return { kind: "prefix", value: r.prefix.join(", "), workspace: r.workspace || "all" };
                      return { kind: "match", value: r.match || "", workspace: r.workspace || "all" };
                    }));
                  }}
                />
              </div>
              {(() => {
                const hit = (proj.solve_presets || []).find((p) => p.id === stratPreset);
                const hint = hit ? (desk.lang === "en" ? hit.hint_en : hit.hint_zh) : "";
                return hint ? <p className="field-hint">{hint}</p> : null;
              })()}
              <div className="strategy-default">
                <label>{t("projStrategyDefault")}</label>
                <Select value={stratDefault} options={wsOpts} onChange={setStratDefault} />
              </div>
              <ul className="strategy-rules">
                {stratRules.map((r, i) => (
                  <li className="strategy-rule" key={i}>
                    <Select value={r.kind} onChange={(v) => setStratRules((rows) => rows.map((x, j) => j === i ? { ...x, kind: v } : x))} options={["codes", "prefix", "match"].map((k) => ({ value: k, label: t("stratKind_" + k) }))} />
                    <Input value={r.value} placeholder={t("stratValuePh")} onChange={(e) => setStratRules((rows) => rows.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} />
                    <Select value={r.workspace} options={wsOpts} onChange={(v) => setStratRules((rows) => rows.map((x, j) => j === i ? { ...x, workspace: v } : x))} />
                    <Button onClick={() => setStratRules((rows) => rows.filter((_, j) => j !== i))}>{t("stratDel")}</Button>
                  </li>
                ))}
              </ul>
              <div className="sheet-foot">
                <Button onClick={() => setStratRules((rows) => [...rows, { kind: "codes", value: "", workspace: "all" }])}>{t("projStrategyAdd")}</Button>
                <Button type="primary" htmlType="submit">{t("projStrategySave")}</Button>
              </div>
            </form>
          ) : null}
        </div>
      </div>

      <Modal open={projOpen} title={t("newProject")} onCancel={() => setProjOpen(false)} footer={null} destroyOnClose>
        <Form form={projForm} layout="vertical" onFinish={async (vals) => {
          const rec = await api<{ ok?: boolean; project?: { id: string }; error?: string }>("/api/projects", {
            method: "POST", body: JSON.stringify({ name: vals.name, note: vals.note }),
          });
          if (rec.ok && rec.project) {
            setProjOpen(false);
            projForm.resetFields();
            setFlash("work", t("projectOpened"), "ok");
            localStorage.setItem("heimdall-project", rec.project.id);
            await selectProject(rec.project.id);
          } else setFlash("work", rec.error || t("createProjectFail"), "bad");
        }}>
          <Form.Item name="name" label={t("name")} rules={[{ required: true }]}>
            <Input maxLength={80} placeholder={t("projectNamePh")} />
          </Form.Item>
          <Form.Item name="note" label={t("note")}>
            <Input maxLength={400} placeholder={t("optional")} />
          </Form.Item>
          <div className="modal-actions">
            <Button onClick={() => setProjOpen(false)}>{t("cancel")}</Button>
            <Button type="primary" htmlType="submit">{t("create")}</Button>
          </div>
        </Form>
      </Modal>

      <Modal open={taskOpen} title={t("newTask")} onCancel={() => setTaskOpen(false)} footer={null} destroyOnClose>
        <Form form={taskForm} layout="vertical" initialValues={{ kind: "url", workspace: "all" }} onFinish={async (vals) => {
          if (!proj) return;
          const rec = await api<{ ok?: boolean; error?: string }>("/api/projects/" + proj.id + "/tasks", {
            method: "POST",
            body: JSON.stringify({
              name: vals.name,
              kind: taskKind,
              url: vals.url,
              code: vals.code,
              workspace: vals.workspace || (taskKind === "tsec" ? "auto" : "all"),
            }),
          });
          if (rec.ok) {
            setTaskOpen(false);
            taskForm.resetFields();
            setFlash("work", t("taskBooked"), "ok");
            await loadWorkspace();
          } else setFlash("work", rec.error || t("createTaskFail"), "bad");
        }}>
          <Form.Item name="name" label={t("name")}>
            <Input maxLength={120} placeholder={t("taskNamePh")} />
          </Form.Item>
          <Form.Item label={t("kind")}>
            <Select value={taskKind} onChange={(v) => {
              setTaskKind(v);
              taskForm.setFieldValue("workspace", v === "tsec" ? "auto" : "all");
            }} options={[{ value: "url", label: t("kindUrl") }, { value: "tsec", label: t("kindTsec") }]} />
          </Form.Item>
          {taskKind === "url" ? (
            <Form.Item name="url" label={t("targetUrl")}>
              <Input placeholder="https://target" />
            </Form.Item>
          ) : (
            <Form.Item name="code" label={t("tsecCode")}>
              <Input placeholder="a-01" />
            </Form.Item>
          )}
          <Form.Item name="workspace" label={t("workspace")}>
            <Select options={taskKind === "tsec" ? [{ value: "auto", label: t("wsAuto") }, ...wsOpts] : wsOpts} />
          </Form.Item>
          {taskKind === "tsec" ? <p className="field-hint">{t("wsAutoHint")}</p> : null}
          <div className="modal-actions">
            <Button onClick={() => setTaskOpen(false)}>{t("cancel")}</Button>
            <Button type="primary" htmlType="submit">{t("create")}</Button>
          </div>
        </Form>
      </Modal>
    </section>
  );
}
