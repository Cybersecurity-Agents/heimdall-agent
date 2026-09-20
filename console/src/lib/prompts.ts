import type { Lang } from "../i18n";
import type { PromptItem } from "../types";

export function promptGroupLabel(t: (key: string) => string, group: string) {
  if (group === "solver") return t("promptGroupSolver");
  if (group === "observer") return t("promptGroupObserver");
  return t("promptGroupWorkspace");
}

export function promptTitle(item: PromptItem, lang: Lang) {
  return lang === "en" ? (item.title_en || item.title_zh || item.id) : (item.title_zh || item.title_en || item.id);
}

export function promptInject(item: PromptItem, lang: Lang) {
  return lang === "en" ? (item.inject_en || item.inject_zh || "") : (item.inject_zh || item.inject_en || "");
}

export function promptGroups(items: PromptItem[]) {
  return Array.from(new Set(items.map((p) => p.group || "workspace")));
}
