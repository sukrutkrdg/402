/**
 * One place that builds the Anthropic client.
 *
 * It was ten places. `ai.ts` had a `client()` factory and then `ai-report.ts`
 * called `new Anthropic()` eight separate times and `ai-probe.ts` once more, so
 * anything that had to be true of every request — a header, a timeout, a
 * retry policy — was true of one call site and silently absent from the rest.
 *
 * That bill came due on 2026-09-03. Anthropic issues two kinds of key and they
 * do not authenticate the same way:
 *
 *   - A key created INSIDE a workspace is scoped to it, and the workspace is
 *     implied. Nothing extra to send. This is what we had until the key was
 *     rotated.
 *   - A personal or service-account key is *identity-linked*: it is not tied to
 *     one workspace, so every request has to name the workspace it acts in, via
 *     the `anthropic-workspace-id` header. Without it the API answers 400
 *     `invalid_request_error`, not 401 — the key is fine, the request is
 *     incomplete.
 *
 * The second kind is easy to misread as a dead key, because the symptom is the
 * same from outside: every AI endpoint fails. So the header is set here, once,
 * from `ANTHROPIC_WORKSPACE_ID`, and both key types work without anyone having
 * to remember which one is deployed. Leaving the variable unset is the correct
 * configuration for a workspace-scoped key — an empty header would be worse
 * than none, so it is omitted rather than sent blank.
 */

import "server-only";
import Anthropic from "@anthropic-ai/sdk";

/** `wrkspc_…` — required only for identity-linked (personal/service-account) keys. */
function workspaceId(): string {
  return process.env.ANTHROPIC_WORKSPACE_ID?.trim() ?? "";
}

export function aiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

/**
 * The client every AI path must use.
 *
 * Throws when the key is absent rather than returning a client that will fail
 * mid-request: every caller sits behind a paid endpoint, and `withX402` settles
 * only on a handler that returns — so failing before any work means the buyer
 * is not charged for a call we were never able to make.
 */
export function anthropicClient(): Anthropic {
  if (!aiConfigured()) {
    throw new Error("AI not configured: set ANTHROPIC_API_KEY");
  }
  const ws = workspaceId();
  return new Anthropic(ws ? { defaultHeaders: { "anthropic-workspace-id": ws } } : {});
}
