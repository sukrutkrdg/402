"use client";

import { useEffect, useState } from "react";

export interface StatusInfo {
  network: string;
  appBuilderCode: string;
  clientBuilderCode: string;
  payTo: string | null;
  buyerAddress: string | null;
  seller: { ok: boolean; missing: string[] };
  buyer: { ok: boolean; missing: string[] };
}

export function useStatus() {
  const [status, setStatus] = useState<StatusInfo | null>(null);
  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);
  return status;
}

function short(addr: string | null) {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export default function StatusBar({ status }: { status: StatusInfo | null }) {
  if (!status) {
    return (
      <div className="card animate-pulse px-4 py-3 text-xs text-gray-500">Checking configuration…</div>
    );
  }

  const ready = status.seller.ok && status.buyer.ok;
  return (
    <div className="card flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 text-xs">
      <span className="pill">
        <span className={`h-2 w-2 rounded-full ${ready ? "bg-emerald-400" : "bg-amber-400"}`} />
        {ready ? "Live on Base mainnet" : "Demo mode — finish .env"}
      </span>
      <span className="text-gray-400">
        app <code className="codechip">{status.appBuilderCode}</code> <span className="text-gray-600">(a)</span>
      </span>
      <span className="text-gray-400">
        client <code className="codechip">{status.clientBuilderCode}</code>{" "}
        <span className="text-gray-600">(s)</span>
      </span>
      <span className="text-gray-400">
        facilitator <code className="codechip">cdp_facil</code> <span className="text-gray-600">(w)</span>
      </span>
      <span className="ml-auto text-gray-500">
        payTo <span className="font-mono text-gray-300">{short(status.payTo)}</span> · buyer{" "}
        <span className="font-mono text-gray-300">{short(status.buyerAddress)}</span>
      </span>
    </div>
  );
}
