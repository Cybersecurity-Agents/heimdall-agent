import { useEffect } from "react";
import { HashRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import enUS from "antd/locale/en_US";
import { DeskProvider, useDesk } from "./store";
import { antdThemeFor } from "./theme";
import { Shell } from "./components/Shell";
import { HomePage } from "./pages/Home";
import { ProjectsPage } from "./pages/Projects";
import { DeskPage } from "./pages/Desk";
import { SessionsPage } from "./pages/Sessions";
import { PromptsPage } from "./pages/Prompts";
import { PromptDetailPage } from "./pages/PromptDetail";
import { SettingsPage } from "./pages/Settings";

function Poller() {
  const loc = useLocation();
  const { loadWorkspace, loadStatus, loadDesk, loadSessions } = useDesk();
  useEffect(() => {
    loadWorkspace();
    loadStatus();
  }, [loadWorkspace, loadStatus]);
  const page = loc.pathname.split("/")[1] || "home";
  const code = loc.pathname.split("/")[2];
  const callId = loc.pathname.split("/")[3];

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      if (page === "desk") loadDesk();
      if (page === "home") { loadWorkspace(); loadStatus(); }
      if (page === "sessions") loadSessions(code && decodeURIComponent(code), callId && decodeURIComponent(callId));
      if (page === "projects") loadWorkspace();
    };
    const id = window.setInterval(tick, 5000);
    return () => window.clearInterval(id);
  }, [page, code, callId, loadDesk, loadWorkspace, loadStatus, loadSessions]);
  return null;
}

function Themed() {
  const { theme, lang } = useDesk();
  return (
    <ConfigProvider locale={lang === "en" ? enUS : zhCN} theme={antdThemeFor(theme)} button={{ autoInsertSpace: false }}>
      <Poller />
      <Routes>
        <Route element={<Shell />}>
          <Route path="/" element={<Navigate to="/home" replace />} />
          <Route path="/home" element={<HomePage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/desk" element={<DeskPage />} />
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/sessions/:code" element={<SessionsPage />} />
          <Route path="/sessions/:code/:callId" element={<SessionsPage />} />
          <Route path="/prompts" element={<PromptsPage />} />
          <Route path="/prompts/:promptId" element={<PromptDetailPage />}>
            <Route path="edit" element={null} />
          </Route>
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/home" replace />} />
        </Route>
      </Routes>
    </ConfigProvider>
  );
}

export default function App() {
  return (
    <HashRouter>
      <DeskProvider>
        <Themed />
      </DeskProvider>
    </HashRouter>
  );
}
