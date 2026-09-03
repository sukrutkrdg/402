/**
 * What an agent sees before it pays: a runnable example call, and a preview of
 * what that call gives back. Both halves feed the x402 discovery declaration
 * (and the 402 challenge body), and both were wrong in ways only visible from
 * the outside.
 *
 * OUTPUT — the live shop window is `sample-cache`: a preview of the last real
 * response, written on a successful serve and read back into `output.example`.
 * It works precisely where it is least needed. An endpoint nobody calls has no
 * sample, so the endpoints that most need a shop window are the ones that
 * advertise nothing; 46 of 131 declared no output at all. A discovery oracle
 * asked in August 2026 to find a rug check listed two of our three matching
 * endpoints as `output_keys: ["input"]` — "returns nothing" — and ranked the
 * one that did have a sample highest of the three. So a static example now
 * ships in source as the FALLBACK, and a live sample still wins when one
 * exists: a real response from today beats a frozen one.
 *
 * Every entry is a real response captured from the live handlers, put through
 * the same preview + redaction as a cached sample (arrays reduced to counts,
 * nested detail dropped, prose withheld — this is the shop window, not the
 * goods), with the "when we ran it" stamps removed so no frozen date can go
 * stale. Five entries are hand-written and marked: their responses are
 * registration or ledger state with no upstream to read from.
 *
 * INPUT — the old rule handed every parameter whose NAME matched
 * /address|token|wallet|contract|owner|spender/ the USDC contract address, and
 * gave every other parameter its UI placeholder. That published 54 examples
 * putting a token contract where a wallet belongs — including USDC, which is
 * not a B20, to all 29 B20 endpoints — and 34 more reading
 * `hash: "0x… 32-byte tx hash"`, an ellipsis rather than a value. An agent that
 * follows such an example gets an error, and it has no reason to come back.
 *
 * The rules below read each parameter's LABEL, which is where the distinction
 * already lives ("Wallet address" vs "B20 token address"), so a parameter added
 * later is classified without anyone remembering this file exists. Explicit
 * overrides carry what a label cannot know, and a parameter we have no real
 * value for is omitted rather than filled with a shape.
 */

/** The parts of a service this module reads. Structural on purpose: a test can
 *  build one without importing the registry, which pulls in every server-only
 *  handler behind it. */
export interface ExampleService {
  id: string;
  category?: string;
  params: readonly { name: string; label: string; placeholder: string; required?: boolean }[];
}

/**
 * A real, redacted response per service — the fallback when KV holds no live
 * sample. Captured 2026-08-09 against the live handlers.
 */
const OUTPUT_EXAMPLES: Record<string, Record<string, unknown>> = {
  "address-trust": {"address":"0x973A31858f4D2125f48C880542DA11a2796f12D6","coinbaseVerified":true,"basename":null,"verdict":"verified","trustScore":70,"signalsCount":1},
  // Hand-shaped rather than preview-generated: `factors` is a nested object, and
  // the preview drops nested detail — which would leave this endpoint advertising
  // a bare verdict. The factor map IS the product, including the entry that did
  // not run and says why, so it is what the shop window has to show.
  "safe-to-send": {"address":"0x973a31858f4d2125f48c880542da11a2796f12d6","verdict":"GO","checkedFactors":4,"skippedFactors":1,"degraded":false,"factors":{"sanctions":{"level":"clear","reason":"Not on the OFAC SDN list"},"identity":{"level":"clear","reason":"Coinbase-verified: an onchain attestation ties this address to a KYC'd account"},"accountType":{"level":"clear","reason":"Wallet with an EIP-7702 delegation — a smart-wallet setup, still an account that signs for itself","type":"eoa_delegated"},"age":{"level":"clear","reason":"Established: first seen on Base 480 days ago","ageDays":480},"upgradeable":{"level":"skipped","reason":"not applicable — the recipient is a wallet, not a contract"}}},
  "ai-contract-risk": {"address":"0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed","dangerLevel":"caution","verified":true,"dangerousCapabilitiesCount":4,"observationsCount":8,"model":"claude-haiku-4-5"},
  "ai-extract": {"model":"claude-haiku-4-5","mode":"single","fieldsCount":5,"truncated":false},
  "ai-extract-batch": {"model":"claude-haiku-4-5","fieldsCount":4,"documentCount":2,"documentsCount":2,"truncated":false},
  "ai-market-brief": {"mood":"risky","highlightsCount":3,"newAndNotableCount":3,"cautionsCount":5,"model":"claude-haiku-4-5"},
  "ai-summarize": {"model":"claude-haiku-4-5","bulletsCount":4,"truncated":false},
  "ai-token-report": {"address":"0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed","verdict":"caution","safetyScore":42,"confidence":"high","factorsCount":6,"risksCount":5,"positivesCount":5,"model":"claude-haiku-4-5"},
  "ai-translate": {"model":"claude-haiku-4-5","to":"Turkish","translation":"Çekiniz işleniyor ve bir iş günü içinde hesabınıza ulaşmalıdır.","truncated":false},
  "ai-tx-explain": {"hash":"0x68fdf10f8eb842afcddf79b2a779ed78e5be35d698e95cee1966f1787eb02b5e","action":"Unknown function call (selector 0xe3ee160e) on USDC contract","plainEnglish":"An autonomous agent called an unknown function (selector 0xe3ee160e) on the USDC token contract (0x833589fcd6edb6e08f4c7c32d4f71b54bda02913) on Base. The transa…","risk":"medium","notesCount":5,"model":"claude-haiku-4-5"},
  "ai-wallet-report": {"address":"0x973a31858f4d2125f48c880542da11a2796f12d6","verdict":"established","observationsCount":7,"model":"claude-haiku-4-5"},
  "b20-access-type": {"address":"0xb20000000000000000000186a08e781c38059eec","isB20":true,"symbol":"NADT","variant":"stablecoin","verdict":"open","scopesCount":0},
  "b20-announcements": {"address":"0xb20000000000000000000042d5ae64abd03d0dca","isB20":true,"variant":"asset","symbol":"SRA2","announcementCount":1,"activeCount":0,"announcementsCount":1,"verdict":"past_notices"},
  "b20-authenticity": {"address":"0xb20000000000000000000186a08e781c38059eeC","prefixLooksB20":true,"factoryConfirms":true,"initialized":true,"hasBytecode":true,"verdict":"genuine"},
  "b20-batch": {"count":2,"worstRiskScore":75,"resultsCount":2},
  "b20-config-audit": {"address":"0xb20000000000000000000186a08e781c38059eec","isB20":true,"symbol":"NADT","variant":"stablecoin","verdict":"clean","transferDead":false,"findingsCount":0,"scopesCount":4},
  "b20-control": {"address":"0xb20000000000000000000186a08e781c38059eeC","isB20":true,"symbol":"NADT","variant":"stablecoin","adminRenounced":false,"distinctControllers":1,"flagsCount":2,"verdict":"issuer_controlled"},
  "b20-dossier": {"address":"0xb20000000000000000000042d5ae64abd03d0dca","isB20":true,"verdict":"avoid","issuerControlScore":15,"seizureRisk":"enforced","powers":"Issuer can seize (burnBlocked), freeze (blocklist), mint, pause, rebase, and gate transfers via allowlist.","whoControls":"Single address 0x8F058fE6b568D97f85d517Ac441b52B95722fDDe holds mint, burn, seize, pause, and metadata roles; admin renounced but operational control is complet…","enforcementHistory":"1 seizure (burnBlocked) recorded on 2026-07-09 — 500000000000000 tokens burned from 0x000000000000000000000000000000000000dEaD, proving the coercive power is ac…","dilutionRisk":"Supply capped at 1e21 with 0% minted (999.988B headroom remaining), but cap has been lowered once; issuer retains ability to raise cap.","metadataRisk":"Name and symbol are mutable and have already been changed twice (Speedrun Asset v2 / SRA2); identity verification by address only.","factorsCount":6,"redFlagsCount":5,"positivesCount":2,"model":"claude-haiku-4-5"},
  "b20-freeze-check": {"token":"0xb20000000000000000000186a08e781c38059eec","wallet":"0x973a31858f4d2125f48c880542da11a2796f12d6","isB20":true,"gated":false,"authorized":true,"verdict":"clear"},
  "b20-gate": {"address":"0xb20000000000000000000042d5ae64abd03d0dca","isB20":true,"variant":"asset","symbol":"SRA2","wallet":"0x973a31858f4d2125f48c880542da11a2796f12d6","walletStatus":"clear","decision":"STOP","observedRisksCount":2},
  // EXPERIMENT (2026-08-18): trimmed 16 keys → 5 as a single-variable test of
  // whether declaration SIZE is what keeps a resource out of the discovery index.
  // 14 of our listings settle payments and are still not indexed, and they skew
  // large: 2,816 vs 2,592 bytes of header, 9.3 vs 6.0 example keys. b20-mint-watch
  // is the control — same size, same absence, deliberately left untouched. If this
  // one returns to the index and that one does not, the threshold is size and this
  // file needs a cap on example width. Revert if it changes nothing.
  "b20-genesis-audit": {"address":"0xb20000000000000000000186a08e781c38059eec","symbol":"NADT","factoryConfirmed":true,"preMintsCount":0,"verdict":"configured_launch"},
  "b20-guard": {"address":"0xb20000000000000000000042d5ae64abd03d0dca","guardActive":true,"seizableNow":true,"lastAlert":null,"recentAlertsCount":0,"alertCount":0,"verdict":"seizable"},
  "b20-info": {"address":"0xb20000000000000000000186a08e781c38059eec","isB20":true,"name":"Namibian Dollar Token","symbol":"NADT","variant":"stablecoin","decimals":6,"totalSupply":"0","supplyCapped":true,"supplyCap":"500000000000","rebase":false},
  "b20-memo": {"address":"0xb20000000000000000000186a08e781c38059eec","isB20":true,"memoCount":0,"uniqueMemos":0,"uniqueCallers":0,"filtered":false,"memosCount":0,"verdict":"no_memos"},
  "b20-metadata": {"address":"0xb20000000000000000000186a08e781c38059eec","isB20":true,"currentName":"Namibian Dollar Token","currentSymbol":"NADT","metadataMutable":false,"metadataControllersCount":0,"renameCount":0,"renamesCount":0,"verdict":"immutable"},
  "b20-mint-watch": {"address":"0xb20000000000000000000186a08e781c38059eec","isB20":true,"symbol":"NADT","variant":"stablecoin","windowDays":30,"mintCount":0,"mintedInWindow":"0","pctOfCurrentSupply":null,"distinctRecipients":0,"totalSupply":"0","supplyCap":"500000000000","mintGated":false,"mintPaused":false,"mintsCount":0,"verdict":"quiet"},
  "b20-peg": {"address":"0xb20000000000000000000186a08e781c38059eec","isB20":true,"variant":"stablecoin","symbol":"NADT","declaredCurrency":"NAD","marketPriceUsd":null,"liquidityUsd":null,"verdict":"no_market"},
  "b20-permit": {"address":"0xb20000000000000000000186a08e781c38059eec","isB20":true,"supportsPermit":true,"owner":"0x973A31858f4D2125f48C880542DA11a2796f12D6","nonce":"0","domainSeparator":"0xd4f8bd427e9fce6ac90676c1dbd0a5db5284c1397afa4e5e4a76925c5baac692"},
  "b20-policy-admin": {"address":"0xb20000000000000000000042d5ae64abd03d0dca","isB20":true,"symbol":"SRA2","verdict":"admin_controlled","policyAdminsCount":4,"distinctAdmins":1},
  "b20-policy-members": {"address":"0xb20000000000000000000042d5ae64abd03d0dca","isB20":true,"symbol":"SRA2","policiesCount":4,"totalMembers":0,"verdict":"empty_lists"},
  "b20-policy-watch": {"address":"0xb20000000000000000000042d5ae64abd03d0dca","isB20":true,"seizableNow":true,"seizableSince":"2026-07-09T05:46:01.000Z","transferGatedNow":true,"changeCount":8,"eventsCount":8,"historyAvailable":true,"verdict":"seizable"},
  "b20-rebase": {"address":"0xb20000000000000000000042d5ae64abd03d0dca","isB20":true,"variant":"asset","rebase":true,"multiplier":"2000000000000000000","ratioToBase":2},
  "b20-rebase-history": {"address":"0xb20000000000000000000042d5ae64abd03d0dca","isB20":true,"variant":"asset","symbol":"SRA2","currentMultiplier":"2000000000000000000","currentAsFloat":2,"rebaseCount":1,"negativeRebases":0,"changesCount":1,"verdict":"rebasing"},
  "b20-safety": {"address":"0xb20000000000000000000042d5ae64abd03d0dca","isB20":true,"variant":"asset","symbol":"SRA2","riskScore":75,"verdict":"avoid","flagsCount":3},
  "b20-seizure-history": {"address":"0xb20000000000000000000042d5ae64abd03d0dca","isB20":true,"symbol":"SRA2","variant":"asset","canSeize":true,"seizureCount":1,"distinctVictims":1,"verdict":"enforced","seizuresCount":1},
  "b20-stablecoin": {"address":"0xb20000000000000000000186a08e781c38059eec","isB20":true,"variant":"stablecoin","symbol":"NADT","declaredCurrency":"NAD","totalSupply":"0","supplyCap":"500000000000","verdict":"open"},
  "b20-supply": {"address":"0xb20000000000000000000186a08e781c38059eec","isB20":true,"variant":"stablecoin","symbol":"NADT","totalSupply":"0","supplyCap":"500000000000","mintHeadroom":"500000000000","pctMinted":0,"capRaises":0,"capChangesCount":1,"historyAvailable":true,"verdict":"capped"},
  "b20-transfer-preflight": {"address":"0xb20000000000000000000186a08e781c38059eec","isB20":true,"variant":"stablecoin","symbol":"NADT","from":"0x973a31858f4d2125f48c880542da11a2796f12d6","to":"0xFe21a68f21d556A3C4274a44c2Fb5410c50cDa1C","executor":null,"decision":"GO","pausedNow":false,"legsCount":2,"observedRisksCount":0},
  "base-receipt": {"chain":"base","hash":"0x68fdf10f8eb842afcddf79b2a779ed78e5be35d698e95cee1966f1787eb02b5e","found":true,"status":"success","reverted":false,"blockNumber":49707346,"from":"0xE74817F4cDC15844314812B2271276E64e890fAE","to":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","contractCreated":null,"gasUsed":"86250","effectiveGasPriceWei":"6250000","feeWei":"539062500000","feeEth":"0.0000005390625","logCount":2,"logAddressesCount":1},
  "base-tx": {"chain":"base","hash":"0x68fdf10f8eb842afcddf79b2a779ed78e5be35d698e95cee1966f1787eb02b5e","found":true,"pending":false,"blockNumber":49707346,"from":"0xE74817F4cDC15844314812B2271276E64e890fAE","to":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","isContractCreation":false,"valueWei":"0","valueEth":"0","nonce":1118475,"gas":"95892","gasPriceWei":"6250000","maxFeePerGasWei":"26250000","type":"eip1559","methodSelector":"0xe3ee160e","inputBytes":325,"hasCalldata":true},
  "base-withdrawal": {"tx":"0x311b9d14a7aa412e5c5a404e07c715ba6b25a5a032962785c088c246beeab302","isBaseWithdrawal":true,"withdrawalHash":"0xc04c8c0acfc056dc9074c50c81df41a51287d9ce2f006b3627df6a6d55599bfc","nonce":"1766847064778384329583297500742918515827483896875618958121606201292748825","sender":"0x4200000000000000000000000000000000000007","target":"0x866E82a600A1414e583f7F13623F1aC5d58b0Afa","value":"0","initiatedAt":"2026-08-09T13:38:51.000Z","verdict":"waiting"},
  "basename-profile": {"basename":"jesse.base.eth","address":"0x2211d1D0020DAEA8039E46Cf1367962070d77DA9","avatar":"https://zku9gdedgba48lmr.public.blob.vercel-storage.com/basenames/avatar/jesse.base.eth/1722020142962/cryptopunk-diuDROjlL5OLY6EcC5keHTsNAiWMSL.png","description":"base.eth builder #001","url":"jesse.xyz","hasProfile":true},
  "buy-credits": {"balanceUsd":1.05,"paidUsd":1,"creditedUsd":1.05,"bonusUsd":0.05,"expiresInDays":180},
  "commerce-escrow": {"escrow":"0xBdEA0D1bcC5966192B070Fdf62aB4EF5b4420cff","mode":"payer","windowDays":90,"truncated":true,"paymentCount":0,"inEscrowCount":0,"reclaimableCount":0,"paymentsCount":0,"verdict":"no_activity"},
  "commerce-operator-audit": {"operator":"0x973A31858f4D2125f48C880542DA11a2796f12D6","escrow":"0xBdEA0D1bcC5966192B070Fdf62aB4EF5b4420cff","windowDays":90,"truncated":true,"paymentCount":0,"distinctPayers":0,"distinctReceivers":0,"tokensCount":0,"totalAuthorized":"0","totalCaptured":"0","totalFees":"0","totalRefunded":"0","captureRatePct":0,"reclaimRatePct":0,"verdict":"no_activity"},
  "contract-abi": {"address":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","verified":true,"matchType":"full","functionsCount":5,"eventsCount":2,"abiItemCount":9},
  "contract-danger": {"address":"0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed","verified":true,"dangerLevel":"high","dangerCategoriesCount":2,"dangerCount":7,"dangersCount":7,"functionCount":38},
  "deep-dd": {"address":"0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed","verdict":"caution","safetyScore":52,"confidence":"high","liquidityAssessment":"Moderate liquidity at $1.05M with low exit impact (0.95%) on a $5k trade, but concentrated among 19 LP holders with 0% locked LP creates withdrawal risk.","holderAssessment":"Highly concentrated: top holder controls 22.4%, top 10 hold 61.7% of supply across 1.18M accounts. Medium concentration risk with several contract-based address…","factorsCount":5,"risksCount":5,"positivesCount":5,"model":"claude-haiku-4-5"},
  "file-slot": {"key":"agent/7d/14c6e935bc5537bc437f4efb/report.csv","bytes":20480,"contentType":"text/csv","ttlDays":7,"guidance":"Upload within the 15-minute window, then hand the retrieval URL to whoever needs the file. Anyone holding that URL can read it, so treat it as the credential it…","disclaimer":"Retention is enforced by the bucket's lifecycle policy, not by this call: the object is scheduled to expire after the requested window, and is not guaranteed to…"},
  // Shows a REJECTION rather than a pass. The shop window has to advertise what
  // the endpoint is bought for, and nobody pays to be told an IBAN is fine —
  // they pay to be told which row to fix, and that `reason` is the product.
  "iban-check": {"input":"GB82 WEST 1234 5698 7654 32","valid":true,"reason":null,"iban":"GB82WEST12345698765432","formatted":"GB82 WEST 1234 5698 7654 32","country":"GB","countryName":"United Kingdom","sepa":true,"checkDigits":"82","bankIdentifier":"WEST","length":22,"expectedLength":22},
  // Both shop windows lead with the field that marks the LIMIT of the answer —
  // lineType/lineTypeReason and checksumChecked. An agent choosing between
  // offline validators needs to know which one tells it when it does not know.
  "phone-check": {"input":"+90 532 123 45 67","valid":true,"e164":"+905321234567","countryCode":"+90","country":"Türkiye","nationalNumber":"5321234567","lengthChecked":true,"lineType":"mobile","lineTypeReason":"mobile — the national number falls in an unambiguous mobile range"},
  "vat-check": {"input":"BE0417497106","valid":true,"reason":null,"vat":"BE0417497106","country":"BE","countryName":"Belgium","number":"0417497106","checksumChecked":true,"registered":null},
  "first-funder": {"wallet":"0xFe21a68f21d556A3C4274a44c2Fb5410c50cDa1C","verdict":"funded_by_wallet","firstFunder":"0xf70da97812CB96acDF810712Aa562db8dfA3dbEF","funderLabel":null,"funderType":"eoa","firstActivity":"2025-05-12T11:14:31.000Z","walletAgeDays":454,"txCount":42,"initialValueEth":"0.002079","firstTx":"0x78be771f7c3bc7657edc72972c7d5a558adea6ed7d6fd11a7f4666622dc6846c"},
  "fresh-bridge": {"wallet":"0xFe21a68f21d556A3C4274a44c2Fb5410c50cDa1C","windowDays":30,"verdict":"received_no_bridge","incomingUsdc":7,"incomingUsdcTotal":"$18.61","cctpBridgedCount":0,"cctpBridgedTotal":"$0.00","sourceChainsCount":0,"mostRecentBridgeAt":null,"bridgesCount":0},
  "morpho-health": {"wallet":"0x973A31858f4D2125f48C880542DA11a2796f12D6","market":"0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836","pair":"cbBTC/USDC","verdict":"no_borrow","collateral":"0","collateralToken":"0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf","borrowed":"0","recommendation":"This wallet has no position (no collateral, no borrow) in this market.","note":"Reads a Morpho Blue lending position on Base and its liquidation health. Pass wallet= and (optionally) market=; omit market= for cbBTC/USDC. Not financial advice."},
  "pair-info": {"pairAddress":"0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d","dexId":"aerodrome","priceUsd":"0.4224","priceChange24h":-3.42,"liquidityUsd":26916842.53,"volume24h":279836.93,"fdv":825830189},
  "portfolio-scan": {"address":"0x973A31858f4D2125f48C880542DA11a2796f12D6","totalUsd":5.79,"holdingsScanned":8,"holdingsTotal":18,"riskyCount":2,"honeypotCount":0,"usdInRiskyTokens":0,"portfolioRisk":"high","holdingsCount":8,"worstOffendersCount":2},
  "price-alert": {"registered":true,"alertId":"alrt_7d4e3f9c","token":"0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed","direction":"above","threshold":0.01,"priceAtCreate":0.0072,"fired":false,"expiresInDays":30},
  "revoke-builder": {"token":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","symbol":"USDC","spender":"0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43","wallet":"0x973A31858f4D2125f48C880542DA11a2796f12D6","currentAllowance":"0","isUnlimited":false,"alreadyRevoked":true},
  "rug-monitor": {"registered":true,"id":"3f9c1a2b-7d4e","token":"0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed","baselineLiquidityUsd":412500,"firesWhenLiquidityDropsPct":50,"mode":"webhook","expiresInDays":30},
  "secure-token": {"count":3,"tokensCount":3},
  "sellability": {"address":"0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed","canSell":true,"riskLevel":"low","degraded":false,"honeypot":false,"cannotSellAll":false,"sellTaxPct":0,"buyTaxPct":0,"transferPausable":false,"canExitSize":true,"reasonsCount":0,"verdict":"sellable"},
  "swap-route": {"tokenOut":"0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed","tradeSizeUsd":100,"poolCount":10,"estPriceImpactPct":0.02,"impactSource":"estimate","zeroxRoute":null,"suggestedSlippagePct":1.02,"suggestedMinOutPct":98.98,"safetyChecked":true,"verdict":"ok"},
  "token-balance": {"chain":"base","token":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","wallet":"0x973A31858f4D2125f48C880542DA11a2796f12D6","found":true,"symbol":"USDC","decimals":6,"decimalsAssumed":false,"balanceRaw":"5751845","balance":"5.751845","zero":false},
  "token-risk": {"address":"0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed","isContract":true,"upgradeableProxy":false,"riskScore":35,"riskLevel":"medium","securityChecked":true,"degraded":false,"flagsCount":2,"sourcesCount":2,"coverage":"RPC base + GoPlus security (honeypot, taxes, holders, holder concentration, LP lock, creator holdings, source, ownership controls)."},
  "token-transfers": {"wallet":"0xFe21a68f21d556A3C4274a44c2Fb5410c50cDa1C","token":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","symbol":"USDC","count":20,"transfersCount":20,"source":"cdp","window":"last 30 days"},
  "wallet-delegation": {"wallet":"0x973A31858f4D2125f48C880542DA11a2796f12D6","verdict":"delegated_known","delegated":true,"delegate":"0x36d3CBD83961868398d056EfBf50f5CE15528c0D","delegateLabel":"Base Account (CoinbaseSmartWallet v2 implementation)","delegateHasCode":true},
  "wallet-portfolio": {"address":"0x973A31858f4D2125f48C880542DA11a2796f12D6","tokenCount":18,"totalUsd":5.79,"holdingsCount":18,"source":"cdp"},
  "wallet-summary": {"address":"0xFe21a68f21d556A3C4274a44c2Fb5410c50cDa1C","outgoingTxCount":42,"firstActivity":"2025-05-12T11:14:31.000Z","firstBlock":30129562,"lastActivity":"2026-07-24T06:06:25.000Z","ageDays":454,"activity":"active","firstActivityVerified":true,"coverage":"First activity is the earliest block at which this account existed in state (balance or nonce), verified against its predecessor block. Counts and last-activity…","source":"base-archive"},
  "watchlist-diff": {"watchId":"wl_9f3c1a2b","created":true,"tokenCount":2,"expiresInDays":30},
  // Hand-shaped and NOT captured — this endpoint has never run, because it needs
  // an EXA_API_KEY the deployment does not have yet. Two reasons to carry it
  // anyway. The shop window is what an agent reads to decide, and a brand-new
  // row with `output_keys: ["query"]` reads as "returns nothing" to a discovery
  // oracle — the exact failure this file was written to stop, and worst on the
  // endpoint that most needs to be found. And the preview convention (arrays
  // reduced to counts) would leave a SEARCH endpoint advertising a number where
  // the results belong, so one representative result is kept whole, as with
  // safe-to-send above. Field names and shapes are Exa's documented response,
  // not invented: replace this with a captured preview on the first real call.
  "exa-search": {"query":"best open-source vector databases 2026","type":"auto","resultCount":5,"highlightsIncluded":false,"upstream":"exa","results":[{"title":"Qdrant: Open-Source Vector Database","url":"https://github.com/qdrant/qdrant","publishedDate":"2026-04-18T00:00:00.000Z","author":null,"score":0.7412,"highlights":null}]},
  // Hand-shaped for the same reason as exa-search above, and unrun for the same
  // reason. `text` is truncated here to a fragment on purpose: the shop window
  // shows that pages come back with their text, not the text itself.
  "exa-contents": {"pageCount":1,"requested":1,"maxChars":8000,"upstream":"exa","failedCount":0,"pages":[{"url":"https://github.com/qdrant/qdrant","title":"Qdrant: Open-Source Vector Database","author":null,"publishedDate":"2026-04-18T00:00:00.000Z","chars":7412,"truncated":false,"text":"Qdrant is an open-source vector database and similarity search engine…"}]},
};

/** The static example for a service, or undefined when we have none. */
export function staticOutputExample(serviceId: string): Record<string, unknown> | undefined {
  return OUTPUT_EXAMPLES[serviceId];
}

/** Every service we carry a static example for — so a test can catch an entry
 *  left behind after its service was renamed or removed. */
export function staticOutputExampleIds(): string[] {
  return Object.keys(OUTPUT_EXAMPLES);
}

// ---------------------------------------------------------------------------
// Example input
// ---------------------------------------------------------------------------

// Real Base values. Each was called against the live chain when this file was
// written, and the captured outputs above were read from these same inputs — an
// example whose two halves disagree teaches an agent nothing.
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DEGEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";
/** NADT — a live B20 stablecoin (variant 1). */
const B20_STABLE = "0xb20000000000000000000186a08e781c38059eec";
/** SRA2 — a live B20 Asset (variant 0) that carries policies, has rebased once
 *  and has an announcement, so the Asset-only endpoints return something worth
 *  seeing. Handing them the stablecoin makes each one answer "n/a", which reads
 *  as a broken endpoint. */
const B20_ASSET = "0xb20000000000000000000042d5ae64abd03d0dca";
/** Our own payTo, and our test wallet — both public, both active. */
const WALLET = "0x973a31858f4d2125f48c880542da11a2796f12d6";
const WALLET2 = "0xFe21a68f21d556A3C4274a44c2Fb5410c50cDa1C";
/** Aerodrome's router: a real spender to inspect or revoke. */
const SPENDER = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
const TX = "0x68fdf10f8eb842afcddf79b2a779ed78e5be35d698e95cee1966f1787eb02b5e";
/** A real L2→L1 withdrawal initiation. The generic tx above carries no
 *  MessagePassed log, so it makes base-withdrawal answer "not a withdrawal". */
const WITHDRAWAL_TX = "0x311b9d14a7aa412e5c5a404e07c715ba6b25a5a032962785c088c246beeab302";
/** Aerodrome USDC pair, ~$27m liquidity. */
const PAIR = "0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d";
/** Moonwell Flagship USDC — a live MetaMorpho vault on Base. */
const VAULT = "0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca";
/** The busiest paymaster on Base by sponsored ops. */
const PAYMASTER = "0x2cc0c7981D846b9F2a16276556f6e8cb52BfB633";
/** A real Base NFT collection (Base, Introduced). */
const NFT_COLLECTION = "0xEa2a41c02fA86A4901826615F9796e603C6a4491";

/** What a label cannot tell us: an Asset-only B20 endpoint, a spender that must
 *  be a contract rather than a wallet, a hash, a document.
 *
 *  An empty string means "declare nothing for this parameter" — used where the
 *  only honest example would be a value that cannot work for a stranger, such as
 *  a webhook URL pointing at a host we do not own. */
const OVERRIDES: Record<string, Record<string, string>> = {
  // B20 endpoints that only answer for an Asset (variant 0).
  "b20-seizure-history": { address: B20_ASSET },
  "b20-policy-members": { address: B20_ASSET },
  "b20-policy-admin": { address: B20_ASSET },
  "b20-policy-watch": { address: B20_ASSET },
  "b20-guard": { address: B20_ASSET },
  "b20-rebase": { address: B20_ASSET },
  "b20-rebase-history": { address: B20_ASSET },
  "b20-announcements": { address: B20_ASSET },
  "b20-batch": { addresses: `${B20_STABLE},${B20_ASSET}` },
  "b20-transfer-preflight": { address: B20_STABLE, from: WALLET, to: WALLET2 },
  // Addresses that are neither the caller's wallet nor a plain token.
  "revoke-builder": { token: USDC, spender: SPENDER, wallet: WALLET },
  "sign-guard": {
    // approve(Aerodrome router, 0) — the revoke every wallet tool wants checked.
    data: "0x095ea7b3000000000000000000000000cf77a3ba9a5ca399b7c97c74d54e5b1beb874e430000000000000000000000000000000000000000000000000000000000000000",
    to: USDC,
  },
  "commerce-escrow": { payer: WALLET, receiver: WALLET2, operator: WALLET },
  "commerce-operator-audit": { operator: WALLET },
  "morpho-vault": { vault: VAULT },
  // The route is quoted OUT of USDC, so quoting into USDC would price nothing.
  "swap-route": { tokenOut: DEGEN, amountUsd: "100" },
  "paymaster-check": { paymaster: PAYMASTER, days: "7" },
  "pair-info": { pair: PAIR },
  "nft-floor": { contract: NFT_COLLECTION },
  // Names, hashes and lists.
  "basename-profile": { name: "jesse.base.eth" },
  basename: { query: "jesse.base.eth" },
  "ens-resolve": { query: "vitalik.eth" },
  "base-tx": { hash: TX },
  "base-receipt": { hash: TX },
  "tx-decode": { hash: TX },
  "ai-tx-explain": { hash: TX },
  "base-withdrawal": { tx: WITHDRAWAL_TX },
  "token-compare": { addresses: `${USDC},${DEGEN}` },
  "multi-price": { addresses: `${USDC},${DEGEN}` },
  "batch-risk": { addresses: `${USDC},${DEGEN}` },
  "sanctions-batch": { addresses: `${WALLET},${WALLET2}` },
  "watchlist-diff": { tokens: `${USDC},${DEGEN}` },
  // Text in, structure out: the input IS the example.
  "ai-summarize": { text: "Base processed 12.4 million transactions last week, a 9% rise, while median gas stayed under a tenth of a cent. Most of the growth came from onchain games and agent payments rather than DeFi." },
  "ai-extract": { text: "Invoice #18 from Acme Corp, due 2026-08-01, total $420.50, contact billing@acme.io", fields: "invoice_no,company,due_date,total,email" },
  "ai-extract-batch": {
    text1: "Invoice #18 from Acme Corp, due 2026-08-01, total $420.50",
    text2: "Invoice #19 from Globex Ltd, due 2026-08-15, total $1,250.00",
    fields: "invoice_no,company,due_date,total",
  },
  "ai-translate": { text: "Your withdrawal is being processed and should arrive within one business day.", to: "Turkish" },
  "file-publish": { text: "# Weekly risk report\n\nTwo of nine watched tokens lost more than 20% of their liquidity.", title: "Weekly risk report", format: "md", ttlDays: "7" },
  // The file endpoints declare their formats as option lists ("csv | tsv | json"),
  // which are required parameters — an agent sending the list gets a 400.
  "file-convert": { text: "name,qty\nWidget,3\nGadget,7", from: "csv", to: "json", typed: "true" },
  "file-slot": { bytes: "20480", name: "report.csv", contentType: "text/csv", ttlDays: "7" },
  // A webhook example can only be a host we do not control, and both endpoints
  // resolve it before accepting — so declare none rather than one that throws.
  "rug-monitor": { token: DEGEN, dropPct: "50", webhook: "" },
  "price-alert": { token: DEGEN, threshold: "0.01", direction: "above", webhook: "" },
  // The captured output for each of these was read from DEGEN, not USDC. An
  // example whose two halves name different tokens is not reproducible.
  "token-risk": { address: DEGEN },
  sellability: { address: DEGEN, size: "5000" },
  "contract-danger": { address: DEGEN },
  "deep-dd": { address: DEGEN, size: "5000" },
  "ai-token-report": { address: DEGEN },
  "ai-contract-risk": { address: DEGEN },
  // The example output was read from this address; the halves must agree.
  "safe-to-send": { address: WALLET },
  // Labelled only "Address", so nothing tells the rules these screen an account.
  "address-intel": { address: WALLET },
  "base-nonce": { address: WALLET },
  // Captured from the Asset, which is the variant with something to report.
  "b20-safety": { address: B20_ASSET },
  "b20-gate": { address: B20_ASSET, wallet: WALLET },
  "b20-dossier": { address: B20_ASSET },
  // Captured from the second wallet, which has the longer history.
  "wallet-summary": { address: WALLET2 },
  // These read LP-holder data, and USDC has no DEX pool of its own to hold — the
  // declared example answered "No LP holders found", i.e. an error, for anyone
  // who followed it. DEGEN has real pools.
  "lp-lock": { address: DEGEN },
  "token-unlock": { address: DEGEN },
  // example.com/article is a 404. A declared URL has to be a page that is
  // actually there, and has enough text to show what the endpoint returns.
  "url-extract": { url: "https://402.com.tr/agents", maxChars: "40000" },
  "url-to-json": { url: "https://402.com.tr/agents", fields: "title,summary" },
};

/** Labels that mean "an account holds this", as opposed to a token or contract.
 *  `eoa` and the bare screening labels are here because they were missed once:
 *  wallet-delegation says "EOA address" and exists only to inspect delegation,
 *  yet it was handed the USDC contract, which it correctly called a contract. */
const WALLET_LABEL = /wallet|holder|payer|merchant|borrower|victim|account|recipient|sender|safe|operator|owner|deployer|\beoa\b|address to (check|screen)|counterparty/i;
/** Parameters that carry an address. `from`/`to` are deliberately absent: they
 *  are currencies on fx-convert, dates on business-days and formats on
 *  file-convert, and each of those already has a usable placeholder. */
const ADDRESS_PARAM = /^(address|addresses|token|tokens|contract|wallet|owner|spender)$/i;
/**
 * A placeholder written for a human to read past, not for a machine to send.
 *
 * An ellipsis was the first version and it was not enough: `e.g. 20480`,
 * `csv | tsv | json | md` and `30 (max 90)` all sailed through as declared
 * values, and the first two are on REQUIRED parameters, so those examples threw
 * on the first call. Each pattern here is a form of "here is the shape, not the
 * value" — an option list, a for-instance, or a value trailed by a parenthetical
 * aside. The space before `(` matters: `transfer(address,uint256)` is a real
 * value that must survive.
 */
const IS_HINT = /…|\.\.\.|\be\.g\.|\s\|\s|\s\(/;

function inferred(service: ExampleService, p: ExampleService["params"][number]): string | undefined {
  if (ADDRESS_PARAM.test(p.name)) {
    const plural = /es$|^tokens$/i.test(p.name);
    const one = WALLET_LABEL.test(p.label)
      ? WALLET
      : service.category === "B20"
        ? B20_STABLE
        : USDC;
    if (!plural) return one;
    return one === WALLET ? `${WALLET},${WALLET2}` : one === B20_STABLE ? `${B20_STABLE},${B20_ASSET}` : `${USDC},${DEGEN}`;
  }
  // A placeholder that is already a real value ("USD", "jesse.base.eth",
  // "Coinbase Global, Inc.") is the best example there is; one with an ellipsis
  // is a hint for a form field and would only produce an error.
  if (p.placeholder && !IS_HINT.test(p.placeholder)) return p.placeholder;
  return undefined;
}

/**
 * A worked example call for a service: every parameter we can give a real value
 * for, and none we cannot. Empty when the service takes no parameters.
 */
export function exampleInputFor(service: ExampleService): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const p of service.params) {
    const v = OVERRIDES[service.id]?.[p.name] ?? inferred(service, p);
    if (v) out[p.name] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
