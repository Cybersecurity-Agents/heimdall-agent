import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';

const root = process.env.HEIMDALL_REPO_ROOT || '/opt/heimdall';
const data = process.env.HEIMDALL_DATA_DIR || join(root, 'data');
const configDir = join(data, 'config');
mkdirSync(configDir, { recursive: true, mode: 0o700 });
const configPath = join(configDir, 'config.yaml');
const toolsPath = join(configDir, 'tools.env.yaml');
// Initialize once. Console edits and credentials survive recreation/upgrades.
if (!existsSync(configPath)) {
  const cfg = parse(readFileSync(join(root, 'deploy/unified/config.yaml'), 'utf8'));
  cfg.paths = { data_dir: data, tools_env: toolsPath };
  cfg.docker.vpn.config = join(data, 'vpn/client.ovpn');
  writeFileSync(configPath, stringify(cfg), { mode: 0o600, flag: 'wx' });
}
if (!existsSync(toolsPath)) {
  const env = process.env;
  // Match the solver alias precedence, then persist one canonical configuration.
  // On recreation, the saved configuration (including console edits) remains authoritative.
  const key = env.HEIMDALL_LLM_API_KEY || env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || '';
  const url = env.HEIMDALL_LLM_BASE_URL || env.OPENAI_BASE_URL || env.ANTHROPIC_BASE_URL || '';
  const model = env.HEIMDALL_AGENT_MODEL || env.OPENAI_MODEL || env.ANTHROPIC_MODEL || '';
  const tools = parse(readFileSync(join(root, 'tools.env.example.yaml'), 'utf8'));
  Object.assign(tools.claude, {
    HEIMDALL_LLM_API_KEY: key, OPENAI_API_KEY: key,
    ANTHROPIC_API_KEY: key, ANTHROPIC_AUTH_TOKEN: key,
    HEIMDALL_LLM_BASE_URL: url, OPENAI_BASE_URL: url, ANTHROPIC_BASE_URL: url,
    HEIMDALL_AGENT_MODEL: model, OPENAI_MODEL: model, ANTHROPIC_MODEL: model,
  });
  if (env.HEIMDALL_LLM_API) tools.claude.HEIMDALL_LLM_API = env.HEIMDALL_LLM_API;
  else if (env.OPENAI_BASE_URL && !/\/anthropic|api\.anthropic\.com|\/messages\/?$/i.test(url)) {
    tools.claude.HEIMDALL_LLM_API = 'openai';
  }
  tools.coach.HEIMDALL_COACH_API = tools.claude.HEIMDALL_LLM_API;
  if (!env.HEIMDALL_LOOP_BASE_URL) tools.loop.HEIMDALL_LOOP_API = tools.claude.HEIMDALL_LLM_API;
  for (const name of ['HEIMDALL_LOOP_API_KEY', 'HEIMDALL_LOOP_BASE_URL', 'HEIMDALL_LOOP_MODEL']) {
    if (env[name]) tools.loop[name] = env[name];
  }
  writeFileSync(toolsPath, stringify(tools), { mode: 0o600, flag: 'wx' });
}
