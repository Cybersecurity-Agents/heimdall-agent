import { useEffect, useRef, useState } from "react";
import { Button, Form, Input, Radio } from "antd";
import { useDesk } from "../store";
import { api } from "../api";
import { CLOCK_KEYS } from "../lib/workspace";
import { Flash } from "../components/Flash";

export function SettingsPage() {
  const { t, lang, setLang, settings, llm, platform, vpn, flash, setFlash, loadSettings, loadVpn } = useDesk();
  const [clocks, setClocks] = useState<Record<string, string>>({});
  const [solver, setSolver] = useState({ url: "", model: "", key: "", think: "" });
  const [loop, setLoop] = useState({ url: "", model: "", key: "" });
  const [plat, setPlat] = useState({ url: "", token: "" });
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { loadSettings().then(() => loadVpn()); }, [loadSettings, loadVpn]);

  useEffect(() => {
    const next: Record<string, string> = {};
    for (const [key] of CLOCK_KEYS) {
      const val = settings[key];
      next[key] = val === true || val === false ? (val ? "1" : "0") : String(val ?? "");
    }
    setClocks(next);
  }, [settings]);

  useEffect(() => {
    const g = (group: string, key: string) => ((llm[group] as Record<string, { value?: string; preview?: string }>) || {})[key] || {};
    setSolver({
      url: g("solver", "ANTHROPIC_BASE_URL").value || "",
      model: g("solver", "ANTHROPIC_MODEL").value || "",
      key: "",
      think: g("solver", "HEIMDALL_THINKING").value || "",
    });
    setLoop({
      url: g("loop", "HEIMDALL_LOOP_BASE_URL").value || "",
      model: g("loop", "HEIMDALL_LOOP_MODEL").value || "",
      key: "",
    });
  }, [llm]);

  useEffect(() => {
    const p = platform as { base_url?: string; default_base_url?: string };
    setPlat({ url: p.base_url || "", token: "" });
  }, [platform]);

  useEffect(() => {
    const id = window.setInterval(() => { loadVpn(); }, 2000);
    return () => window.clearInterval(id);
  }, [loadVpn]);

  const runtime = String(settings.agent_runtime || "local");
  const capabilities = settings.runtime_capabilities as Record<string, { available: boolean; reason: string }> | undefined;
  const p = platform as { token_preview?: string; default_base_url?: string };
  const solverPeek = ((llm.solver as Record<string, { preview?: string }>) || {}).ANTHROPIC_API_KEY;
  const loopPeek = ((llm.loop as Record<string, { preview?: string }>) || {}).HEIMDALL_LOOP_API_KEY;

  return (
    <section className="page settings-page">
      <Flash id="settings" flash={flash} />

      <section className="sheet" id="locale-sheet">
        <header className="sheet-head">
          <h3>{t("localeTitle")}</h3>
          <p className="sheet-lede">{t("localeLede")}</p>
        </header>
        <Radio.Group value={lang} onChange={(e) => setLang(e.target.value)}>
          <Radio.Button value="zh">中文</Radio.Button>
          <Radio.Button value="en">English</Radio.Button>
        </Radio.Group>
      </section>

      <section className="sheet" id="deploy-sheet">
        <header className="sheet-head">
          <h3>{t("deployTitle")}</h3>
          <p className="sheet-lede">{t("deployLede")}</p>
        </header>
        <div className="deploy-grid" role="radiogroup">
          {(["local", "docker"] as const).map((rt) => (
            <button
              type="button"
              key={rt}
              className="runtime-opt"
              role="radio"
              aria-checked={runtime === rt}
              disabled={rt === "local" && !capabilities?.local?.available}
              title={capabilities?.[rt]?.reason}
              onClick={async () => {
                const rec = await api<{ ok?: boolean; settings?: Record<string, unknown>; error?: string }>("/api/settings", {
                  method: "POST", body: JSON.stringify({ agent_runtime: rt }),
                });
                if (rec.ok) {
                  const ready = (rec.settings?.runtime_capabilities as typeof capabilities)?.docker?.available;
                  setFlash("settings", t(rt === "docker" && ready === false ? "deployDockerSavedPending" : "deploySaved"), "ok");
                  await loadSettings();
                } else setFlash("settings", rec.error || t("deploySaveFail"), "bad");
              }}
            >
              <span className="runtime-copy">
                <span className="runtime-head">
                  <span className="runtime-title">{rt === "local" ? t("deployLocal") : t("deployDocker")}</span>
                  {rt === (capabilities?.local?.available ? "local" : "docker") ? <span className="runtime-tag">{t("deployDefault")}</span> : null}
                  {runtime === rt ? <span className="runtime-badge">{t("deployCurrent")}</span> : null}
                </span>
                <span className="runtime-desc">{rt === "local" ? t("deployLocalHelp") : t("deployDockerHelp")}</span>
                {capabilities?.[rt]?.available === false && <span className="runtime-desc">{rt === "local" ? t("deployLocalUnavailable") : t("deployDockerUnavailable")}</span>}
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="sheet" id="tsec-sheet">
        <header className="sheet-head sheet-head-row">
          <div>
            <h3>{t("platformTitle")}</h3>
            <p className="sheet-lede">{t("platformLede")}</p>
          </div>
          <Button onClick={async () => {
            const rec = await api<{ ok?: boolean; synced?: number; error?: string }>("/api/sync", { method: "POST", body: "{}" });
            setFlash("settings", rec.ok ? t("bookSynced", { n: rec.synced || 0 }) : (rec.error || t("syncFail")), rec.ok ? "ok" : "bad");
          }}>{t("syncBook")}</Button>
        </header>
        <div className="subsheet">
          <header className="subsheet-head">
            <h4>{t("platformGroup")}</h4>
            <p>{t("platformGroupHelp")}</p>
          </header>
          <Form layout="vertical" onFinish={async () => {
            const payload: Record<string, string> = { base_url: plat.url };
            if (plat.token.trim()) payload.token = plat.token.trim();
            const rec = await api<{ ok?: boolean; error?: string }>("/api/settings", { method: "POST", body: JSON.stringify({ platform: payload }) });
            if (rec.ok) {
              setPlat((s) => ({ ...s, token: "" }));
              setFlash("settings", t("platformSaved"), "ok");
              await loadSettings();
            } else setFlash("settings", rec.error || t("savePlatformFail"), "bad");
          }}>
            <div className="form-grid">
              <div className="field">
                <label>{t("platformUrl")}</label>
                <Input value={plat.url} spellCheck={false} placeholder={p.default_base_url || t("platformUrlPh")} onChange={(e) => setPlat((s) => ({ ...s, url: e.target.value }))} />
              </div>
              <div className="field">
                <label>{t("platformToken")}</label>
                <Input.Password value={plat.token} placeholder={p.token_preview || t("keyUnchanged")} onChange={(e) => setPlat((s) => ({ ...s, token: e.target.value }))} />
                <p className="help">{t("tokenHelp")}</p>
              </div>
            </div>
            <div className="sheet-foot tsec-foot" style={{ marginTop: 16 }}>
              <input ref={fileRef} className="sr" type="file" accept=".ovpn,.conf,text/plain" onChange={async (e) => {
                const file = e.target.files && e.target.files[0];
                if (!file) return;
                const content = await file.text();
                e.target.value = "";
                const rec = await api<{ ok?: boolean; error?: string }>("/api/vpn", { method: "POST", body: JSON.stringify({ content, connect: true }) });
                if (!rec.ok) { setFlash("settings", rec.error || t("vpnFail"), "bad"); return; }
                setFlash("settings", "");
                await loadVpn();
              }} />
              <Button disabled={!!vpn?.connecting || vpn?.enabled === false || vpn?.available === false} onClick={() => fileRef.current?.click()}>{t("vpnPick")}</Button>
              <Button type="primary" disabled={!!vpn?.connecting || vpn?.enabled === false || vpn?.available === false} onClick={async () => {
                const rec = await api<{ ok?: boolean; error?: string }>("/api/vpn", { method: "POST", body: JSON.stringify({ connect: true }) });
                if (!rec.ok) { setFlash("settings", rec.error || t("vpnNeedFile"), "bad"); return; }
                setFlash("settings", "");
                await loadVpn();
              }}>{vpn?.running ? t("vpnReconnect") : t("vpnConnect")}</Button>
              <Button disabled={!vpn?.running && !vpn?.connecting} onClick={async () => {
                const rec = await api<{ ok?: boolean; error?: string }>("/api/vpn", { method: "POST", body: JSON.stringify({ action: "disconnect" }) });
                if (!rec.ok) { setFlash("settings", rec.error || t("vpnFail"), "bad"); return; }
                setFlash("settings", "");
                await loadVpn();
              }}>{t("vpnDisconnect")}</Button>
              <Button type="primary" htmlType="submit">{t("savePlatform")}</Button>
            </div>
          </Form>
        </div>
        <div className="subsheet">
          <header className="subsheet-head">
            <h4>{t("vpnTitle")}</h4>
            <p>{t("vpnLede")}</p>
          </header>
          <p className="help">{vpn?.ovpn_set ? t("vpnSaved", { name: String(vpn.ovpn_name || "client.ovpn"), remote: vpn.remote ? " · " + String(vpn.remote) : "" }) : t("vpnNone")}</p>
          <p className="help" role="status">{vpn?.error ? String(vpn.error) : vpn?.ready ? t("vpnReady") : vpn?.connecting ? t("vpnConnecting") : vpn?.capability_error ? String(vpn.capability_error) : t("vpnDown")}</p>
        </div>
      </section>

      <form className="sheet" id="llm-form" onSubmit={async (e) => {
        e.preventDefault();
        const payload: Record<string, string> = {
          ANTHROPIC_BASE_URL: solver.url,
          ANTHROPIC_MODEL: solver.model,
          HEIMDALL_THINKING: solver.think,
          HEIMDALL_LOOP_BASE_URL: loop.url,
          HEIMDALL_LOOP_MODEL: loop.model,
        };
        if (solver.key.trim()) payload.ANTHROPIC_API_KEY = solver.key.trim();
        if (loop.key.trim()) payload.HEIMDALL_LOOP_API_KEY = loop.key.trim();
        const rec = await api<{ ok?: boolean; error?: string }>("/api/settings", { method: "POST", body: JSON.stringify({ llm: payload }) });
        if (rec.ok) {
          setSolver((s) => ({ ...s, key: "" }));
          setLoop((s) => ({ ...s, key: "" }));
          setFlash("settings", t("modelsSaved"), "ok");
          await loadSettings();
        } else setFlash("settings", rec.error || t("saveModelsFail"), "bad");
      }}>
        <header className="sheet-head">
          <h3>{t("llmTitle")}</h3>
          <p className="sheet-lede">{t("llmLede")}</p>
        </header>
        <aside className="note" role="note">
          <p><strong>{t("keyDiffTitle")}</strong></p>
          <p>{t("keyDiffBody")}</p>
        </aside>
        <div className="subsheet">
          <header className="subsheet-head">
            <h4>{t("solverGroup")}</h4>
            <p>{t("solverGroupHelp")}</p>
          </header>
          <div className="form-grid">
            <div className="field"><label>{t("solverUrl")}</label><Input spellCheck={false} value={solver.url} onChange={(e) => setSolver((s) => ({ ...s, url: e.target.value }))} /></div>
            <div className="field"><label>{t("solverModel")}</label><Input spellCheck={false} value={solver.model} onChange={(e) => setSolver((s) => ({ ...s, model: e.target.value }))} /></div>
            <div className="field span-2">
              <label>{t("solverKey")}</label>
              <Input.Password value={solver.key} placeholder={solverPeek?.preview || t("keyUnchanged")} onChange={(e) => setSolver((s) => ({ ...s, key: e.target.value }))} />
              <p className="help">{t("solverKeyHelp")}</p>
            </div>
            <div className="field">
              <label>{t("thinking")}</label>
              <Input placeholder="high" spellCheck={false} value={solver.think} onChange={(e) => setSolver((s) => ({ ...s, think: e.target.value }))} />
              <p className="help">{t("thinkingHelp")}</p>
            </div>
          </div>
        </div>
        <div className="subsheet">
          <header className="subsheet-head">
            <h4>{t("loopGroup")}</h4>
            <p>{t("loopGroupHelp")}</p>
          </header>
          <div className="form-grid">
            <div className="field"><label>{t("loopUrl")}</label><Input spellCheck={false} value={loop.url} onChange={(e) => setLoop((s) => ({ ...s, url: e.target.value }))} /></div>
            <div className="field"><label>{t("loopModel")}</label><Input spellCheck={false} value={loop.model} onChange={(e) => setLoop((s) => ({ ...s, model: e.target.value }))} /></div>
            <div className="field span-2">
              <label>{t("loopKey")}</label>
              <Input.Password value={loop.key} placeholder={loopPeek?.preview || t("loopKeyPh")} onChange={(e) => setLoop((s) => ({ ...s, key: e.target.value }))} />
              <p className="help">{t("loopKeyHelp")}</p>
            </div>
          </div>
        </div>
        <div className="sheet-foot">
          <Button type="primary" htmlType="submit">{t("saveModels")}</Button>
        </div>
      </form>

      <form className="sheet" id="clock-form" onSubmit={async (e) => {
        e.preventDefault();
        const payload: Record<string, number> = {};
        for (const [k, v] of Object.entries(clocks)) {
          const raw = v.trim();
          payload[k] = raw.includes(".") ? Number(raw) : parseInt(raw, 10);
        }
        const rec = await api<{ ok?: boolean; settings?: Record<string, unknown>; error?: string }>("/api/settings", {
          method: "POST", body: JSON.stringify(payload),
        });
        if (rec.ok) {
          setFlash("settings", t("clocksSaved"), "ok");
          await loadSettings();
        } else setFlash("settings", rec.error || t("saveClocksFail"), "bad");
      }}>
        <header className="sheet-head">
          <h3>{t("clocks")}</h3>
          <p className="sheet-lede">{t("clocksLede")}</p>
        </header>
        <div className="form-grid" id="clock-grid">
          {CLOCK_KEYS.map(([key, unit]) => (
            <div className="field" key={key}>
              <label>{t("clk_" + key)}</label>
              <div className="input-affix">
                <Input inputMode="decimal" value={clocks[key] || ""} onChange={(e) => setClocks((s) => ({ ...s, [key]: e.target.value }))} />
                {unit ? <span className="affix">{unit === "s" ? t("unitS") : t("unitInf")}</span> : null}
              </div>
            </div>
          ))}
        </div>
        <div className="sheet-foot">
          <Button type="primary" htmlType="submit">{t("saveClocks")}</Button>
        </div>
      </form>
    </section>
  );
}
