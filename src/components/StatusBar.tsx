"use client";

import { useEffect, useState } from "react";

export interface StatusInfo {
  network: string;
  appBuilderCode: string;
  clientBuilderCode: string;
  seller: { ok: boolean };
  buyer: { ok: boolean };
  buyerEnabled: boolean;
  buyTokenRequired: boolean;
  kv?: boolean;
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

export default function StatusBar({ status }: { status: StatusInfo | null }) {
  if (!status) {
    return <div className="card animate-pulse px-4 py-3 text-xs text-gray-500">Loading…</div>;
  }

  // Public-safe strip: live status + Builder Code (attribution transparency).
  // Internal details (payTo, buyer wallet, facilitator, env readiness) are not shown.
  return (
    <div className="card flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 text-xs">
      <span className="pill">
        <span className="h-2 w-2 rounded-full bg-emerald-400" />
        Live on Base mainnet
      </span>
      <span className="text-gray-400">
        Builder Code <code className="codechip">{status.appBuilderCode}</code>
      </span>
      <span className="text-gray-500">Payments attributed onchain (ERC-8021)</span>
    </div>
  );
}
