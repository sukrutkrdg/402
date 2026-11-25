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

/** The /v1 root, whether VLLM_BASE_URL includes /v1 or not. */
function v1Root(base: string): string {
  const b = base.replace(/\/+$/, "");
  return /\/v1$/.test(b) ? b : `${b}/v1`;
}

/** Served model ids, fetched once per instance from /v1/models (auto-discovery). */
let cachedModels: string[] | null = null;
async function servedModels(base: string, key: string): Promise<string[]> {
  if (cachedModels) return cachedModels;
  try {
    const res = await fetch(`${v1Root(base)}/models`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return (cachedModels = []);
    const j = (await res.json()) as { data?: { id?: string }[] };
    cachedModels = (j.data ?? []).map((m) => String(m.id)).filter(Boolean);
    return cachedModels;
  } catch {
    return (cachedModels = []);
  }
}

/** Pick the model to call: the requested one if served, else one that looks like it, else the first served. */
async function resolveModel(base: string, key: string, preferred: string): Promise<string> {
  const models = await servedModels(base, key);
  if (models.length === 0) return preferred; // couldn't list — try as-is
  if (models.includes(preferred)) return preferred;
  const stem = preferred.split("-")[0];
  return models.find((m) => m.toLowerCase().includes(stem.toLowerCase())) ?? models[0];
}

/** One OpenAI-compatible chat completion. Throws on any failure (so the paid path never settles a dud). */
export async function vllmChat(
  messages: ChatMessage[],
  opts: { model?: string; maxTokens?: number; temperature?: number; timeoutMs?: number } = {},
): Promise<string> {
  const base = process.env.VLLM_BASE_URL?.trim();
  if (!base) throw new Error("vLLM not configured (set VLLM_BASE_URL)");
  const key = process.env.VLLM_API_KEY?.trim() || "";
  const preferred = opts.model || process.env.VLLM_MODEL?.trim() || "log-expert";
  // Auto-discover the actual served model so a name mismatch doesn't 404.
  const model = await resolveModel(base, key, preferred);

  const res = await fetch(`${v1Root(base)}/chat/completions`, {
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
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 180);
    const avail = cachedModels?.length ? ` | served models: ${cachedModels.join(", ")}` : "";
    throw new Error(`vLLM ${res.status} (model=${model}): ${body}${avail}`);
  }
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = j?.choices?.[0]?.message?.content;
  if (!text || !String(text).trim()) throw new Error("vLLM returned no content");
  return String(text).trim();
}
