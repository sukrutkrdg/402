"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CREDIT_TOKEN_RE, loadSessionToken, maskToken, saveSessionToken } from "@/lib/session-credit-token";

interface TemplateView {
  id: string;
  name: string;
  description: string;
  inputs: Array<{ name: string; label: string; required?: boolean; placeholder?: string }>;
  steps: Array<{ service: string; name: string; params: Record<string, unknown> }>;
}

interface StepQuote {
  index: number;
  service: string;
  price: string;
  priceUsd: number;
  exact: boolean;
}

interface StepResult {
  index: number;
  service: string;
  status: string;
  httpStatus: number | null;
  chargedUsd: number;
  decision: string | null;
  error?: string;
  output?: unknown;
}

function TemplateCard({ t, token }: { t: TemplateView; token: string }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [quote, setQuote] = useState<{ totalUsd: number; exact: boolean; steps: StepQuote[] } | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  // The listed price comes from the API, which prices with the paid route's own function.
  useEffect(() => {
    fetch("/api/workflows")
      .then((r) => r.json())
      .then((j: { templates?: Array<{ id: string; quote: typeof quote }> }) => setQuote(j.templates?.find((x) => x.id === t.id)?.quote ?? null))
      .catch(() => {});
  }, [t.id]);

  async function call(dryRun: boolean) {
    setBusy(true);
    setResult(null);
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (token) headers["x-credit-token"] = token;
      const res = await fetch("/api/workflows/run", { method: "POST", headers, body: JSON.stringify({ template: t.id, input: values, dryRun }) });
      setStatus(res.status);
      const j = (await res.json()) as Record<string, unknown>;
      setResult(j);
      if (j.quote) setQuote(j.quote as typeof quote);
    } catch (e) {
      setStatus(null);
      setResult({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const steps = (result?.steps as StepResult[] | undefined) ?? [];
  return (
    <div className="rounded-xl border border-slate-700 p-4 space-y-3">
      <div>
        <h2 className="text-lg font-semibold">{t.name}</h2>
        <p className="text-sm opacity-75">{t.description}</p>
      </div>
      <ol className="text-sm list-decimal pl-5 space-y-0.5">
        {t.steps.map((s, i) => (
          <li key={i}>
            <code>{s.service}</code>{" "}
            {quote?.steps[i] ? <span className="opacity-75">— {quote.steps[i].price}</span> : null}
            <span className="opacity-60 text-xs"> {JSON.stringify(s.params)}</span>
          </li>
        ))}
      </ol>
      {quote && (
        <p className="text-sm">
          Quote: <strong>${quote.totalUsd.toFixed(3)}</strong> if every step runs{quote.exact ? "" : " (some step prices depend on earlier answers)"}. Steps
          not called are not charged.
        </p>
      )}
      <div className="grid sm:grid-cols-2 gap-2">
        {t.inputs.map((i) => (
          <label key={i.name} className="text-sm">
            {i.label}
            {i.required ? " *" : ""}
            <input
              value={values[i.name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [i.name]: e.target.value.trim() }))}
              placeholder={i.placeholder}
              spellCheck={false}
              className="mt-1 w-full rounded-lg border border-slate-600 bg-transparent px-2 py-1 font-mono text-xs"
            />
          </label>
        ))}
      </div>
      <div className="flex gap-2">
        <button disabled={busy} onClick={() => call(true)} className="rounded-lg border border-slate-500 px-3 py-1.5 text-sm disabled:opacity-50">
          Quote (dry run)
        </button>
        <button
          disabled={busy || !token}
          onClick={() => call(false)}
          title={token ? "" : "Set a credit token above first"}
          className="rounded-lg bg-cyan-600 text-white px-3 py-1.5 text-sm font-semibold disabled:opacity-50"
        >
          Run on my credits
        </button>
        {busy && <span className="text-sm opacity-60 self-center">calling the endpoints…</span>}
      </div>
      {result && (
        <div className="space-y-2">
          <p className="text-sm">HTTP {status ?? "—"}{typeof result.error === "string" ? ` · ${result.error}` : ""}</p>
          {steps.length > 0 && (
            <table className="text-xs w-full">
              <thead>
                <tr className="text-left opacity-70">
                  <th>#</th>
                  <th>service</th>
                  <th>status</th>
                  <th>charged</th>
                  <th>decision</th>
                  <th>note</th>
                </tr>
              </thead>
              <tbody>
                {steps.map((s) => (
                  <tr key={s.index}>
                    <td>{s.index}</td>
                    <td><code>{s.service}</code></td>
                    <td>{s.status}{s.httpStatus ? ` (${s.httpStatus})` : ""}</td>
                    <td>${s.chargedUsd.toFixed(3)}</td>
                    <td>{s.decision ?? "—"}</td>
                    <td>{s.error ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {typeof result.totalChargedUsd === "number" && <p className="text-sm">Total charged: ${result.totalChargedUsd.toFixed(3)}</p>}
          <details>
            <summary className="text-sm cursor-pointer">Full JSON response</summary>
            <pre className="text-xs whitespace-pre-wrap break-all max-h-[50vh] overflow-auto bg-slate-950 text-slate-200 p-2 rounded">
              {JSON.stringify(result, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}

export default function WorkflowsClient({ templates, maxSteps }: { templates: TemplateView[]; maxSteps: number }) {
  const [token, setToken] = useState("");
  const [draft, setDraft] = useState("");

  useEffect(() => {
    setToken(loadSessionToken());
  }, []);

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold">Workflows</h1>
        <p className="text-sm opacity-80">
          Up to {maxSteps} paid checks in one request (<code>POST /api/workflows/run</code>). Each step is a call to{" "}
          <code>/api/x402/&lt;service&gt;</code> with your prepaid credit token and is debited exactly like a direct call: a
          step that fails is refunded, and after a failure, an empty balance or a <strong>STOP</strong> decision the remaining
          steps are not called and not charged. A run is refused up front if your balance is below the quote. Custom
          steps and the reference syntax (<code>&quot;$1.data.address&quot;</code>) are documented at{" "}
          <a href="/api/workflows" className="underline">/api/workflows</a>.
        </p>
      </div>
      <div className="rounded-xl border border-slate-700 p-4 space-y-2">
        <p className="text-sm">
          {token ? (
            <>
              Credit token: <code>{maskToken(token)}</code> (this tab only){" "}
              <button
                className="underline"
                onClick={() => {
                  saveSessionToken("");
                  setToken("");
                }}
              >
                clear
              </button>
            </>
          ) : (
            <>
              No credit token set. Quotes work without one; running needs one —{" "}
              <Link href="/credits" className="underline">buy credits</Link>.
            </>
          )}
        </p>
        {!token && (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const t = draft.trim();
              if (!CREDIT_TOKEN_RE.test(t)) return;
              saveSessionToken(t);
              setToken(t);
              setDraft("");
            }}
          >
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="ck_…"
              type="password"
              autoComplete="off"
              className="flex-1 rounded-lg border border-slate-600 bg-transparent px-2 py-1 font-mono text-xs"
            />
            <button type="submit" disabled={!CREDIT_TOKEN_RE.test(draft.trim())} className="rounded-lg border border-slate-500 px-3 py-1 text-sm disabled:opacity-50">
              Use token
            </button>
          </form>
        )}
      </div>
      {templates.map((t) => (
        <TemplateCard key={t.id} t={t} token={token} />
      ))}
      <p className="text-xs opacity-60">
        Prefer typing? The <Link href="/terminal" className="underline">terminal</Link> runs the same templates: <code>run pre-buy 0x…</code>.
      </p>
    </div>
  );
}
