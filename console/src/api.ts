export async function api<T = Record<string, unknown>>(path: string, opt?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opt,
  });
  const text = await r.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!r.ok && !data.error) data.error = r.statusText;
  return data as T;
}

export function withProject(path: string, projectId: string) {
  if (!projectId) return path;
  return path + (path.includes("?") ? "&" : "?") + "project=" + encodeURIComponent(projectId);
}
