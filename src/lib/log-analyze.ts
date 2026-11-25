/**
 * log-analyze — an agent pastes a raw log line/snippet, gets a concise root-cause
 * read back. Powered by the owner's self-hosted vLLM (log-expert model), so the
 * compute is free and the service can offer a real free tier.
 *
 * Billing: throws on no input / backend down / model error → the route maps that
 * to a non-200, so withX402 never settles — the caller is not charged for a dud.
 * A successful analysis returns 200 and settles. Not advice.
 */
import "server-only";
import { vllmChat, vllmConfigured } from "./vllm-client";

const SYSTEM =
  "You are a senior site-reliability engineer. Given a raw log line or short snippet, reply with: " +
  "SEVERITY (one of info|warning|error|critical), the single most likely ROOT CAUSE in one sentence, " +
  "and 1-3 concrete NEXT STEPS as short bullets. Be specific and terse. No preamble.";

export async function logAnalyze(params: Record<string, string>) {
  const log = (params.log || params.text || "").trim();
  if (!log) throw new Error("Provide a log line or snippet (log=)");
  if (log.length > 6000) throw new Error("Log too long — send up to ~6000 chars");
  if (!vllmConfigured()) throw new Error("Log analysis backend is not configured yet (VLLM_BASE_URL)");

  const analysis = await vllmChat(
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: log },
    ],
    { model: process.env.VLLM_MODEL?.trim() || "log-expert", maxTokens: 400, temperature: 0.2 },
  );

  return {
    log: log.length > 300 ? `${log.slice(0, 300)}…` : log,
    analysis,
    model: process.env.VLLM_MODEL?.trim() || "log-expert",
    checkedAt: new Date().toISOString(),
  };
}
