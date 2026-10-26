import { Input, Select } from "antd";

export const TUNING_SUFFIXES = ["THINKING", "THINKING_MODE", "THINKING_BUDGET", "CONTEXT_WINDOW", "MAX_OUTPUT_TOKENS", "COMPACT_ENABLED", "COMPACT_PCT", "COMPACT_KEEP_RECENT_TOKENS", "REASONING", "CAPABILITY_PROFILE", "CAPABILITY_PROVIDER", "CAPABILITY_CUSTOM"];
export type EffectiveLlmOptions = {
  profileId?: string; capabilitySource?: string; catalogVersion?: string; adapter?: string;
  protocol?: string;
  model: string; requestedThinking: string; thinking: string; supportedThinking: string[];
  contextWindow: number | null; contextSource: string; maxOutputTokens: number | null;
  compactEnabled: boolean; compactPct: number; keepRecentTokens: number | null;
  thinkingMode: string; thinkingBudget: number; supportsAdaptive?: boolean; requiresAdaptive?: boolean;
};

export function LlmTuning({ loop, values, onChange, effective, profiles = [], t }: {
  loop: boolean; values: Record<string, string>; onChange: (key: string, value: string) => void;
  profiles?: string[]; effective?: EffectiveLlmOptions; model: string; t: (key: string) => string;
}) {
  const prefix = loop ? "HEIMDALL_LOOP_" : "HEIMDALL_";
  const get = (suffix: string) => values[prefix + suffix] || "";
  const key = (suffix: string) => prefix + suffix;
  const select = (suffix: string, label: string, options: { value: string; label: string; disabled?: boolean }[]) => (
    <div className="field">
      <label htmlFor={key(suffix)}>{t(label)}</label>
      <Select showSearch optionFilterProp="label" id={key(suffix)} value={get(suffix) === "auto" ? "" : get(suffix)} style={{ width: "100%" }}
        options={options} onChange={value => onChange(key(suffix), value)} />
    </div>
  );
  const number = (suffix: string, label: string, min: number, max: number) => (
    <div className="field">
      <label htmlFor={key(suffix)}>{t(label)}</label>
      <Input id={key(suffix)} type="number" min={min} max={max} step={1}
        placeholder={t("llmAuto")} value={get(suffix) === "auto" ? "" : get(suffix)}
        onChange={event => onChange(key(suffix), event.target.value)} />
    </div>
  );
  const auto = { value: "", label: t("llmAuto") };
  return <div className="llm-tuning" style={{ marginTop: 16 }}>
    <div className="form-grid">
      {select("CAPABILITY_PROFILE", "llmProfile", [{ value: "", label: t("llmAuto") },
        ...Array.from(new Set(["none", "deepseek", "thinking-toggle", "anthropic-budget", "claude-adaptive", "openai-effort", "grok", "grok-4.5", "grok-4.3", "grok-default", ...profiles])).map(value => ({ value, label: value })),
        { value: "custom", label: t("llmCustomProfile") }])}
      <div className="field"><label htmlFor={key("CAPABILITY_PROVIDER")}>{t("llmProviderScope")}</label>
        <Input id={key("CAPABILITY_PROVIDER")} value={get("CAPABILITY_PROVIDER")} placeholder="xai / deepseek / anthropic / moonshotai / zai"
          onChange={e => onChange(key("CAPABILITY_PROVIDER"), e.target.value)} />
      </div>
    </div>
    <p className="help">{t("llmProfileHelp")}</p>
    {get("CAPABILITY_PROFILE") === "custom" && <div className="field">
      <label htmlFor={key("CAPABILITY_CUSTOM")}>{t("llmCustomProfile")}</label>
      <Input.TextArea id={key("CAPABILITY_CUSTOM")} rows={4} value={get("CAPABILITY_CUSTOM")}
        placeholder={'{"adapter":"deepseek","levels":["off","low","high","max"],"aliases":{"medium":"high","xhigh":"high"}}'}
        onChange={e => onChange(key("CAPABILITY_CUSTOM"), e.target.value)} />
    </div>}
    <div className="form-grid">
      {select("THINKING", "thinking", [
        { value: "", label: `${t("llmDefault")} (${loop ? "max" : "high"})` },
        ...["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(value => ({
          value, label: value,
        })),
      ])}
      {number("CONTEXT_WINDOW", "llmContext", 8192, 10000000)}
    </div>
    <p className="help">{t("llmContextHelp")}</p>
    <details>
      <summary>{t("llmAdvanced")}</summary>
      <div className="form-grid" style={{ marginTop: 16 }}>
        {loop && select("THINKING_MODE", "llmThinkingMode", [auto,
          { value: "adaptive", label: t("llmAdaptive") },
          { value: "enabled", label: t("llmFixed") },
          { value: "disabled", label: t("llmOff") },
        ])}
        {(get("CAPABILITY_PROFILE") === "anthropic-budget" || effective?.adapter === "anthropic-budget" || get("CAPABILITY_PROFILE") === "custom" || !!get("THINKING_BUDGET")) && number("THINKING_BUDGET", "llmThinkingBudget", 1024, 999999)}
        {number("MAX_OUTPUT_TOKENS", "llmOutput", 1024, 1000000)}
        {select("COMPACT_ENABLED", "llmCompaction", [
          { value: "", label: t("llmOnDefault") }, { value: "true", label: t("llmOn") }, { value: "false", label: t("llmOff") },
        ])}
        {get("COMPACT_ENABLED") !== "false" && number("COMPACT_PCT", "llmCompactPct", 10, 90)}
        {!loop && get("COMPACT_ENABLED") !== "false" && number("COMPACT_KEEP_RECENT_TOKENS", "llmKeepRecent", 1024, 2000000)}
        {!loop && select("REASONING", "llmReasoning", [auto, { value: "true", label: t("llmOn") }, { value: "false", label: t("llmOff") }])}
        {!loop && <div className="field">
          <label htmlFor="HEIMDALL_LLM_API">{t("llmProtocol")}</label>
          <Select id="HEIMDALL_LLM_API" style={{ width: "100%" }} value={values.HEIMDALL_LLM_API || ""}
            options={[auto, { value: "anthropic", label: "Anthropic Messages" }, { value: "openai", label: "OpenAI Chat Completions" }, { value: "responses", label: "Responses (xAI / Grok)" }]}
            onChange={value => onChange("HEIMDALL_LLM_API", value)} />
        </div>}
      </div>
      <p className="help">{t(loop ? "llmClaudeHelp" : "llmPiHelp")}</p>
    </details>
    {effective && <div className="note" style={{ marginTop: 16 }} aria-label={t("llmEffective")}>
      <strong>{t("llmEffective")}</strong>
      <p>{t("llmProtocol")}: {effective.protocol}</p>
      <p>{t("llmProfile")}: {effective.profileId || "—"} · {t("llmCapability_" + effective.capabilitySource)} · {effective.catalogVersion}</p>
      <p>{t("thinking")}: {effective.requestedThinking} → {effective.adapter === "none" ? t("llmNoReasoningOverride") : effective.thinking}
        {loop ? ` · ${effective.thinkingMode}${effective.adapter === "anthropic-budget" && effective.thinkingMode === "enabled" ? ` (${effective.thinkingBudget.toLocaleString()} tokens)` : ""}` : ""}</p>
      <p>{t("llmContext")}: {effective.contextWindow?.toLocaleString() ?? "SDK"} ({t("llmSource_" + effective.contextSource)})
        {" · "}{t("llmOutput")}: {effective.maxOutputTokens?.toLocaleString() ?? "SDK"}</p>
      <p>{t("llmCompaction")}: {effective.compactEnabled ? `${effective.compactPct}%` : t("llmOff")}
        {!loop && effective.compactEnabled ? ` · ${t("llmKeepRecent")}: ${effective.keepRecentTokens?.toLocaleString()}` : ""}</p>
    </div>}
  </div>;
}
