/**
 * PR freshness guard — are our open listing/plugin PRs still telling the truth?
 *
 * Every open PR that describes the catalog goes stale as services ship. This
 * pulls the LIVE facts (visible service count, B20 suite size, npm version) and
 * diffs them against the claims inside each PR branch's files. Run after every
 * service wave (or whenever): `node scripts/pr-freshness.mjs`
 * Exit 1 if anything is stale — then push a refresh commit to that PR branch.
 */

const RAW = "https://raw.githubusercontent.com";

async function liveFacts() {
  const cat = await (await fetch("https://402.com.tr/api/catalog")).json();
  const services = cat.services ?? [];
  const visible = services.length;
  const b20 = services.filter((s) => (s.category ?? "") === "B20").length;
  const npm = await (await fetch("https://registry.npmjs.org/x402-bazaar-mcp/latest")).json();
  return { visible, b20, npmVersion: npm.version ?? "?" };
}

async function fileText(repo, branch, path) {
  const r = await fetch(`${RAW}/${repo}/${branch}/${path}`);
  if (!r.ok) return null;
  return await r.text();
}

const results = [];
function check(pr, name, ok, detail) {
  results.push({ pr, name, ok, detail });
}

const facts = await liveFacts();
console.log(`LIVE FACTS: ${facts.visible} visible services | ${facts.b20} B20 tools | npm v${facts.npmVersion}\n`);

// --- base/skills#129 ---
{
  const pr = "base/skills#129";
  const plugin = await fileText("sukrutkrdg/skills", "master", "skills/base-mcp/plugins/x402-bazaar.md");
  const skill = await fileText("sukrutkrdg/skills", "master", "skills/base-mcp/SKILL.md");
  if (!plugin || !skill) check(pr, "fetch", false, "PR branch files unreachable");
  else {
    const m = plugin.match(/(\d+)\+ read-only/);
    const claimed = m ? Number(m[1]) : 0;
    check(pr, "service count", facts.visible - claimed < 10, `claims "${claimed}+", live ${facts.visible} (refresh at +10 drift)`);
    const b = plugin.match(/~(\d+) tools\)/);
    const b20Claimed = b ? Number(b[1]) : 0;
    check(pr, "B20 suite size", facts.b20 - b20Claimed < 5, `claims "~${b20Claimed}", live ${facts.b20}`);
    check(pr, "7702 mention", /wallet_delegation/.test(plugin), "plugin doc names wallet_delegation");
    check(pr, "SKILL.md row", /B20 freeze\/seize suite/.test(skill), "our SKILL.md row mentions the B20 suite");
  }
}

// --- xpaysh/awesome-x402#871 ---
{
  const pr = "awesome-x402#871";
  const readme = await fileText("sukrutkrdg/awesome-x402", "add-x402-bazaar", "README.md");
  if (!readme) check(pr, "fetch", false, "PR branch README unreachable");
  else {
    const line = readme.split("\n").find((l) => l.includes("(https://402.com.tr)")) ?? "";
    check(pr, "entry exists", line.length > 0, "our line is present");
    check(pr, "B20 hook", /B20/.test(line), "entry mentions B20 (the differentiator)");
    const m = line.match(/(\d+)\+/);
    if (m) check(pr, "service count", facts.visible - Number(m[1]) < 15, `claims "${m[1]}+", live ${facts.visible}`);
  }
}

// --- punkpeye/awesome-mcp-servers#10291 ---
{
  const pr = "awesome-mcp-servers#10291";
  const readme = await fileText("sukrutkrdg/awesome-mcp-servers", "add-x402-bazaar-mcp", "README.md");
  if (!readme) check(pr, "fetch", false, "PR branch README unreachable");
  else {
    const line = readme.split("\n").find((l) => l.includes("x402-bazaar-mcp](https://github.com/sukrutkrdg")) ?? "";
    check(pr, "entry exists", line.length > 0, "our line is present");
    check(pr, "Glama badge", /glama\.ai\/mcp\/servers\/sukrutkrdg/.test(line), "score badge present (bot requirement)");
    check(pr, "B20 hook", /B20/.test(line), "entry mentions B20");
    const m = line.match(/(\d+)\+/);
    if (m) check(pr, "service count", facts.visible - Number(m[1]) < 15, `claims "${m[1]}+", live ${facts.visible}`);
  }
}

// --- game-by-virtuals/game-node#157 (dormant repo — existence check only) ---
{
  const pr = "game-node#157";
  const pkg = await fileText("sukrutkrdg/game-node", "main", "plugins/x402BazaarPlugin/package.json");
  check(pr, "branch alive", pkg !== null, pkg === null ? "plugin path missing on fork main (check manually)" : "fork branch intact (repo dormant — low priority)");
}

let stale = 0;
for (const r of results) {
  if (!r.ok) stale++;
  console.log(`${r.ok ? "PASS " : "STALE"}  ${r.pr}  ${r.name} — ${r.detail}`);
}
console.log(stale ? `\n${stale} STALE check(s) — push refresh commits to those PR branches.` : "\nAll open PRs are current.");
process.exit(stale ? 1 : 0);
