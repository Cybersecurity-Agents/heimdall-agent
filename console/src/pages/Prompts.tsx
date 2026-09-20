import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button, Input } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import { useDesk } from "../store";
import { promptGroupLabel, promptGroups, promptInject, promptTitle } from "../lib/prompts";

export function PromptsPage() {
  const { t, lang, prompts, loadPrompts } = useDesk();
  const nav = useNavigate();
  const groups = promptGroups(prompts);
  const [params, setParams] = useSearchParams();
  const activeGroup = params.get("group") || "all";
  const query = params.get("q") || "";
  const filter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value && value !== "all") next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };
  const visible = prompts.filter((p) => (activeGroup === "all" || p.group === activeGroup)
    && [p.id, p.title_zh, p.title_en, p.inject_zh, p.inject_en].join(" ").toLowerCase().includes(query.trim().toLowerCase()));

  useEffect(() => { loadPrompts(); }, [loadPrompts]);

  return (
    <section className="page prompts-page">
      <div className="prompt-toolbar">
        <div className="prompt-filters" role="group" aria-label={t("navPrompts")}>
          {["all", ...groups].map((group) => <button type="button" key={group} aria-pressed={activeGroup === group}
            onClick={() => filter("group", group)}>
            {group === "all" ? t("promptAll") : promptGroupLabel(t, group)}
            <span>{group === "all" ? prompts.length : prompts.filter((p) => p.group === group).length}</span>
          </button>)}
        </div>
        <Input prefix={<SearchOutlined />} allowClear value={query} aria-label={t("promptSearch")}
          placeholder={t("promptSearch")} onChange={(e) => filter("q", e.target.value)} />
      </div>
      {!visible.length && <p className="empty-hint">{t("promptNoResults")}</p>}
      {groups.filter((group) => visible.some((p) => p.group === group)).map((group) => (
        <div key={group} className="prompt-index-group">
          <p className="prompt-group">{promptGroupLabel(t, group)}</p>
          <div className="prompt-cards">
            {visible.filter((p) => (p.group || "workspace") === group).map((p) => (
              <article className="prompt-card" key={p.id}>
                <header className="prompt-card-head">
                  <h3>{promptTitle(p, lang)}</h3>
                  <span className={"prompt-flag" + (p.injected ? "" : " off")}>
                    {p.injected ? t("promptInjected") : t("promptIdle")}
                  </span>
                </header>
                <p className="prompt-card-inject">{promptInject(p, lang)}</p>
                <div className="prompt-card-foot">
                  <Button autoInsertSpace={false} onClick={() => nav("/prompts/" + encodeURIComponent(p.id))}>{t("promptBrowse")}</Button>
                  <Button autoInsertSpace={false} onClick={() => nav("/prompts/" + encodeURIComponent(p.id) + "/edit")}>{t("promptEdit")}</Button>
                </div>
              </article>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
