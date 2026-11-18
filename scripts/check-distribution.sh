#!/usr/bin/env bash
# Daily distribution scoreboard for x402 Bazaar.
# Are our plugins live? Is the hero healthy? Are we in the framework directories yet?
# Usage: bash scripts/check-distribution.sh   (gh optional, used for PR/repo checks)
set -u
PASS=0; FAIL=0
ok(){ printf "  \033[32m✅ %s\033[0m\n" "$1"; PASS=$((PASS+1)); }
bad(){ printf "  \033[31m❌ %s\033[0m\n" "$1"; FAIL=$((FAIL+1)); }
# target: an aspirational goal (framework we want to be in) — not a health failure.
won(){ printf "  \033[32m🏆 %s\033[0m\n" "$1"; }
todo(){ printf "  \033[33m🎯 %s\033[0m\n" "$1"; }
sec(){ printf "\n\033[1m== %s ==\033[0m\n" "$1"; }

TOKEN="0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed" # DEGEN, used as a live probe

sec "Framework plugins (the battleground)"
[ "$(npm view x402-bazaar-agentkit version 2>/dev/null)" != "" ] \
  && ok "npm x402-bazaar-agentkit@$(npm view x402-bazaar-agentkit version 2>/dev/null) (AgentKit)" \
  || bad "x402-bazaar-agentkit NOT on npm"
PYPI_V=$(curl -s https://pypi.org/pypi/langchain-x402bazaar/json | grep -o '"version":"[^"]*"' | head -1 | grep -o '[0-9][0-9.]*')
[ -n "$PYPI_V" ] \
  && ok "PyPI langchain-x402bazaar@$PYPI_V (LangChain)" \
  || bad "langchain-x402bazaar NOT on PyPI"
[ "$(npm view x402-bazaar-mcp version 2>/dev/null)" != "" ] \
  && ok "npm x402-bazaar-mcp (MCP server)" || bad "x402-bazaar-mcp NOT on npm"

sec "Are we in the framework DIRECTORIES yet? (targets, not failures)"
for repo in "coinbase/agentkit" "elizaos/eliza" "crewAIInc/crewAI-tools"; do
  n=$(gh search code --repo "$repo" "x402-bazaar" 2>/dev/null | grep -ci x402 || true)
  if [ "${n:-0}" -gt 0 ] 2>/dev/null; then won "IN $repo"; else todo "not in $repo yet — open a PR"; fi
done

sec "Hero endpoint (token-verdict)"
V=$(curl -s "https://402.com.tr/api/x402/token-verdict?address=$TOKEN&free=1" | grep -o '"verdict":"[^"]*"' | head -1)
[ -n "$V" ] && ok "free call -> ${V}" || bad "free call returned nothing"
A=$(curl -s "https://402.com.tr/api/x402/token-verdict?address=$TOKEN" | grep -o '"amount":"[0-9]*"' | head -1)
[ "$A" = '"amount":"30000"' ] && ok "402 challenge priced \$0.03 ($A)" || bad "402 price wrong: $A"
curl -s "https://402.com.tr/api/x402/token-verdict?address=$TOKEN" | grep -q 'bc_pa0gqlv1' \
  && ok "builder-code attribution in challenge" || bad "builder-code missing from challenge"
curl -s -o /dev/null -w '%{content_type}' "https://402.com.tr/brand/verdict?v=SAFE" | grep -q image/png \
  && ok "verdict share-card renders PNG" || bad "verdict card broken"

sec "Site + listings"
for p in "" app terms privacy agents; do
  c=$(curl -s -o /dev/null -w '%{http_code}' "https://402.com.tr/$p")
  [ "$c" = "200" ] && ok "/$p -> 200" || bad "/$p -> $c"
done
curl -s https://402.com.tr/ | grep -q "one call before every trade" \
  && ok "homepage features token-verdict" || bad "homepage no longer features token-verdict"
[ "$(curl -s -o /dev/null -w '%{http_code}' https://x402-list.com/services/402-com-tr-agent-apis)" = "200" ] \
  && ok "x402-list listing live" || bad "x402-list listing missing"

printf "\n\033[1mHEALTH: %d ✅  /  %d ❌\033[0m   (🎯 items above = growth targets, open a PR)\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && echo "Health all green. Advance one 🎯 target today (see memory: 402-growth-dashboard)." || echo "Fix the ❌ above first — something that was live went down."
