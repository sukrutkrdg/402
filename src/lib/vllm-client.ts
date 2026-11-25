/**
 * vLLM client — the owner's self-hosted, OpenAI-compatible inference endpoint
 * (an RTX 5070 behind a Cloudflare Tunnel at VLLM_BASE_URL). Free compute, so the
 * services it powers can run a real free tier. Plain fetch, no SDK.
 *
 * Config: VLLM_BASE_URL (e.g. https://llm-api.402.com.tr/v1), VLLM_API_KEY,
 * optional VLLM_MODEL default. (Build bump to pick up rotated VLLM_API_KEY.)
 */
import "server-only";

export function vllmConfigured(): boolean {
  return Boolean(process.env.VLLM_BASE_URL?.trim());
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** One OpenAI-compatible chat completion. Throws on any failure (so the paid path never settles a dud). */
export async function vllmChat(
  messages: ChatMessage[],
  opts: { model?: string; maxTokens?: number; temperature?: number; timeoutMs?: number } = {},
): Promise<string> {
  const base = process.env.VLLM_BASE_URL?.trim();
  if (!base) throw new Error("vLLM not configured (set VLLM_BASE_URL)");
  const key = process.env.VLLM_API_KEY?.trim() || "";
  const model = opts.model || process.env.VLLM_MODEL?.trim() || "log-expert";

  // Normalise to the OpenAI route whether VLLM_BASE_URL ends in /v1 or not.
  const b = base.replace(/\/+$/, "");
  const endpoint = /\/v1$/.test(b) ? `${b}/chat/completions` : `${b}/v1/chat/completions`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: opts.maxTokens ?? 512,
      temperature: opts.temperature ?? 0.2,
      stream: false,
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30000),
  });
  if (!res.ok) throw new Error(`vLLM ${res.status}: ${(await res.text().catch(() => "")).slice(0, 180)}`);
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = j?.choices?.[0]?.message?.content;
  if (!text || !String(text).trim()) throw new Error("vLLM returned no content");
  return String(text).trim();
}
