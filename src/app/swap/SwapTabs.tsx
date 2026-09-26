"use client";

import { useState } from "react";
import { Providers } from "../app/providers";
import SwapClient from "./SwapClient";
import BaseSwapClient from "./BaseSwapClient";

/** Two ways to swap: across chains by deposit address, or on Base with a connected wallet. */
export default function SwapTabs() {
  const [tab, setTab] = useState<"cross" | "base">("cross");
  const btn = (on: boolean) =>
    `rounded-xl px-4 py-2 text-sm ${on ? "bg-white/10 font-semibold text-white" : "text-gray-400 hover:text-white"}`;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btn(tab === "cross")} onClick={() => setTab("cross")}>
          Across chains · NEAR Intents
        </button>
        <button type="button" className={btn(tab === "base")} onClick={() => setTab("base")}>
          On Base · connect wallet
        </button>
      </div>
      {tab === "cross" ? (
        <SwapClient />
      ) : (
        <Providers>
          <BaseSwapClient />
        </Providers>
      )}
    </div>
  );
}
