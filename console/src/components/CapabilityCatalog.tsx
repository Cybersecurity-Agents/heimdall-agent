import { useState } from "react";
import { Button, Input, Select } from "antd";
import { api } from "../api";

export type CatalogSummary = { version: string; source: string; profiles: string[]; history: string[] };
export function CapabilityCatalog({ catalog, reload, t }: { catalog?: CatalogSummary; reload: () => Promise<void>; t: (key: string) => string }) {
  const [source, setSource] = useState("");
  const [json, setJson] = useState("");
  const [version, setVersion] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function update(action: string) {
    setBusy(true); setError("");
    try {
      const body = action === "import" ? { action, catalog: JSON.parse(json) } : { action, url: source, version };
      const result = await api<{ ok: boolean; error?: string }>("/api/llm-catalog", { method: "POST", body: JSON.stringify(body) });
      if (!result.ok) throw new Error(result.error);
      await reload(); setVersion(undefined);
    } catch (e) { setError(String((e as Error).message)); }
    finally { setBusy(false); }
  }
  return <details style={{ marginTop: 20 }}>
    <summary>{t("llmCatalog")} · {catalog?.version || "—"}</summary>
    <p className="help">{t("llmCatalogHelp")}</p>
    <p>{t("llmCatalogSource")}: {catalog?.source || "—"}</p>
    <div className="form-grid">
      <div className="field"><label htmlFor="catalog-url">{t("llmCatalogUrl")}</label>
        <Input id="catalog-url" value={source} placeholder="https://…/model-capabilities.json" onChange={e => setSource(e.target.value)} />
        <Button disabled={busy || !source} onClick={() => update("refresh")}>{t("llmCatalogRefresh")}</Button>
      </div>
      <div className="field"><label htmlFor="catalog-rollback">{t("llmCatalogRollback")}</label>
        <Select id="catalog-rollback" value={version} style={{ width: "100%" }} options={(catalog?.history || []).map(value => ({ value, label: value }))} onChange={setVersion} />
        <Button disabled={busy || !version} onClick={() => update("rollback")}>{t("llmCatalogRollback")}</Button>
      </div>
    </div>
    <div className="field"><label htmlFor="catalog-json">{t("llmCatalogJson")}</label>
      <Input.TextArea id="catalog-json" rows={5} value={json} onChange={e => setJson(e.target.value)} />
      <Button disabled={busy || !json} onClick={() => update("import")}>{t("llmCatalogImport")}</Button>
    </div>
    <a href="/api/llm-catalog" target="_blank" rel="noreferrer">{t("llmCatalogExport")}</a>
    {error && <p role="alert">{error}</p>}
  </details>;
}
