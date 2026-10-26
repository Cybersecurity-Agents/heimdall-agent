/** SDKs append different resource paths: Anthropic adds /v1/messages,
 * while OpenAI adds /chat/completions or /responses to a versioned base. */
export function llmSdkBaseUrl(baseUrl: string, api: string): string {
  if (!baseUrl) return baseUrl;
  const url = new URL(baseUrl);
  let path = url.pathname.replace(/\/+$/, "");
  if (api === "anthropic-messages") {
    path = path.replace(/\/v1(?:\/messages)?$/i, "");
  } else if (api === "openai-completions") {
    path = path.replace(/\/chat\/completions$/i, "");
  } else if (api === "openai-responses") {
    path = path.replace(/\/responses$/i, "");
  }
  url.pathname = path || "/";
  return url.toString().replace(/^([a-z][a-z\d+.-]*:\/\/[^/?#]+)\/(?=[?#]|$)/i, "$1");
}
