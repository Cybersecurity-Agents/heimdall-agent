import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { Button, Input } from "antd";
import { useDesk } from "../store";
import { api } from "../api";
import { Flash } from "../components/Flash";
import { Markdown } from "../components/Markdown";
import { promptGroupLabel, promptGroups, promptInject, promptTitle } from "../lib/prompts";

export function PromptDetailPage() {
  const { promptId = "" } = useParams();
  const loc = useLocation();
  const nav = useNavigate();
  const editing = /\/edit\/?$/.test(loc.pathname);
  const { t, lang, prompts, flash, setFlash, loadPrompts } = useDesk();
  const item = prompts.find((p) => p.id === promptId) || null;
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const groups = promptGroups(prompts);

  useEffect(() => { loadPrompts(); }, [loadPrompts]);
  useEffect(() => { setBody(item?.content || ""); }, [item?.id, item?.content]);

  const title = item ? promptTitle(item, lang) : promptId;
  const inject = item ? promptInject(item, lang) : "";
  const preview = item?.content || "";
  const base = "/prompts/" + encodeURIComponent(promptId);
  const dirty = editing && body !== (item?.content || "");

  async function save() {
    if (!item || busy) return;
    setBusy(true);
    try {
      const rec = await api<{ ok?: boolean; error?: string }>("/api/prompts/" + encodeURIComponent(item.id), {
        method: "POST", body: JSON.stringify({ content: body }),
      });
      setFlash("prompts", rec.ok ? t("promptSaved") : (rec.error || t("savePromptFail")), rec.ok ? "ok" : "bad");
      if (rec.ok) await loadPrompts();
    } catch {
      setFlash("prompts", t("savePromptFail"), "bad");
    } finally { setBusy(false); }
  }

  async function reset() {
    if (!item) return;
    const rec = await api<{ ok?: boolean; error?: string }>("/api/prompts/" + encodeURIComponent(item.id) + "/reset", {
      method: "POST", body: "{}",
    });
    setFlash("prompts", rec.ok ? t("promptSaved") : (rec.error || t("savePromptFail")), rec.ok ? "ok" : "bad");
    if (rec.ok) await loadPrompts();
  }

  return (
    <section className="page prompts-page">
      <div className="page-head">
        <div>
          <p className="kicker"><Link to="/prompts">{t("navPrompts")}</Link></p>
          <h2 tabIndex={-1}>{title}</h2>
          <p className="lede">{inject}</p>
        </div>
        <div className="prompt-mode">
          <Button autoInsertSpace={false} type={!editing ? "primary" : "default"} onClick={() => nav(base)}>{t("promptBrowse")}</Button>
          <Button autoInsertSpace={false} type={editing ? "primary" : "default"} onClick={() => nav(base + "/edit")}>{t("promptEdit")}</Button>
        </div>
      </div>
      <Flash id="prompts" flash={flash} />
      <div className="prompt-desk">
        <div className="prompt-mobile-nav">
          <label className="sr" htmlFor="prompt-picker">{t("promptBackList")}</label>
          <select id="prompt-picker" value={promptId} onChange={(e) => nav("/prompts/" + encodeURIComponent(e.target.value) + (editing ? "/edit" : ""))}>
            {groups.map((group) => <optgroup key={group} label={promptGroupLabel(t, group)}>
              {prompts.filter((p) => (p.group || "workspace") === group).map((p) => <option key={p.id} value={p.id}>{promptTitle(p, lang)}</option>)}
            </optgroup>)}
          </select>
        </div>
        <aside className="prompt-nav" aria-label={t("navPrompts")}>
          {groups.map((group) => (
            <div key={group}>
              <p className="prompt-group">{promptGroupLabel(t, group)}</p>
              {prompts.filter((p) => (p.group || "workspace") === group).map((p) => (
                <button
                  type="button"
                  className="prompt-item"
                  key={p.id}
                  aria-current={p.id === promptId ? "true" : "false"}
                  onClick={() => nav("/prompts/" + encodeURIComponent(p.id) + (editing ? "/edit" : ""))}
                >
                  <span className="name">{promptTitle(p, lang)}</span>
                </button>
              ))}
            </div>
          ))}
        </aside>
        {!item && prompts.length ? (
          <div className="prompt-editor">
            <p className="lede">{t("promptMissingId")}</p>
            <Button onClick={() => nav("/prompts")}>{t("promptBackList")}</Button>
          </div>
        ) : (
          <div className="prompt-editor">
            <header className="prompt-editor-head">
              <div className="prompt-editor-title">
                <h3>{item ? promptGroupLabel(t, item.group || "workspace") : title}</h3>
                {item ? <span className={"prompt-flag" + (item.injected ? "" : " off")}>{item.injected ? t("promptInjected") : t("promptIdle")}</span> : null}
              </div>
              {item ? (
                <aside className="note">
                  <details className="prompt-metadata">
                    <summary>{t("promptMetadata")}</summary>
                    <p className="prompt-path">{item.path || ""}</p>
                    <p>{t("promptApplies")}</p>
                    <p>
                    {item.kind === "overlay"
                      ? (item.using_default ? t("promptUsingDefault") : t("promptUsingCustom"))
                      : (!item.exists ? t("promptMissing") : "")}
                    </p>
                  </details>
                  {item.slots && item.slots.length ? (
                    <details className="prompt-slots">
                      <summary className="prompt-slots-label">{t("promptSlots")}</summary>
                      <p className="prompt-slots-help">{t("promptSlotHelp")}</p>
                      <ul>
                        {item.slots.map((slot) => (
                          <li key={slot.name}>
                            <code>{`{{${slot.name}}}`}</code>
                            <span>{lang === "en" ? (slot.en || slot.zh) : (slot.zh || slot.en)}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </aside>
              ) : null}
            </header>
            {editing ? (
              <form onSubmit={(e) => { e.preventDefault(); save(); }}>
                <div className="field">
                  <label className="sr" htmlFor="prompt-body">{t("promptTitle")}</label>
                  <Input.TextArea id="prompt-body" rows={18} spellCheck={false} readOnly={busy} value={body} onChange={(e) => setBody(e.target.value)} />
                </div>
                <div className="sheet-foot">
                  {dirty ? <span className="prompt-dirty">{t("promptDirty")}</span> : null}
                  {item?.resettable ? <Button disabled={busy} onClick={reset}>{t("promptReset")}</Button> : null}
                  <Button type="primary" htmlType="submit" loading={busy} disabled={!item || !dirty}>{t("savePrompt")}</Button>
                </div>
              </form>
            ) : (
              <div className="prompt-browse">
                {item?.content ? <Markdown source={preview} /> : <p className="lede">{t("promptMissing")}</p>}
                <div className="sheet-foot">
                  {item?.resettable ? <Button onClick={reset}>{t("promptReset")}</Button> : null}
                  <Button autoInsertSpace={false} type="primary" onClick={() => nav(base + "/edit")}>{t("promptEdit")}</Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
