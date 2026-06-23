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
            fontSize: px * 0.205,
            fontWeight: 800,
            color: "#0046e6",
            letterSpacing: -px * 0.006,
          }}
        >
          x402
        </div>
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
