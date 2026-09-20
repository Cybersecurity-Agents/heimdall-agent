import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Input, Select, Space, Tooltip } from "antd";
import { ExpandOutlined, ZoomInOutlined, ZoomOutOutlined } from "@ant-design/icons";
import { useDesk } from "../store";
import { api } from "../api";
import { NodeInspector } from "../components/NodeInspector";
import { Flash } from "../components/Flash";
import { ObserverGraph, type ObserverGraphHandle } from "../components/ObserverGraph";

const GRAPH_H_KEY = "heimdall-graph-h-v3";
const GRAPH_H_MIN = 280;
const GRAPH_H_MAX = 1200;

export function DeskPage() {
  const {
    t, workspaces, flash, setFlash, currentTask, currentProject, deskWsValue,
    selectTask, loadDesk, graph, graphWarming, graphRecap, nodeId, setNodeId, flags, progress, challenges,
  } = useDesk();
  const nav = useNavigate();
  const task = currentTask();
  const [flag, setFlag] = useState("");
  const [ws, setWs] = useState("all");
  const [busy, setBusy] = useState(false);
  const graphRef = useRef<ObserverGraphHandle>(null);
  const logRef = useRef<HTMLOListElement>(null);
  const logPin = useRef(true);
  const [scale, setScale] = useState(1);
  const [graphH, setGraphH] = useState(() => {
    const saved = Number(localStorage.getItem(GRAPH_H_KEY));
    if (saved >= GRAPH_H_MIN && saved <= GRAPH_H_MAX) return saved;
    return GRAPH_H_MIN;
  });

  useEffect(() => { loadDesk(); }, [loadDesk]);
  useEffect(() => { setWs(deskWsValue(task)); }, [task, deskWsValue]);

  const node = useMemo(() => {
    const nodes = (graph && graph.view && graph.view.nodes) || [];
    return nodes.find((n) => n.id === nodeId) || null;
  }, [graph, nodeId]);

  const it = challenges.find((x) => x.unique_code === (task && task.code)) as Record<string, unknown> | undefined;
  const goal = progress?.goal as { state: string; reason: string; verdict: { count: number; requiredCount: number | null; assurance: string } } | null;
  const running = progress && (["running", "starting", "stopping"].includes(String(progress.status)) || ["retry_wait", "waiting_verification", "queued"].includes(goal?.state || ""));
  const lines = ((progress && progress.lines) || []) as string[];
  const logKey = lines.join("\n");
  const wsOpts = (workspaces.length ? workspaces : [{ id: "all" }]).map((w) => ({ value: w.id, label: w.id }));

  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const onScroll = () => {
      logPin.current = el.scrollHeight - el.scrollTop - el.clientHeight < 36;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    const el = logRef.current;
    if (el && logPin.current) el.scrollTop = el.scrollHeight;
  }, [logKey]);

  async function startJob() {
    if (!task) { setFlash("desk", t("pickTaskFirst"), "bad"); return; }
    const code = (task.code || "").trim();
    const url = (task.url || "").trim();
    if (!code && !url) { setFlash("desk", t("needTarget"), "bad"); return; }
    setBusy(true);
    const rec = await api<{ ok?: boolean; code?: string; error?: string }>("/api/run", {
      method: "POST",
      body: JSON.stringify({
        code, url, close_after: !url, workspace: ws, project_id: task.project_id || currentProject()?.id || "",
      }),
    });
    setBusy(false);
    if (rec.ok) {
      setFlash("desk", t("startedHint", { code: rec.code || code }), "ok");
      await loadDesk();
    } else setFlash("desk", rec.error || t("startFail"), "bad");
  }

  async function stopJob() {
    const code = ((task && task.code) || "").trim();
    if (!code) { setFlash("desk", t("pickTaskFirst"), "bad"); return; }
    setBusy(true);
    const rec = await api<{ ok?: boolean; code?: string; error?: string; pending?: boolean }>("/api/stop", {
      method: "POST", body: JSON.stringify({ code, project_id: task?.project_id || currentProject()?.id || null }),
    });
    setBusy(false);
    if (rec.ok) {
      setFlash("desk", t(rec.pending ? "stoppingTask" : "stopped", { code: rec.code || code }), "ok");
      await loadDesk();
    } else setFlash("desk", rec.error || t("stopFail"), "bad");
  }

  async function submitFlag() {
    const code = ((task && task.code) || "").trim();
    if (!task) { setFlash("desk", t("pickTaskFirst"), "bad"); return; }
    if (!code || !flag.trim()) { setFlash("desk", t("needCodeFlag"), "bad"); return; }
    setBusy(true);
    const rec = await api<{ ok?: boolean; correct?: boolean | null; recorded?: boolean; duplicate?: boolean; error?: string }>("/api/flags", {
      method: "POST", body: JSON.stringify({ code, flag: flag.trim(), project_id: task.project_id || currentProject()?.id || "" }),
    });
    setBusy(false);
    if (rec.ok && rec.recorded) { setFlash("desk", t("flagRecorded"), "ok"); setFlag(""); }
    else if (rec.ok && rec.correct) { setFlash("desk", t("flagOk"), "ok"); setFlag(""); }
    else if (rec.ok && rec.duplicate) setFlash("desk", t("flagDup"), "ok");
    else setFlash("desk", rec.error || t("flagFail"), "bad");
    await loadDesk();
  }

  function startResize(ev: React.PointerEvent<HTMLDivElement>) {
    ev.preventDefault();
    const startY = ev.clientY;
    const startH = graphH;
    const handle = ev.currentTarget;
    handle.setPointerCapture(ev.pointerId);
    const onMove = (e: PointerEvent) => {
      const next = Math.min(GRAPH_H_MAX, Math.max(GRAPH_H_MIN, startH + (e.clientY - startY)));
      setGraphH(next);
    };
    const onUp = (e: PointerEvent) => {
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      setGraphH((h) => {
        localStorage.setItem(GRAPH_H_KEY, String(h));
        return h;
      });
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  }

  return (
    <section className="page desk-page">
      <div className="page-head">
        <div>
          <p className="kicker">{task ? (task.kind === "url" ? t("kindDirect") : t("kindTsec")) : t("engagement")}</p>
          <h2 tabIndex={-1}>{task ? task.name : t("noPosition")}</h2>
          <p className="lede">{task ? (task.kind === "url" ? t("targetOf", { url: task.url || "" }) : t("codeOf", { code: task.code || "" })) : t("deskLede")}</p>
        </div>
        <div className="folio-stats">
          {task && it ? (
            <>
              <div className="stat"><span>{t("statFlags")}</span><b>{String(it.correct_flag_count || 0)}/{String(it.flag_count || 0)}</b></div>
              <div className="stat"><span>{t("statScore")}</span><b>{String(it.total_score ?? "—")}</b></div>
              <div className="stat"><span>{t("statJob")}</span><b>{String((it.latest_job as { status?: string } | undefined)?.status || t("idle"))}</b></div>
            </>
          ) : null}
        </div>
      </div>
      <form className="start-row" onSubmit={(e) => { e.preventDefault(); startJob(); }}>
        <div className="start-field">
          <label htmlFor="desk-workspace">{t("workspace")}</label>
          <Select
            id="desk-workspace"
            disabled={!task}
            value={ws}
            options={wsOpts}
            onChange={async (next) => {
              setWs(next);
              if (!task) return;
              const rec = await api<{ ok?: boolean; task?: typeof task; error?: string }>("/api/tasks/" + task.id, {
                method: "POST", body: JSON.stringify({ workspace: next }),
              });
              if (rec.ok && rec.task) {
                selectTask(rec.task.id);
                setFlash("desk", t("workspaceSaved"), "ok");
              } else setFlash("desk", rec.error || t("workspaceSaveFail"), "bad");
            }}
          />
        </div>
        <div className="start-field">
          <label htmlFor="desk-flag">{t("submitFlag")}</label>
          <Input id="desk-flag" value={flag} onChange={(e) => setFlag(e.target.value)} placeholder="flag{…}" spellCheck={false} />
        </div>
        <div className="start-actions">
          <Button type="primary" htmlType="submit" disabled={!task || busy}>{t("start")}</Button>
          <Button danger disabled={!running || busy} onClick={stopJob}>{t("stop")}</Button>
          <Button disabled={!task || busy} onClick={submitFlag}>{t("bookFlag")}</Button>
          <Button onClick={() => nav(task?.code ? "/sessions/" + encodeURIComponent(task.code) : "/sessions")}>{t("openSessions")}</Button>
        </div>
      </form>
      <Flash id="desk" flash={flash} />
      <div className="desk-board">
        <section className="block live-block">
          <div className="canvas-head">
            <h3>{t("liveTitle")}</h3>
            <span className="meta">
              {progress && progress.job
                ? (running
                  ? t("liveRunning", { elapsed: String(progress.elapsed_sec ?? "—"), turns: String(progress.turns ?? "—"), tools: String(progress.tools ?? "—") })
                  : t("liveDone", { status: String(progress.status), elapsed: String(progress.elapsed_sec ?? "—"), turns: String(progress.turns ?? "—"), tools: String(progress.tools ?? "—") }))
                : ""}
            </span>
          </div>
          {goal && <p className="meta">{t("goalStatus")}: {goal.state} · {goal.verdict.count}/{goal.verdict.requiredCount ?? "?"} · {goal.verdict.assurance === "recorded" ? t("goalRecorded") : goal.verdict.assurance}<br />{goal.reason}</p>}
          <ol className="live-log" ref={logRef} data-empty={t("liveIdle")}>
            {lines.map((line, i) => <li key={i} title={line}>{line}</li>)}
          </ol>
        </section>
        <section className="block flags-block">
          <h3>{t("flags")}</h3>
          <div className={"flag-list" + (flags.length ? "" : " empty")}>
            {!flags.length ? t("noFlags") : flags.map((f, i) => {
              const local = f.source === "direct";
              const ok = f.submit_correct === 1 || f.submit_correct === true;
              const val = String(f.flag_value || "");
              const many = flags.length > 1;
              return (
                <div className={"flag-row" + (ok ? " is-ok" : local ? "" : " is-bad") + (many ? " has-n" : "")} key={String(f.id || val) + ":" + i}>
                  {many ? <span className="flag-n">{i + 1}</span> : null}
                  <span className={"tag " + (ok ? "ok" : local ? "" : "bad")}>{local ? t("flagLocal") : ok ? t("cleared") : t("held")}</span>
                  <span className="flag-val">{val}</span>
                </div>
              );
            })}
          </div>
        </section>
        <section className="block canvas hero">
          <div className="canvas-head">
            <h3>{t("observer")}</h3>
            <Space size={8}>
              <span className="meta">{graph?.view?.nodes?.length ? t("nodes", { n: graph.view.nodes.length }) : ""}</span>
              <span className="meta">{Math.round(scale * 100)}%</span>
              <Tooltip title="缩小">
                <Button size="small" icon={<ZoomOutOutlined />} onClick={() => graphRef.current?.zoomBy(1 / 1.2)} />
              </Tooltip>
              <Tooltip title="放大">
                <Button size="small" icon={<ZoomInOutlined />} onClick={() => graphRef.current?.zoomBy(1.2)} />
              </Tooltip>
              <Tooltip title="看全图">
                <Button size="small" icon={<ExpandOutlined />} onClick={() => graphRef.current?.resetView()} />
              </Tooltip>
            </Space>
          </div>
          {graphRecap ? <p className="meta" role="status" title={graphRecap.error}>
            {graphRecap.status === "failed" ? t("recapFailed") :
              graphRecap.status === "disabled" ? t("recapDisabled") :
              graphRecap.status === "published" ? t(graphRecap.terminal ? "recapFinal" : "recapUpdated") :
              t(graphRecap.reason === "timeout" ? "recapTimeout" : graphRecap.reason === "flag_accepted" ? "recapAccepted" : "recapRunning")}
          </p> : null}
          <div className="canvas-body" style={graphH > GRAPH_H_MIN ? { minHeight: graphH } : undefined}>
            <ObserverGraph
              ref={graphRef}
              graph={graph}
              empty={graph ? t("noMap") : t("waitMap")}
              warming={graphWarming && !graph}
              selected={nodeId}
              ariaLabel={t("observer")}
              onSelect={setNodeId}
              onScale={setScale}
            />
            <aside className="panel">
              <NodeInspector key={`${task?.project_id || ""}:${task?.id || ""}`} node={node} graph={graph}
                code={task?.code || ""} projectId={task?.project_id || currentProject()?.id || ""} t={t} />
            </aside>
          </div>
          <div
            className="canvas-resize"
            role="separator"
            aria-orientation="horizontal"
            aria-label="拖动右下角调整图框大小"
            onPointerDown={startResize}
          />
        </section>
      </div>

    </section>
  );
}
