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
  state.vpn = null; state.flash = null;
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
