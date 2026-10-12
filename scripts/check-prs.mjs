import { execSync } from "node:child_process";

const PRS = [
  {
    name: "Coinbase AgentKit",
    repo: "coinbase/agentkit",
    number: 1557,
    url: "https://github.com/coinbase/agentkit/pull/1557",
  },
  {
    name: "ElizaOS Ecosystem (Awesome Eliza)",
    repo: "thejoven/awesome-eliza",
    number: 40,
    url: "https://github.com/thejoven/awesome-eliza/pull/40",
  },
];

console.log("\n========================================================");
console.log("   🚀 x402 BAZAAR — PR STATUS & COMPLIANCE MONITOR");
console.log("========================================================\n");

for (const pr of PRS) {
  try {
    const raw = execSync(
      `gh pr view ${pr.url} --json number,title,state,mergeable,statusCheckRollup,reviews,comments`,
      { encoding: "utf-8" }
    );
    const data = JSON.parse(raw);

    console.log(`📌 [${pr.name}] PR #${data.number}`);
    console.log(`   🔗 URL:        ${pr.url}`);
    console.log(`   📝 Title:      ${data.title}`);
    console.log(`   ⚡ State:      ${data.state}`);
    console.log(`   🔀 Mergeable:  ${data.mergeable}`);

    // Checks
    if (data.statusCheckRollup && data.statusCheckRollup.length > 0) {
      console.log("   🛡️ CI Checks:");
      for (const check of data.statusCheckRollup) {
        const name = check.name || check.context || "Check";
        const status = check.conclusion || check.state || check.status;
        const icon = status === "SUCCESS" ? "✅" : status === "PENDING" ? "🟡" : "❌";
        console.log(`      ${icon} ${name}: ${status}`);
      }
    } else {
      console.log("   🛡️ CI Checks:   No CI checks required / none configured.");
    }

    // Reviews & Comments
    console.log(`   💬 Comments:   ${data.comments?.length || 0}`);
    console.log(`   👀 Reviews:    ${data.reviews?.length || 0}`);
    console.log("--------------------------------------------------------\n");
  } catch (err) {
    console.error(`❌ Failed to fetch status for ${pr.name}:`, err.message);
  }
}
