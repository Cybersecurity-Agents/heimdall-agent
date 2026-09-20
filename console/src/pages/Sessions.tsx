import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useDesk } from "../store";
import { fmtTok, fmtTs } from "../lib/format";
import { sessInjectKinds, sessRefreshMessages } from "../lib/sessions";

export function SessionsPage() {
  const { t, lang, sessionList, sessionCalls, sessionCall, loadSessions } = useDesk();
  const { code = "", callId = "" } = useParams();
  const nav = useNavigate();

  useEffect(() => { loadSessions(code, callId); }, [code, callId, loadSessions]);

  const messages = sessRefreshMessages(((sessionCall && sessionCall.messages) || []) as { role?: string; parts?: { text?: string }[] }[]);
  const inject = sessInjectKinds(messages);
  const usage = (sessionCall && sessionCall.usage) as { input_tokens?: number; output_tokens?: number } | undefined;

  return (
    <section className="page sessions-page">
      <div className="sess-desk">
        <aside className="sess-nav" aria-label={t("sessCodes")}>
          <p className="kicker">{t("sessCodes")}</p>
          <ul className="sess-codes">
            {!sessionList.length ? <li className="empty-hint">{t("sessEmpty")}</li> : sessionList.map((row) => (
              <li key={String(row.code)}>
                <button type="button" className="prompt-item" aria-current={row.code === code ? "true" : "false"} onClick={() => nav("/sessions/" + encodeURIComponent(String(row.code)))}>
                  <span className="name">{String(row.code)}</span>
                  <span className={"flag" + (row.injected ? "" : " off")}>{String(row.calls || 0)}{row.injected ? " · " + t("sessInjected") : ""}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
        <aside className="sess-calls-pane" aria-label={t("sessCalls")}>
          <p className="kicker">{code ? `${code} · ${t("sessCalls")}` : t("sessCalls")}</p>
          <ul className="sess-calls">
            {!code ? <li className="empty-hint">{t("sessPick")}</li> : !sessionCalls.length ? <li className="empty-hint">{t("sessNoCalls")}</li> : sessionCalls.map((row) => {
              const u = (row.usage || {}) as { input_tokens?: number; output_tokens?: number };
              return (
                <li key={String(row.id)}>
                  <button type="button" className="prompt-item sess-call" aria-current={row.id === callId ? "true" : "false"} onClick={() => nav("/sessions/" + encodeURIComponent(code) + "/" + encodeURIComponent(String(row.id)))}>
                    <span className="name">{t("sessRole_" + (row.role || "solver"))} · {String(row.model || "—")}</span>
                    <span className="flag">{fmtTs(row.ts as number, lang)} · {fmtTok((u.input_tokens || 0) + (u.output_tokens || 0))}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>
        <div className="sess-thread">
          {!sessionCall || !sessionCall.ok ? <p className="empty-hint">{t("sessPick")}</p> : (
            <>
              <header className="sess-head">
                <h3>{t("sessRole_" + (sessionCall.role || "solver"))} · {String(sessionCall.model || "—")}</h3>
                <p className="sess-meta">
                  {fmtTs(sessionCall.ts as number, lang)} · {fmtTok(usage?.input_tokens)} in / {fmtTok(usage?.output_tokens)} out
                  {inject.map((k) => <span key={k} className={"sess-chip sess-chip-" + k}>{t("sessKind_" + k)}{k === "hint" ? "" : ""}</span>)}
                  {sessionCall.truncated ? <span className="sess-chip">{t("sessTruncated")}</span> : null}
                </p>
              </header>
              <div className="sess-msgs">
                {messages.map((msg, i) => (
                  <article className="sess-msg" data-role={msg.role} key={i}>
                    <h4>{msg.role}</h4>
                    {(msg.parts || []).map((part, j) => {
                      const kind = part.kind || "text";
                      const cls = kind === "text" ? "sess-part" : "sess-part sess-part-" + kind;
                      return (
                        <div className={cls} key={j}>
                          {kind !== "text" ? <span className="sess-badge">{t("sessKind_" + kind)}{part.has_hint ? " · " + t("sessHasHint") : ""}</span> : null}
                          <pre className="sess-text">{part.text}</pre>
                        </div>
                      );
                    })}
                  </article>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
