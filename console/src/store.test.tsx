// @vitest-environment jsdom
import { useEffect } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("./api", () => ({ api: mock.api, withProject: (path: string, id: string) => path + (path.includes("?") ? "&" : "?") + "project=" + id }));
import { DeskProvider, useDesk } from "./store";
let state: ReturnType<typeof useDesk>, root: Root, container: HTMLDivElement, refreshes: number;
function Probe({ auto = false }: { auto?: boolean }) {
  state = useDesk();
  const load = state.loadDesk;
  useEffect(() => { if (auto && ++refreshes < 4) void load(); }, [auto, load]);
  return <p>{state.graph?.publication.revision}</p>;
}
const graph = (revision: string) => ({ publication: { revision, jobId: "job", phase: "observe", publishedAt: 1 }, view: { nodes: [], edges: [] } });
function answer(path: string): unknown {
  if (path.endsWith("/tasks")) return { items: ["a", "b"].map((id) => ({ id, code: id, project_id: "project", name: id })) };
  if (path.startsWith("/api/graph/")) return { graph: graph(path.includes("/a?") ? "a" : "b") };
  return { items: [] };
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); refreshes = 0;
  localStorage.setItem("heimdall-project", "project"); localStorage.setItem("heimdall-task", "a");
  mock.api.mockReset().mockImplementation(async (path: string) => answer(path));
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); localStorage.clear(); vi.unstubAllGlobals(); });
it("does not restart graph loading when the task list response creates a new array", async () => {
  await act(async () => root.render(<DeskProvider><Probe auto /></DeskProvider>));
  expect(refreshes).toBe(1);
  expect(mock.api.mock.calls.filter(([path]) => path.startsWith("/api/graph/"))).toHaveLength(1);
  expect(container.textContent).toBe("a");
});
it("does not let a delayed task graph overwrite the newly selected task", async () => {
  let resolveA!: (value: unknown) => void;
  mock.api.mockImplementation((path: string) => path.startsWith("/api/graph/a?") ? new Promise((resolve) => { resolveA = resolve; }) : Promise.resolve(answer(path)));
  await act(async () => root.render(<DeskProvider><Probe /></DeskProvider>));
  let old!: Promise<void>;
  await act(async () => { old = state.loadDesk(); });
  expect(resolveA).toBeDefined();
  await act(async () => state.selectTask("b"));
  expect(state.graph).toBeNull();
  await act(async () => state.loadDesk());
  expect(state.graph?.publication.revision).toBe("b");
  await act(async () => { resolveA({ graph: graph("old-a") }); await old; });
  expect(state.graph?.publication.revision).toBe("b");
});
