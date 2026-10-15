"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CREDIT_TOKEN_RE, loadSessionToken, maskToken, saveSessionToken } from "@/lib/session-credit-token";

export interface TerminalCommand {
  cmd: string;
  service: string;
  name: string;
  price: string;
  freeEligible: boolean;
  args: string[];
}

interface TemplateMeta {
  id: string;
  name: string;
  inputs: Array<{ name: string; required: boolean }>;
}

type Line = { kind: "in" | "out" | "err" | "json"; text: string };

/** The verdict field a response carries, read from the response itself — never inferred. */
function decisionOf(body: unknown): string | null {
  const d = (body as { data?: Record<string, unknown> } | null)?.data;
  if (!d || typeof d !== "object") return null;
  const r = d.receipt as Record<string, unknown> | undefined;
  for (const v of [r?.decision, d.decision, d.verdict]) if (typeof v === "string") return v;
  return null;
}

export default function TerminalClient({ commands, templates }: { commands: TerminalCommand[]; templates: TemplateMeta[] }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setToken(loadSessionToken());
  }, []);
  // Braces matter: Chrome's scrollIntoView now returns a Promise, and an effect
  // that returns one hands React a non-function "cleanup" — the page crashed on
  // the first command.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lines]);

  const print = (...ls: Line[]) => setLines((prev) => [...prev, ...ls]);
  const out = (text: string) => print({ kind: "out", text });
  const err = (text: string) => print({ kind: "err", text });

  function help() {
    out("Commands — each one calls the real endpoint and prints its real response:");
    for (const c of commands) {
      out(
        `  ${c.cmd} ${c.args.map((a, i) => (i === 0 ? `<${a}>` : `[${a}]`)).join(" ")}`.padEnd(34) +
          `→ ${c.service} (${c.price}${c.freeEligible ? ", 1 free call/day without a token" : ", paid only"})`,
      );
    }
    out(`  quote <template> <inputs…>        → price a workflow (nothing charged)`);
    out(`  run <template> <inputs…>          → run a workflow on your credit token`);
    out(`  templates                         → list workflow templates`);
    out(`  token <ck_…> | token clear        → set/clear your credit token (this tab only)`);
    out(`  balance                           → your credit balance`);
    out(`  clear                             → clear the screen`);
    out(`Templates: ${templates.map((t) => `${t.id} ${t.inputs.map((i) => (i.required ? `<${i.name}>` : `[${i.name}]`)).join(" ")}`).join(" · ")}`);
  }

  async function printResponse(res: Response) {
    const paid = res.headers.get("x-paid-via");
    const free = res.headers.get("x-free-tier");
    const preview = res.headers.get("x-preview");
    const bal = res.headers.get("x-credit-balance");
    const tags = [
      `HTTP ${res.status}`,
      paid ? `paid via ${paid}` : null,
      free ? "free tier" : null,
      preview ? "preview (free call already used today)" : null,
      bal ? `credit balance ${(Number(bal) / 100).toFixed(2)} USD` : null,
    ].filter(Boolean);
    out(tags.join(" · "));
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      err("(response was not JSON)");
      return;
    }
    const decision = decisionOf(body);
    if (decision) out(`decision: ${decision}`);
    print({ kind: "json", text: JSON.stringify(body, null, 2) });
  }

  async function callService(c: TerminalCommand, values: string[]) {
    if (!values[0]) return err(`usage: ${c.cmd} <${c.args[0]}>${c.args[1] ? ` [${c.args[1]}]` : ""}`);
    const qs = new URLSearchParams();
    c.args.forEach((a, i) => values[i] && qs.set(a, values[i]));
    const headers: Record<string, string> = {};
    if (token) headers["x-credit-token"] = token;
    else if (c.freeEligible) qs.set("free", "1");
    else
      return err(
        `${c.service} is paid only (${c.price}). Set a prepaid credit token first: token ck_…  (buy one at /credits). Nothing was called.`,
      );
    out(`GET /api/x402/${c.service}?${qs.toString()}${token ? `  (x-credit-token ${maskToken(token)})` : ""}`);
    await printResponse(await fetch(`/api/x402/${c.service}?${qs.toString()}`, { headers }));
  }

  async function workflow(dryRun: boolean, args: string[]) {
    const t = templates.find((x) => x.id === args[0]);
    if (!t) return err(`unknown template ${JSON.stringify(args[0] ?? "")}. Known: ${templates.map((x) => x.id).join(", ")}`);
    const inputVals: Record<string, string> = {};
    t.inputs.forEach((i, n) => {
      if (args[n + 1]) inputVals[i.name] = args[n + 1];
    });
    if (!dryRun && !token) return err("A workflow is paid from your credit token: token ck_… first (buy one at /credits). Nothing was called.");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers["x-credit-token"] = token;
    out(`POST /api/workflows/run ${JSON.stringify({ template: t.id, input: inputVals, ...(dryRun ? { dryRun: true } : {}) })}`);
    const res = await fetch("/api/workflows/run", { method: "POST", headers, body: JSON.stringify({ template: t.id, input: inputVals, dryRun }) });
    let body: Record<string, unknown> | null = null;
    try {
      body = await res.json();
    } catch {
      return err(`HTTP ${res.status} (response was not JSON)`);
    }
    out(`HTTP ${res.status}`);
    const steps = (body?.steps as Array<Record<string, unknown>> | undefined) ?? [];
    for (const s of steps) {
      out(
        `  ${s.index}. ${s.service}: ${s.status}${s.httpStatus ? ` (HTTP ${s.httpStatus})` : ""} · charged $${Number(s.chargedUsd ?? 0).toFixed(3)}${s.decision ? ` · decision ${s.decision}` : ""}${s.error ? ` · ${s.error}` : ""}`,
      );
    }
    if (typeof body?.totalChargedUsd === "number") out(`total charged: $${body.totalChargedUsd.toFixed(3)}`);
    print({ kind: "json", text: JSON.stringify(body, null, 2) });
  }

  async function exec(raw: string) {
    const line = raw.trim();
    if (!line) return;
    print({ kind: "in", text: `> ${line.startsWith("token ck_") ? `token ${maskToken(line.slice(6).trim())}` : line}` });
    setHistory((h) => [line, ...h].slice(0, 50));
    setHistIdx(-1);
    const [cmd, ...args] = line.split(/\s+/);
    const c = commands.find((x) => x.cmd === cmd.toLowerCase());
    try {
      if (c) return await callService(c, args);
      switch (cmd.toLowerCase()) {
        case "help":
          return help();
        case "clear":
          return setLines([]);
        case "token": {
          if (!args[0]) return out(token ? `token: ${maskToken(token)} (this tab only)` : "no token set");
          if (args[0] === "clear") {
            saveSessionToken("");
            setToken("");
            return out("token cleared");
          }
          if (!CREDIT_TOKEN_RE.test(args[0])) return err("that is not a credit token (ck_ followed by 36 hex characters)");
          saveSessionToken(args[0]);
          setToken(args[0]);
          return out(`token set: ${maskToken(args[0])} — kept in this tab's sessionStorage only`);
        }
        case "balance": {
          if (!token) return err("no token set — token ck_…");
          return await printResponse(await fetch("/api/credits/balance", { headers: { "x-credit-token": token } }));
        }
        case "templates":
          return await printResponse(await fetch("/api/workflows"));
        case "quote":
          return await workflow(true, args);
        case "run":
          return await workflow(false, args);
        default:
          return err(`unknown command ${JSON.stringify(cmd)} — type help`);
      }
    } catch (e) {
      err(`request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const v = input;
    setInput("");
    setBusy(true);
    await exec(v);
    setBusy(false);
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowUp" && history.length) {
      e.preventDefault();
      const i = Math.min(histIdx + 1, history.length - 1);
      setHistIdx(i);
      setInput(history[i]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const i = histIdx - 1;
      setHistIdx(i);
      setInput(i >= 0 ? history[i] : "");
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Terminal</h1>
        <p className="text-sm opacity-75 mt-1">
          Every command calls the real endpoint and prints its real response. Without a token, services that offer it use
          the free tier (one call per day per service, then a preview); paid-only services need a{" "}
          <Link href="/credits" className="underline">
            prepaid credit token
          </Link>
          , which is debited exactly as a direct call would be. The token stays in this tab&apos;s sessionStorage.
          {" "}Multi-step runs: <Link href="/workflows" className="underline">/workflows</Link>.
        </p>
        <p className="text-xs opacity-60 mt-1">{token ? `Credit token: ${maskToken(token)}` : "No credit token set."}</p>
      </div>
      <div className="rounded-xl border border-slate-700 bg-slate-950 text-slate-100 font-mono text-xs sm:text-sm p-3 h-[60vh] overflow-auto">
        {lines.length === 0 && <div className="opacity-60">Type help. Example: price 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913</div>}
        {lines.map((l, i) =>
          l.kind === "json" ? (
            <pre key={i} className="whitespace-pre-wrap break-all text-slate-300 my-1">
              {l.text}
            </pre>
          ) : (
            <div
              key={i}
              className={`whitespace-pre-wrap break-all ${l.kind === "in" ? "text-cyan-300" : l.kind === "err" ? "text-red-400" : "text-slate-200"}`}
            >
              {l.text}
            </div>
          ),
        )}
        {busy && <div className="opacity-60">waiting for the endpoint…</div>}
        <div ref={endRef} />
      </div>
      <form onSubmit={submit} className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          placeholder="risk 0x…   ·   run pre-buy 0x… 500   ·   help"
          className="flex-1 rounded-lg border border-slate-600 bg-slate-900 text-slate-100 font-mono px-3 py-2"
        />
        <button type="submit" disabled={busy} className="rounded-lg bg-cyan-600 text-white px-4 py-2 font-semibold disabled:opacity-50">
          Run
        </button>
      </form>
    </div>
  );
}
