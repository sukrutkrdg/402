/**
 * Brand artwork rendered to PNG via `next/og` (Satori). Used by:
 *  - /icon and /opengraph-image (site favicon + social card)
 *  - /brand/icon (1024²) and /brand/thumbnail (1200×630) for Base App uploads
 *
 * Keep styles within Satori's flexbox subset and use ASCII text so the default
 * font renders cleanly.
 */

/** Square app icon. `px` keeps the type/effects scaling with the canvas size. */
export function iconArt(px: number) {
  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(140deg, #0a3cff 0%, #0052ff 46%, #2b7bff 100%)",
      }}
    >
      {/* top-left light sheen */}
      <div
        style={{
          position: "absolute",
          top: -px * 0.26,
          left: -px * 0.22,
          width: px * 0.85,
          height: px * 0.85,
          borderRadius: 9999,
          display: "flex",
          background:
            "radial-gradient(circle at center, rgba(255,255,255,0.5), rgba(255,255,255,0) 62%)",
        }}
      />
      {/* bottom-right depth shadow */}
      <div
        style={{
          position: "absolute",
          bottom: -px * 0.3,
          right: -px * 0.3,
          width: px * 0.9,
          height: px * 0.9,
          borderRadius: 9999,
          display: "flex",
          background:
            "radial-gradient(circle at center, rgba(0,18,70,0.55), rgba(0,18,70,0) 60%)",
        }}
      />
      {/* coin medallion */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: px * 0.66,
          height: px * 0.66,
          borderRadius: 9999,
          background: "linear-gradient(160deg, #ffffff 0%, #cfddff 100%)",
          border: `${px * 0.022}px solid rgba(255,255,255,0.85)`,
          boxShadow: `0 ${px * 0.03}px ${px * 0.07}px rgba(0,0,30,0.45), inset 0 ${px * 0.016}px ${px * 0.03}px rgba(255,255,255,0.95), inset 0 -${px * 0.022}px ${px * 0.045}px rgba(0,42,150,0.28)`,
        }}
      >
        <div
          style={{
            display: "flex",
            fontSize: px * 0.3,
            fontWeight: 800,
            color: "#0046e6",
            letterSpacing: -px * 0.008,
          }}
        >
          402
        </div>
      </div>
    </div>
  );
}

// ─── 1284×2778 App-Store-style promo screens ───────────────────────────────

const SCREEN_BG = {
  width: "100%",
  height: "100%",
  display: "flex",
  flexDirection: "column" as const,
  padding: 96,
  background: "#07080a",
  backgroundImage: "radial-gradient(1300px 1000px at 50% -8%, rgba(0,82,255,0.42), transparent 60%)",
  color: "#e7eaf0",
};

function brandRow() {
  return (
    <div style={{ display: "flex", alignItems: "center", marginBottom: 28 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 92,
          height: 92,
          borderRadius: 24,
          marginRight: 26,
          background: "linear-gradient(135deg, #0052ff, #0036aa)",
          fontSize: 40,
          fontWeight: 800,
          color: "#fff",
        }}
      >
        402
      </div>
      <div style={{ display: "flex", fontSize: 46, fontWeight: 700 }}>x402 Bazaar</div>
    </div>
  );
}

/** Screen 1 — hero. */
export function screenHero() {
  return (
    <div style={SCREEN_BG}>
      {brandRow()}
      <div style={{ display: "flex", flexGrow: 1 }} />
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 80 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 560,
            height: 560,
            borderRadius: 9999,
            background: "linear-gradient(160deg, #ffffff, #cfddff)",
            boxShadow:
              "0 34px 90px rgba(0,36,150,0.55), inset 0 16px 32px rgba(255,255,255,0.9), inset 0 -22px 52px rgba(0,42,150,0.3)",
          }}
        >
          <div style={{ display: "flex", fontSize: 196, fontWeight: 800, color: "#0046e6", letterSpacing: -4 }}>
            x402
          </div>
        </div>
      </div>
      <div style={{ display: "flex", fontSize: 100, fontWeight: 800, lineHeight: 1.07 }}>
        Pay-per-call APIs, paid in USDC on Base.
      </div>
      <div style={{ display: "flex", fontSize: 46, color: "#aab4c5", marginTop: 36, lineHeight: 1.32 }}>
        Call an API, pay a tiny micro-payment over x402, get your result instantly — no keys, no
        subscriptions.
      </div>
      <div style={{ display: "flex", flexGrow: 1 }} />
      <div style={{ display: "flex" }}>
        {["x402 protocol", "USDC on Base", "Builder Codes"].map((t) => (
          <div
            key={t}
            style={{
              display: "flex",
              marginRight: 20,
              border: "1px solid #1f232b",
              background: "rgba(255,255,255,0.05)",
              borderRadius: 999,
              padding: "18px 30px",
              fontSize: 33,
              color: "#cdd5e0",
            }}
          >
            {t}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Screen 2 — marketplace. */
export function screenMarket() {
  const items = [
    { tag: "Markets", name: "Market Snapshot", price: "$0.001", desc: "Live-style price board for top crypto assets.", c: "#0052ff" },
    { tag: "Data", name: "Weather Oracle", price: "$0.001", desc: "Current conditions for any city.", c: "#16a34a" },
    { tag: "Utility", name: "Secure Token", price: "$0.002", desc: "Cryptographically strong random IDs.", c: "#a855f7" },
    { tag: "Fun", name: "Alpha Quote", price: "$0.001", desc: "One sharp line of market wisdom.", c: "#f59e0b" },
  ];
  return (
    <div style={SCREEN_BG}>
      {brandRow()}
      <div style={{ display: "flex", flexGrow: 1 }} />
      <div style={{ display: "flex", fontSize: 30, fontWeight: 700, letterSpacing: 6, color: "#7e8aa0", marginTop: 20 }}>
        MARKETPLACE
      </div>
      <div style={{ display: "flex", fontSize: 84, fontWeight: 800, lineHeight: 1.08, marginTop: 14 }}>
        Real, paid API endpoints.
      </div>
      <div style={{ display: "flex", fontSize: 42, color: "#aab4c5", marginTop: 22 }}>
        Each call settles a USDC payment on Base.
      </div>
      <div style={{ display: "flex", flexDirection: "column", marginTop: 56 }}>
        {items.map((it) => (
          <div
            key={it.name}
            style={{
              display: "flex",
              alignItems: "center",
              border: "1px solid #1f232b",
              background: "rgba(17,19,23,0.8)",
              borderRadius: 32,
              padding: 44,
              marginBottom: 30,
            }}
          >
            <div style={{ display: "flex", width: 84, height: 84, borderRadius: 22, marginRight: 36, background: it.c }} />
            <div style={{ display: "flex", flexDirection: "column", flexGrow: 1 }}>
              <div style={{ display: "flex", fontSize: 50, fontWeight: 700 }}>{it.name}</div>
              <div style={{ display: "flex", fontSize: 36, color: "#8b95a7", marginTop: 8 }}>{it.desc}</div>
            </div>
            <div style={{ display: "flex", fontSize: 50, fontWeight: 800, color: "#34d399", marginLeft: 24 }}>
              {it.price}
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", flexGrow: 1 }} />
      <div style={{ display: "flex", fontSize: 34, color: "#6b7484" }}>
        No API keys. No sign-ups. Pay only for what you call.
      </div>
    </div>
  );
}

/** Screen 3 — onchain attribution. */
export function screenAttribution() {
  const rows = [
    { k: "a", label: "App (your endpoint)", v: "bc_0438m5ng" },
    { k: "w", label: "Wallet (facilitator)", v: "cdp_facil1" },
    { k: "s", label: "Service (client)", v: "bc_0438m5ng" },
  ];
  return (
    <div style={SCREEN_BG}>
      {brandRow()}
      <div style={{ display: "flex", flexGrow: 1 }} />
      <div style={{ display: "flex", fontSize: 30, fontWeight: 700, letterSpacing: 6, color: "#7e8aa0", marginTop: 20 }}>
        ONCHAIN ATTRIBUTION
      </div>
      <div style={{ display: "flex", fontSize: 84, fontWeight: 800, lineHeight: 1.08, marginTop: 14 }}>
        Every payment, attributed onchain.
      </div>
      <div style={{ display: "flex", fontSize: 42, color: "#aab4c5", marginTop: 22 }}>
        Builder Codes (ERC-8021) are written into the settlement calldata.
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          marginTop: 64,
          border: "1px solid #1f232b",
          background: "rgba(17,19,23,0.85)",
          borderRadius: 36,
          padding: 56,
        }}
      >
        {rows.map((r) => (
          <div key={r.k} style={{ display: "flex", alignItems: "center", marginBottom: 40 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 80,
                height: 80,
                borderRadius: 18,
                marginRight: 34,
                background: "rgba(0,82,255,0.18)",
                color: "#4d8bff",
                fontSize: 44,
                fontWeight: 800,
              }}
            >
              {r.k}
            </div>
            <div style={{ display: "flex", fontSize: 40, color: "#aab4c5", flexGrow: 1 }}>{r.label}</div>
            <div
              style={{
                display: "flex",
                fontSize: 40,
                fontWeight: 700,
                color: "#7dd3fc",
                background: "rgba(0,0,0,0.4)",
                border: "1px solid #1f232b",
                borderRadius: 14,
                padding: "10px 22px",
              }}
            >
              {r.v}
            </div>
          </div>
        ))}
        <div style={{ display: "flex", alignItems: "center", marginTop: 16 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              borderRadius: 999,
              padding: "16px 30px",
              background: "rgba(16,185,129,0.14)",
              border: "1px solid rgba(16,185,129,0.4)",
              color: "#34d399",
              fontSize: 36,
              fontWeight: 700,
            }}
          >
            Verified on Base mainnet
          </div>
        </div>
      </div>

      <div style={{ display: "flex", flexGrow: 1 }} />
      <div style={{ display: "flex", fontSize: 34, color: "#6b7484" }}>
        Paste any settlement tx hash in the dashboard to decode a / w / s — no trust, all onchain.
      </div>
    </div>
  );
}

/** 1200×630 thumbnail / social card. */
export function thumbArt() {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: 80,
        background: "#07080a",
        backgroundImage:
          "radial-gradient(1000px 520px at 82% -18%, rgba(0,82,255,0.38), transparent 60%)",
        color: "#e7eaf0",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", marginBottom: 34 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 84,
            height: 84,
            borderRadius: 20,
            marginRight: 24,
            background: "linear-gradient(135deg, #0052ff, #0036aa)",
            fontSize: 34,
            fontWeight: 800,
            color: "#ffffff",
          }}
        >
          x4
        </div>
        <div style={{ display: "flex", fontSize: 28, fontWeight: 600, color: "#7e8aa0", letterSpacing: 4 }}>
          BUILDER CODES · BASE
        </div>
      </div>

      <div style={{ display: "flex", fontSize: 86, fontWeight: 800, lineHeight: 1.05 }}>x402 Bazaar</div>
      <div style={{ display: "flex", fontSize: 38, color: "#aab4c5", marginTop: 20 }}>
        Pay-per-call APIs on Base, attributed onchain.
      </div>

      <div style={{ display: "flex", marginTop: 42 }}>
        {["USDC micro-payments", "x402 protocol", "ERC-8021 attribution"].map((t) => (
          <div
            key={t}
            style={{
              display: "flex",
              marginRight: 16,
              border: "1px solid #1f232b",
              background: "rgba(255,255,255,0.05)",
              borderRadius: 999,
              padding: "12px 22px",
              fontSize: 26,
              color: "#cdd5e0",
            }}
          >
            {t}
          </div>
        ))}
      </div>
    </div>
  );
}
