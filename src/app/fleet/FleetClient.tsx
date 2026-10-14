"use client";

import { useState } from "react";

interface Child {
  id: string;
  label: string;
  status: "active" | "paused";
  dailyCapUsd: number;
  perCallMaxUsd: number | null;
  allow: string[] | null;
  createdAt: string;
  spentTodayUsd: number;
}

const TOKEN_SHAPE = /^ck_[0-9a-f]{36}$/;

/**
 * Manages a fleet against the real endpoints. The parent token lives in React
 * state only — not localStorage, not sessionStorage, not the URL — and goes out
 * only as the `x-credit-token` header to our own /api/credits/fleet.
 */
export default function FleetClient({ serviceIds }: { serviceIds: string[] }) {
  const [token, setToken] = useState("");
  const [children, setChildren] = useState<Child[] | null>(null);
  const [day, setDay] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ token: string; label: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const [label, setLabel] = useState("");
  const [cap, setCap] = useState("1.00");
  const [perCall, setPerCall] = useState("");
  const [allow, setAllow] = useState("");

  async function api(path: string, init: { method?: string; body?: unknown } = {}) {
    const res = await fetch(path, {
      method: init.method ?? "GET",
      headers: { "x-credit-token": token.trim(), ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((json as { error?: string }).error || `Request failed (${res.status})`);
    return json;
  }

  async function load() {
    setBusy("load");
    setError(null);
    try {
      const j = (await api("/api/credits/fleet")) as { children: Child[]; day: string };
      setChildren(j.children);
      setDay(j.day);
    } catch (e) {
      setChildren(null);
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy("create");
    setError(null);
    try {
      const body: Record<string, unknown> = { label: label.trim(), dailyCapUsd: Number(cap) };
      if (perCall.trim()) body.perCallMaxUsd = Number(perCall);
      const ids = allow.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
      if (ids.length) body.allow = ids;
      const j = (await api("/api/credits/fleet", { method: "POST", body })) as { childToken: string; child: Child };
      setIssued({ token: j.childToken, label: j.child.label });
      setCopied(false);
      setLabel("");
      setPerCall("");
      setAllow("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function setStatus(c: Child, status: "active" | "paused") {
    setBusy(c.id);
    setError(null);
    try {
      await api(`/api/credits/fleet/${c.id}`, { method: "PATCH", body: { status } });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function remove(c: Child) {
    if (!window.confirm(`Delete "${c.label}"? Its token stops working on its next call and cannot be restored.`)) return;
    setBusy(c.id);
    setError(null);
    try {
      await api(`/api/credits/fleet/${c.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const tokenOk = TOKEN_SHAPE.test(token.trim());

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3 rounded-2xl border border-base-line bg-black/30 p-5">
        <h2 className="text-lg font-semibold">Your parent credit token</h2>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              setChildren(null);
              setIssued(null);
            }}
            placeholder="ck_…"
            className="flex-1 rounded-lg border border-base-line bg-black/40 px-3 py-2 font-mono text-sm"
          />
          <button
            onClick={load}
            disabled={!tokenOk || busy !== null}
            className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            {busy === "load" ? "Loading…" : "Open fleet"}
          </button>
        </div>
        {token && !tokenOk && <p className="text-xs text-amber-300">A credit token looks like ck_ followed by 36 hex characters.</p>}
      </section>

      {error && <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</p>}

      {issued && (
        <section className="flex flex-col gap-2 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-5">
          <h2 className="text-sm font-semibold text-amber-200">Token for “{issued.label}” — shown once</h2>
          <code className="break-all rounded bg-black/50 px-3 py-2 text-sm text-amber-100">{issued.token}</code>
          <div className="flex gap-2">
            <button
              onClick={() => {
                navigator.clipboard?.writeText(issued.token).then(() => setCopied(true), () => setCopied(false));
              }}
              className="rounded-lg border border-amber-500/40 px-3 py-1 text-xs text-amber-100"
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button onClick={() => setIssued(null)} className="rounded-lg border border-base-line px-3 py-1 text-xs text-gray-300">
              I saved it
            </button>
          </div>
          <p className="text-xs text-amber-200/80">
            Only a hash is stored. Give it to the agent as its <code>x-credit-token</code> header.
          </p>
        </section>
      )}

      {children && (
        <>
          <section className="flex flex-col gap-3 rounded-2xl border border-base-line bg-black/30 p-5">
            <h2 className="text-lg font-semibold">Children</h2>
            {children.length === 0 ? (
              <p className="text-sm text-gray-400">No child tokens yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs uppercase text-gray-500">
                    <tr>
                      <th className="py-2 pr-3">Label</th>
                      <th className="py-2 pr-3">Status</th>
                      <th className="py-2 pr-3">Spent today / cap</th>
                      <th className="py-2 pr-3">Per call</th>
                      <th className="py-2 pr-3">Allowed</th>
                      <th className="py-2 pr-3"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {children.map((c) => (
                      <tr key={c.id} className="border-t border-base-line">
                        <td className="py-2 pr-3">
                          <div className="font-medium text-gray-200">{c.label}</div>
                          <div className="font-mono text-[10px] text-gray-500">{c.id}</div>
                        </td>
                        <td className={`py-2 pr-3 ${c.status === "paused" ? "text-amber-300" : "text-emerald-300"}`}>{c.status}</td>
                        <td className="py-2 pr-3 font-mono">
                          ${c.spentTodayUsd.toFixed(3)} / ${c.dailyCapUsd.toFixed(3)}
                        </td>
                        <td className="py-2 pr-3 font-mono">{c.perCallMaxUsd === null ? "any" : `≤ $${c.perCallMaxUsd.toFixed(3)}`}</td>
                        <td className="py-2 pr-3 text-xs text-gray-400">{c.allow ? c.allow.join(", ") : "all services"}</td>
                        <td className="py-2 pr-3">
                          <div className="flex gap-2">
                            <button
                              disabled={busy !== null}
                              onClick={() => setStatus(c, c.status === "active" ? "paused" : "active")}
                              className="rounded border border-base-line px-2 py-1 text-xs text-gray-200 disabled:opacity-40"
                            >
                              {c.status === "active" ? "Pause" : "Resume"}
                            </button>
                            <button
                              disabled={busy !== null}
                              onClick={() => remove(c)}
                              className="rounded border border-red-500/40 px-2 py-1 text-xs text-red-300 disabled:opacity-40"
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex items-center gap-3 text-xs text-gray-500">
              <span>Spend is for {day} (UTC). Caps reset at 00:00 UTC.</span>
              <button onClick={load} disabled={busy !== null} className="text-sky-400 hover:underline disabled:opacity-40">
                Refresh
              </button>
            </div>
          </section>

          <form onSubmit={create} className="flex flex-col gap-3 rounded-2xl border border-base-line bg-black/30 p-5">
            <h2 className="text-lg font-semibold">New child token</h2>
            <label className="flex flex-col gap-1 text-xs text-gray-400">
              Label
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={60}
                required
                placeholder="research-agent-3"
                className="rounded-lg border border-base-line bg-black/40 px-3 py-2 text-sm text-gray-100"
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs text-gray-400">
                Daily cap (USD, required)
                <input
                  value={cap}
                  onChange={(e) => setCap(e.target.value)}
                  inputMode="decimal"
                  required
                  className="rounded-lg border border-base-line bg-black/40 px-3 py-2 font-mono text-sm text-gray-100"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-gray-400">
                Max price per call (USD, optional)
                <input
                  value={perCall}
                  onChange={(e) => setPerCall(e.target.value)}
                  inputMode="decimal"
                  placeholder="no limit"
                  className="rounded-lg border border-base-line bg-black/40 px-3 py-2 font-mono text-sm text-gray-100"
                />
              </label>
            </div>
            <label className="flex flex-col gap-1 text-xs text-gray-400">
              Allowed services (optional, comma-separated ids — empty means all)
              <input
                value={allow}
                onChange={(e) => setAllow(e.target.value)}
                list="fleet-service-ids"
                placeholder="web-search, hash"
                className="rounded-lg border border-base-line bg-black/40 px-3 py-2 font-mono text-sm text-gray-100"
              />
              <datalist id="fleet-service-ids">
                {serviceIds.map((id) => (
                  <option key={id} value={id} />
                ))}
              </datalist>
            </label>
            <button
              type="submit"
              disabled={busy !== null || !label.trim()}
              className="w-fit rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
            >
              {busy === "create" ? "Creating…" : "Create child token"}
            </button>
          </form>
        </>
      )}
    </div>
  );
}
