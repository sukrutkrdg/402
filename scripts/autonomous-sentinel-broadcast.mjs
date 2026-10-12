/**
 * autonomous-sentinel-broadcast.mjs
 *
 * Standalone runner for the x402 Bazaar Autonomous Sentinel.
 * Scans recent intercepts on Base and prints or dispatches viral alert broadcasts.
 */

async function runSentinel() {
  console.log("\n========================================================");
  console.log("   🛡️ x402 BAZAAR — AUTONOMOUS SENTINEL BROADCASTER");
  console.log("========================================================\n");

  try {
    const res = await fetch("https://402.com.tr/api/sentinel/alerts");
    let data;
    if (res.ok) {
      data = await res.json();
    } else {
      // Local fallback if offline
      data = {
        status: "LOCAL_SIMULATION",
        builderCode: "bc_pa0gqlv1",
        alerts: [
          {
            type: "HONEYPOT_DETECTED",
            tokenSymbol: "BASEPEPE",
            tokenAddress: "0x892a0e28e461a293bf71cb0a8163f918bb194411",
            preventedLossUsd: 42500,
            broadcastPayload: {
              farcasterCast: "🚨 RUG INTERCEPT: $BASEPEPE (0x892a...4411) flagged as 99.8% sell-tax honeypot on @base.\nProof: https://402.com.tr/app?token=0x892a0e28e461a293bf71cb0a8163f918bb194411",
              xTweet: "🚨 RUG ALERT on @base: Token $BASEPEPE flagged by x402 Bazaar Autonomous Sentinel.\nSell Tax: 99.8% | Est. Loss Prevented: ~$42,500\nProof: https://402.com.tr/app?token=0x892a0e28e461a293bf71cb0a8163f918bb194411",
            },
          },
        ],
      };
    }

    console.log(`📡 Status:      ${data.status}`);
    console.log(`🔵 Builder Code:${data.builderCode}`);
    console.log(`🚨 Total Alerts: ${data.alerts?.length || 0}\n`);

    for (const alert of data.alerts || []) {
      console.log(`--------------------------------------------------------`);
      console.log(`⚠️  [${alert.type}] $${alert.tokenSymbol}`);
      console.log(`📍 Contract:   ${alert.tokenAddress}`);
      console.log(`🛡️  Loss Saved: $${alert.preventedLossUsd?.toLocaleString()}`);
      console.log(`\n📢 [Farcaster Cast Copy]:`);
      console.log(alert.broadcastPayload?.farcasterCast);
      console.log(`\n🐦 [X / Twitter Tweet Copy]:`);
      console.log(alert.broadcastPayload?.xTweet);
      console.log(`--------------------------------------------------------\n`);
    }

    console.log("✅ Sentinel scan complete. Ready for social broadcast.");
  } catch (err) {
    console.error("❌ Sentinel broadcast check failed:", err.message);
  }
}

runSentinel();
