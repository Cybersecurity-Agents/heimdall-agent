import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Card, Col, List, Progress, Row, Space, Statistic, Tag, Typography } from "antd";
import {
  ProjectOutlined,
  UnorderedListOutlined,
  ThunderboltOutlined,
  ApiOutlined,
} from "@ant-design/icons";
import { useDesk } from "../store";
import { emptyTok, fmtTok } from "../lib/format";

function fmtBackend(name: string) {
  const v = name.trim().toLowerCase();
  if (v === "pi") return "Pi";
  if (v === "sdk") return "SDK";
  return name.trim();
}

export function HomePage() {
  const { t, projects, tokens, status, displayProjectName, selectProject, loadWorkspace, loadStatus, loadSettings } = useDesk();
  const nav = useNavigate();

  useEffect(() => {
    loadWorkspace();
    loadStatus();
    loadSettings();
  }, [loadWorkspace, loadStatus, loadSettings]);

  const tot = tokens.total || emptyTok();
  const tasks = (status.task_count as number | undefined) != null
    ? Number(status.task_count)
    : projects.reduce((n, p) => n + (Number(p.task_count) || 0), 0);
  const latest = projects[0] || null;
  const done = Number(latest?.progress?.done || 0);
  const total = Number(latest?.progress?.total ?? latest?.task_count ?? 0);
  const live = Number(latest?.progress?.live || 0);
  const remain = Math.max(0, total - done);
  const liveBar = Math.min(live, remain);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const donePct = total > 0 ? (done / total) * 100 : 0;
  const livePct = total > 0 ? (liveBar / total) * 100 : 0;
  const mixSum = (tot.input_tokens || 0) + (tot.output_tokens || 0) + (tot.cache_read_tokens || 0) + (tot.cache_write_tokens || 0);
  const models = (tokens.models || []).slice(0, 4);
  const backend = String(status.backend || "").trim();
  const loopBackend = String(status.loop_backend || "").trim();
  const runtime = String(status.runtime || "local").trim().toLowerCase();

  function openLatest() {
    if (!latest) return;
    void selectProject(latest.id);
    nav("/projects");
  }

  return (
    <div className="page">
      <Row gutter={[16, 16]}>
        <Col xs={12} lg={6}>
          <Card hoverable onClick={() => nav("/projects")}>
            <Statistic title={t("statProjects")} value={Number(status.project_count != null ? status.project_count : projects.length)} prefix={<ProjectOutlined />} />
          </Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card hoverable onClick={() => nav("/projects")}>
            <Statistic title={t("statTasks")} value={tasks || 0} prefix={<UnorderedListOutlined />} />
          </Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card>
            <Statistic title={t("statLive")} value={Number(status.active_jobs || 0)} prefix={<ThunderboltOutlined />} valueStyle={{ color: Number(status.active_jobs) ? "#4f4f4f" : undefined }} />
          </Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card>
            <Statistic title={t("tokCalls")} value={tot.calls || 0} prefix={<ApiOutlined />} />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} className="home-pair" style={{ marginTop: 16 }}>
        <Col xs={24} lg={12}>
          <Card
            title={t("homePulse")}
            extra={latest ? <Typography.Link onClick={openLatest}>{displayProjectName(latest)}</Typography.Link> : null}
            className="home-pair-card"
            hoverable={Boolean(latest)}
            onClick={latest ? openLatest : undefined}
          >
            <div className="home-pulse">
              <Progress type="dashboard" percent={pct} strokeColor="#4f4f4f" format={() => (total ? `${done}/${total}` : String(done))} />
              <div className="home-pulse-stats">
                <Row gutter={16}>
                  <Col span={6}><Statistic title={t("statRemain")} value={remain} /></Col>
                  <Col span={6}><Statistic title={t("statLive")} value={live} valueStyle={live ? { color: "#fa8c16" } : undefined} /></Col>
                  <Col span={6}><Statistic title={t("statDone")} value={done} /></Col>
                  <Col span={6}><Statistic title={t("statRate")} value={`${pct}%`} /></Col>
                </Row>
                {latest && total ? (
                  <div className="mix-bar home-pulse-bar" aria-hidden="true">
                    {donePct ? <span className="mix-seg" style={{ width: `${donePct}%`, background: "#4f4f4f" }} /> : null}
                    {livePct ? <span className="mix-seg" style={{ width: `${livePct}%`, background: "#fa8c16" }} /> : null}
                  </div>
                ) : (
                  <Typography.Text type="secondary">{latest ? t("pulseEmpty") : t("pulseNoProject")}</Typography.Text>
                )}
                <Space size={4} wrap style={{ marginTop: 12 }}>
                  {backend ? <Tag>{fmtBackend(backend)}</Tag> : null}
                  {loopBackend ? <Tag>{t("tokLoop")} · {fmtBackend(loopBackend)}</Tag> : null}
                  <Tag>{runtime === "docker" ? t("pulseEnvDocker") : t("pulseEnvLocal")}</Tag>
                </Space>
              </div>
            </div>
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title={t("tokenBoard")} className="home-pair-card">
            <Row gutter={16}>
              <Col span={6}><Statistic title={t("tokIn")} value={fmtTok(tot.input_tokens)} /></Col>
              <Col span={6}><Statistic title={t("tokOut")} value={fmtTok(tot.output_tokens)} /></Col>
              <Col span={6}><Statistic title={t("tokCache")} value={fmtTok(tot.cache_read_tokens)} /></Col>
              <Col span={6}><Statistic title={t("tokCacheWrite")} value={fmtTok(tot.cache_write_tokens)} /></Col>
            </Row>
            {mixSum ? (
              <Progress
                style={{ marginTop: 16 }}
                percent={100}
                success={{ percent: Math.round(((tot.input_tokens || 0) / mixSum) * 100) }}
                showInfo={false}
                strokeColor="#fa8c16"
              />
            ) : (
              <Typography.Text type="secondary">{t("tokNone")}</Typography.Text>
            )}
            {models.length ? (
              <Space size={4} wrap style={{ marginTop: 12 }}>
                {models.map((m) => (
                  <Tag key={m.name} color={m.role === "loop" ? "orange" : "default"}>
                    {m.name} {m.total_tokens ? fmtTok(m.total_tokens) : ""}
                  </Tag>
                ))}
              </Space>
            ) : null}
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} className="home-pair home-lists" style={{ marginTop: 16 }}>
        <Col xs={24} lg={12}>
          <Card title={t("homeByProject")} className="home-pair-card">
            <List
              size="small"
              dataSource={projects.slice(0, 5)}
              locale={{ emptyText: t("noProjects") }}
              renderItem={(p) => {
                const tok = (tokens.projects || []).find((x) => x.id === p.id) || emptyTok();
                return (
                  <List.Item
                    style={{ cursor: "pointer" }}
                    onClick={() => { selectProject(p.id); nav("/projects"); }}
                    extra={<Typography.Text type="secondary">{fmtTok(tok.total_tokens)}</Typography.Text>}
                  >
                    <List.Item.Meta
                      title={displayProjectName(p)}
                      description={t("tokProject", { n: p.task_count || 0, total: fmtTok(tok.total_tokens) })}
                    />
                  </List.Item>
                );
              }}
            />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title={t("homeByTask")} className="home-pair-card">
            <List
              size="small"
              dataSource={(tokens.challenges || []).slice(0, 5)}
              locale={{ emptyText: t("tokNone") }}
              renderItem={(c) => {
                const proj = projects.find((p) => p.id === c.project_id);
                return (
                  <List.Item
                    style={{ cursor: "pointer" }}
                    onClick={() => { if (c.project_id) selectProject(c.project_id); nav("/projects"); }}
                    extra={<Typography.Text type="secondary">{fmtTok(c.total_tokens)}</Typography.Text>}
                  >
                    <List.Item.Meta
                      title={c.code || "?"}
                      description={`${proj ? displayProjectName(proj) : t("tokUnassigned")} · ${t("tokIn")} ${fmtTok(c.input_tokens)} / ${t("tokOut")} ${fmtTok(c.output_tokens)}`}
                    />
                  </List.Item>
                );
              }}
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
