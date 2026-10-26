// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18N } from "../i18n";

const mocked = vi.hoisted(() => ({
  loadSettings: vi.fn(async () => {}), loadVpn: vi.fn(async () => {}), setFlash: vi.fn(), api: vi.fn(),
}));
vi.mock("../store", () => ({ useDesk: () => state }));
vi.mock("../api", () => ({ api: mocked.api }));
import { SettingsPage } from "./Settings";
const state = {
  t: (key: string) => I18N.zh[key] || key, lang: "zh", setLang: vi.fn(),
  settings: { agent_runtime: "local", runtime_capabilities: {
    local: { available: false, reason: "Full tools unavailable" },
    docker: { available: false, reason: "Docker engine unavailable" },
  } },
  llm: {}, platform: {},
  vpn: null as Record<string, unknown> | null,
  flash: null as { id: string; msg: string; kind?: string } | null,
  ...mocked,
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  state.vpn = null; state.flash = null; state.llm = {};
  mocked.loadSettings.mockResolvedValue(undefined);
  mocked.loadVpn.mockResolvedValue(undefined);
  mocked.setFlash.mockImplementation((id: string, msg: string, kind?: string) => { state.flash = { id, msg, kind }; });
});
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });

describe("Settings runtime selection", () => {
  it("keeps Docker clickable without an engine and explains setup after saving", async () => {
    mocked.api.mockResolvedValue({ ok: true, settings: { ...state.settings, agent_runtime: "docker" } });
    const container = document.createElement("div"); document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(<SettingsPage />); });
      const choices = container.querySelectorAll<HTMLButtonElement>("#deploy-sheet button[role=radio]");
      expect(choices[0]!.disabled).toBe(true);
      expect(choices[1]!.disabled).toBe(false);
      expect(container.querySelector("#deploy-sheet > p.sheet-lede")).toBeNull();
      expect(container.textContent).not.toContain("docker compose -f");
      await act(async () => { choices[1]!.click(); });
      expect(mocked.api).toHaveBeenCalledWith("/api/settings", { method: "POST", body: JSON.stringify({ agent_runtime: "docker" }) });
      expect(mocked.setFlash).toHaveBeenCalledWith("settings", I18N.zh.deployDockerSavedPending, "ok");
    } finally { await act(async () => root.unmount()); container.remove(); }
  });
});

describe("Settings VPN feedback", () => {
  it.each(["upload", "connect"])("shows current VPN status without a stale banner after %s, reconnect and disconnect", async action => {
    state.vpn = { enabled: true, available: true, ready: false, connecting: false, running: false };
    state.flash = { id: "settings", msg: "Previous request failed", kind: "bad" };
    mocked.api.mockResolvedValue({ ok: true });
    const container = document.createElement("div"); document.body.appendChild(container);
    const root = createRoot(container);
    const render = () => act(async () => { root.render(<SettingsPage />); });
    const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(el => el.textContent === label)!;
    try {
      await render();
      if (action === "upload") {
        const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
        Object.defineProperty(input, "files", { value: [{ text: async () => "fixture profile" }] });
        await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
        expect(mocked.api).toHaveBeenCalledWith("/api/vpn", { method: "POST", body: JSON.stringify({ content: "fixture profile", connect: true }) });
      } else {
        await act(async () => { button(I18N.zh.vpnConnect!).click(); });
        expect(mocked.api).toHaveBeenCalledWith("/api/vpn", { method: "POST", body: JSON.stringify({ connect: true }) });
      }
      state.vpn = { ...state.vpn, running: true, connecting: true };
      await render();
      expect(container.querySelector('[role="status"]')?.textContent).toBe(I18N.zh.vpnConnecting);
      expect(container.querySelector(".flash")).toBeNull();

      state.vpn = { ...state.vpn, ready: true, connecting: false };
      await render();
      expect(container.querySelector('[role="status"]')?.textContent).toBe(I18N.zh.vpnReady);
      expect(container.textContent).not.toContain(I18N.zh.vpnConnecting);
      expect(container.querySelector(".flash")).toBeNull();

      await act(async () => { button(I18N.zh.vpnReconnect!).click(); });
      await render();
      expect(container.querySelector(".flash")).toBeNull();
      await act(async () => { button(I18N.zh.vpnDisconnect!).click(); });
      expect(mocked.api).toHaveBeenLastCalledWith("/api/vpn", { method: "POST", body: JSON.stringify({ action: "disconnect" }) });
      state.vpn = { ...state.vpn, running: false, ready: false };
      await render();
      expect(container.querySelector('[role="status"]')?.textContent).toBe(I18N.zh.vpnDown);
      expect(container.querySelector(".flash")).toBeNull();
    } finally { await act(async () => root.unmount()); container.remove(); }
  });

  it("keeps connection request errors visible", async () => {
    mocked.api.mockResolvedValue({ ok: false, error: "VPN profile is missing" });
    const container = document.createElement("div"); document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(<SettingsPage />); });
      const connect = [...container.querySelectorAll<HTMLButtonElement>("button")].find(el => el.textContent === I18N.zh.vpnConnect)!;
      await act(async () => { connect.click(); });
      await act(async () => { root.render(<SettingsPage />); });
      expect(container.querySelector(".flash.bad")?.textContent).toBe("VPN profile is missing");
    } finally { await act(async () => root.unmount()); container.remove(); }
  });
});


describe("model tuning settings", () => {
  it("submits independent loop tuning and keeps edits after validation fails", async () => {
    state.llm = {
      solver: { HEIMDALL_THINKING: { value: "high" } },
      loop: { HEIMDALL_LOOP_THINKING: { value: "low" }, HEIMDALL_LOOP_MAX_OUTPUT_TOKENS: { value: "8192" } },
    };
    mocked.api.mockResolvedValue({ ok: false, error: "CONTEXT_WINDOW is too small" });
    const container = document.createElement("div"); document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(<SettingsPage />); });
      const input = container.querySelector<HTMLInputElement>("#HEIMDALL_LOOP_CONTEXT_WINDOW")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "64000");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => { container.querySelector("#llm-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
      const call = mocked.api.mock.calls.find(args => args[0] === "/api/settings")!;
      expect(JSON.parse(call[1].body).llm).toMatchObject({
        HEIMDALL_THINKING: "high", HEIMDALL_LOOP_THINKING: "low", HEIMDALL_LOOP_CONTEXT_WINDOW: "64000", HEIMDALL_LOOP_MAX_OUTPUT_TOKENS: "8192",
      });
      expect(input.value).toBe("64000");
      expect(container.querySelector("#llm-form [role=alert]")?.textContent).toBe("CONTEXT_WINDOW is too small");
      expect(mocked.setFlash).toHaveBeenCalledWith("settings", "CONTEXT_WINDOW is too small", "bad");
      expect(container.textContent).toContain(I18N.zh.llmApplyHelp);
    } finally { await act(async () => root.unmount()); container.remove(); }
  });
});

it("round-trips the Responses protocol and displays a separate unsupported Claude slot", async () => {
  state.llm = { solver: { ANTHROPIC_MODEL: { value: "grok-4.7" }, HEIMDALL_LLM_API: { value: "openai-responses" } },
    effective: { loop: null, loop_error: "Claude SDK requires an Anthropic-compatible gateway" } };
  mocked.api.mockResolvedValue({ ok: true });
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<SettingsPage />); });
    expect(container.textContent).toContain("Responses (xAI / Grok)");
    expect(container.textContent).toContain("Claude SDK requires an Anthropic-compatible gateway");
    await act(async () => { container.querySelector("#llm-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    const call = mocked.api.mock.calls.find(args => args[0] === "/api/settings")!;
    expect(JSON.parse(call[1].body).llm).toMatchObject({ ANTHROPIC_MODEL: "grok-4.7", HEIMDALL_LLM_API: "responses" });
  } finally { await act(async () => root.unmount()); container.remove(); }
});
