import * as http from "node:http";
import * as https from "node:https";
import type { Socket } from "node:net";
import type { LlmOptions } from "./llm-options.js";
import { llmSdkBaseUrl } from "./llm-endpoint.js";

/** Final wire contract, independent of SDK model-name heuristics. Never changes the model ID. */
export function adaptLlmRequest(body: Record<string, unknown>, options: LlmOptions): Record<string, unknown> {
  if (body.model !== options.model) return body;
  const out = { ...body };
  const originalReasoning = out.reasoning && typeof out.reasoning === "object" ? { ...out.reasoning as Record<string, unknown> } : {};
  delete originalReasoning.effort;
  delete out.thinking; delete out.reasoning_effort; delete out.reasoning; delete out.enable_thinking; delete out.thinking_budget;
  const output = { ...(out.output_config as Record<string, unknown> || {}) };
  delete output.effort;
  if (Object.keys(output).length) out.output_config = output; else delete out.output_config;
  const on = options.thinkingMode !== "disabled";
  const responses = options.protocol === "openai-responses";
  if (responses && Object.keys(originalReasoning).length) out.reasoning = originalReasoning;
  const anthropic = options.protocol === "anthropic-messages";
  switch (options.adapter) {
    case "deepseek":
    case "thinking-toggle":
      out.thinking = { type: on ? "enabled" : "disabled" };
      if (on && options.effort) {
        if (anthropic) out.output_config = { ...output, effort: options.effort };
        else out.reasoning_effort = options.effort;
      }
      break;
    case "openai-effort":
    case "grok":
      if (responses) out.reasoning = { ...originalReasoning, effort: on ? options.effort : "none" };
      else out.reasoning_effort = on ? options.effort : "none";
      break;
    case "reasoning-default": delete out.reasoning; break;
    case "claude-adaptive":
      out.thinking = { type: on ? "adaptive" : "disabled" };
      if (on) { out.output_config = { ...output, effort: options.effort }; delete out.temperature; }
      break;
    case "anthropic-budget":
      out.thinking = on ? { type: "enabled", budget_tokens: options.thinkingBudget } : { type: "disabled" };
      if (on) delete out.temperature;
      break;
    case "none": break;
  }
  if (options.capabilityProvider === "xai" || options.adapter === "grok") {
    // xAI rejects these on reasoning models. Its Responses API does not use
    // OpenAI reasoning summaries; encrypted items carry the continuation state.
    if (options.reasoning) {
      delete out.presence_penalty; delete out.frequency_penalty; delete out.stop;
      if (responses) out.include = [...new Set([...(Array.isArray(out.include) ? out.include : []), "reasoning.encrypted_content"])];
    }
    if (responses) {
      if (out.reasoning && typeof out.reasoning === "object") delete (out.reasoning as Record<string, unknown>).summary;
      delete out.prompt_cache_retention;
    }
  }
  if (responses) { delete out.max_tokens; delete out.max_completion_tokens; }
  if (options.maxOutputTokens) {
    // Respect smaller SDK auxiliary requests on the same model; this is a cap.
    const field = responses ? "max_output_tokens" : "max_completion_tokens" in out ? "max_completion_tokens" : "max_tokens";
    const existing = Number(out[field]);
    out[field] = Number.isFinite(existing) && existing > 0 ? Math.min(existing, options.maxOutputTokens) : options.maxOutputTokens;
  }
  if (options.adapter === "anthropic-budget" && on && Number(out.max_tokens) <= options.thinkingBudget) {
    out.max_tokens = options.thinkingBudget + 1024;
  }
  return out;
}
const hopHeaders = ["host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];
function headers(source: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out = { ...source };
  for (const name of [...hopHeaders, ...(String(source.connection || "").split(",").map(s => s.trim().toLowerCase()))]) delete out[name];
  return out;
}
export type LlmAdapterProxy = { baseUrl: string; close(): Promise<void> };
/** Per-session loopback proxy. Streams responses unchanged, including SSE and error bodies. */
export async function startLlmAdapter(upstream: string, options: LlmOptions): Promise<LlmAdapterProxy> {
  const target = new URL(llmSdkBaseUrl(upstream, options.protocol));
  if (!["http:", "https:"].includes(target.protocol)) throw new Error("Unsupported LLM upstream protocol");
  const sockets = new Set<Socket>();
  const requests = new Set<http.ClientRequest>();
  const server = http.createServer(async (req, res) => {
    let wire: Buffer;
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const raw of req) {
        const chunk = Buffer.from(raw); size += chunk.length;
        if (size > 32 * 1024 * 1024) { res.writeHead(413); res.end("LLM request exceeds 32 MiB"); return; }
        chunks.push(chunk);
      }
      wire = Buffer.concat(chunks);
      if (req.method === "POST" && /\/(messages|chat\/completions|responses)\/?(?:\?|$)/.test(req.url || "")) {
        const body = JSON.parse(wire.toString("utf8"));
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid request body");
        wire = Buffer.from(JSON.stringify(adaptLlmRequest(body, options)));
      }
    } catch { if (!res.destroyed) { res.writeHead(400); res.end("Invalid LLM request"); } return; }
    const forwarded = headers(req.headers);
    forwarded.host = target.host;
    forwarded["content-length"] = String(wire.length);
    const upstreamRequest = (target.protocol === "https:" ? https : http).request({
      hostname: target.hostname, port: target.port || undefined, path: req.url,
      method: req.method, headers: forwarded, agent: false, timeout: 600_000,
    }, upstreamResponse => {
      res.writeHead(upstreamResponse.statusCode || 502, headers(upstreamResponse.headers));
      upstreamResponse.on("error", () => res.destroy());
      upstreamResponse.pipe(res);
    });
    requests.add(upstreamRequest);
    upstreamRequest.once("close", () => requests.delete(upstreamRequest));
    res.once("close", () => upstreamRequest.destroy());
    upstreamRequest.once("timeout", () => upstreamRequest.destroy(new Error("LLM upstream timeout")));
    upstreamRequest.on("error", () => {
      if (!res.headersSent && !res.destroyed) { res.writeHead(502); res.end("LLM upstream connection failed"); }
      else res.destroy();
    });
    upstreamRequest.end(wire);
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  const port = (server.address() as { port: number }).port;
  let closed = false;
  return { baseUrl: `http://127.0.0.1:${port}${target.pathname}${target.search}`, async close() {
    if (closed) return; closed = true;
    for (const request of requests) request.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
