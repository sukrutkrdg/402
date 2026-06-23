/**
 * Brand artwork rendered to PNG via `next/og` (Satori). Used by:
 *  - /icon and /opengraph-image (site favicon + social card)
 *  - /brand/icon (1024²) and /brand/thumbnail (1200×630) for Base App uploads
 *
 * Keep styles within Satori's flexbox subset and use ASCII text so the default
 * font renders cleanly.
 */

/** Square app icon. `px` keeps the type scaling with the canvas size. */
export function iconArt(px: number) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(135deg, #0052ff 0%, #0036aa 100%)",
        color: "#ffffff",
      }}
    >
      <div
        style={{
          display: "flex",
          fontSize: px * 0.3,
          fontWeight: 800,
          letterSpacing: -px * 0.012,
        }}
      >
        x402
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
