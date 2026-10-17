/**
 * Coinbase's tokenized equities on Base, and the multiplier they all sit at.
 *
 * WHAT THIS ROSTER IS AND IS NOT
 * ------------------------------
 * It is a SEED, not the source of truth. The truth is the operator anchor in
 * b20-safety.ts: a token is one of these if its TRANSFER_SENDER_POLICY is
 * administered by KNOWN_ASSET_ISSUERS. That check needs no list and recognised
 * all thirteen of these with zero configuration when they were found. The list
 * exists so the watcher below has something to read every morning without
 * re-scanning 54,000 B20Created events to find its own subjects.
 *
 * Discovered from chain on 2026-09-03 from two seed addresses the operator
 * supplied, by filtering B20Created on decimals=8 (88 candidates, versus 54,206
 * at 18) and keeping those whose sender-policy admin matched. Two traps are
 * worth recording because both cost time:
 *
 *   - CDP SQL returns `result: null` with NO error for `parameters['decimals']
 *     = '8'`. It needs `toString(parameters['decimals']) = '8'`.
 *   - B20Created carries the ORIGINAL symbol. GOOGLc's creation event says
 *     "GOOGL"; the metadata role renamed it afterwards. Symbols must be read
 *     from `symbol()` on chain, never from the creation event.
 *
 * WHY A MULTIPLIER WATCH EXISTS AT ALL
 * ------------------------------------
 * On an Asset-variant B20 the multiplier rescales every holder's balance at
 * once. For an equity wrapper that is how a split, a reverse split, or a
 * dividend adjustment arrives — the position does not move, the unit does.
 * Everything downstream that cached a balance is silently wrong the moment it
 * changes, and on 2026-09-03 every top holder of GOOGLc and METAc was a
 * contract (Uniswap V4's PoolManager first among them), so "downstream" here
 * means pools and vaults, not people who would notice.
 *
 * As of 2026-09-04 the count of MultiplierUpdated events across all thirteen is
 * ZERO and every multiplier reads exactly 1.0. That fact shapes what this file
 * is allowed to claim. We can detect that a value changed, because we hold the
 * previous one. We CANNOT yet classify a change as a scheduled ERC-8056 update
 * versus an emergency updateMultiplier(), because no sample of either exists to
 * write that parsing against — so it is deliberately not written. The watcher
 * reports the change and the transaction, and the classification gets built
 * when the first real event supplies something to test it on.
 */

import "server-only";
import { createPublicClient, getAddress, keccak256, toBytes } from "viem";
import { base } from "viem/chains";
import { baseTransport } from "./base-transport";
import { kvGet, kvSet } from "./kv";

/** WAD — a multiplier of exactly 1.0. Dividends have since moved some off it (NVDAc 1.000538 on 2026-10-17). */
export const WAD = 10n ** 18n;

/** The policy operator that administers all thirteen. This is the real anchor. */
export const STOCK_POLICY_ADMIN = "0xec0f05c174e54fbf0fe16ad930a8afebce612812";

export interface TokenizedStock {
  /** On-chain symbol, read from symbol() — always the ticker plus a "c". */
  sym: string;
  /** The underlying listed ticker. */
  ticker: string;
  name: string;
  token: `0x${string}`;
}

/**
 * Discovered from chain by the operator anchor, refreshed 2026-10-03: every
 * 8-decimal B20Created token whose TRANSFER_SENDER_POLICY is administered by
 * STOCK_POLICY_ADMIN. 82 confirmed, all on policy id 5. The roster grew from the
 * original 13 (2026-09-03) as Coinbase issued more — the membership test needs
 * no edit to RECOGNISE a new one (b20-safety does that live), but this list
 * drives the /stocks board, the watcher and stock-position, so it is kept in
 * sync here. The operator also deploys `tDUMMY*` test assets under the same admin
 * ("Dummy Test Asset N"); those are NOT equities and are deliberately excluded.
 */
export const TOKENIZED_STOCKS: readonly TokenizedStock[] = [
  { sym: "AAOIc", ticker: "AAOI", name: "Applied Optoelectronics Inc", token: "0xb200000000000000000000cf36d05963a3e2205c" },
  { sym: "AAPLc", ticker: "AAPL", name: "Apple Inc.", token: "0xb200000000000000000000c2e324d24d7eecd1fb" },
  { sym: "ABNBc", ticker: "ABNB", name: "Airbnb, Inc.", token: "0xb200000000000000000000045beafafbe0dc7664" },
  { sym: "AEOc", ticker: "AEO", name: "American Eagle Outfitters, Inc.", token: "0xb2000000000000000000006064f8ec027f042294" },
  { sym: "AMCc", ticker: "AMC", name: "AMC Entertainment Holdings, Inc.", token: "0xb200000000000000000000cd7e6b8042cb7c2bb5" },
  { sym: "AMDc", ticker: "AMD", name: "Advanced Micro Devices, Inc.", token: "0xb2000000000000000000000d8ce462e99ee7a47b" },
  { sym: "AMZNc", ticker: "AMZN", name: "Amazon.com Inc.", token: "0xb200000000000000000000d9192b6b456483c2e8" },
  { sym: "APPc", ticker: "APP", name: "AppLovin Corporation", token: "0xb20000000000000000000006f910a0e7bbd3c168" },
  { sym: "ARMc", ticker: "ARM", name: "Arm Holdings plc", token: "0xb20000000000000000000026215d755356e5043f" },
  { sym: "ASTSc", ticker: "ASTS", name: "AST SpaceMobile, Inc.", token: "0xb200000000000000000000b1a29cf17a1819288a" },
  { sym: "AURc", ticker: "AUR", name: "Aurora Innovation, Inc.", token: "0xb200000000000000000000cf62d7125cc77d2f96" },
  { sym: "AVGOc", ticker: "AVGO", name: "Broadcom Inc.", token: "0xb200000000000000000000fc737aea6196ab5a4c" },
  { sym: "AXONc", ticker: "AXON", name: "Axon Enterprise, Inc.", token: "0xb2000000000000000000004cc3e96ceb78541d33" },
  { sym: "AXTIc", ticker: "AXTI", name: "AXT Inc", token: "0xb200000000000000000000a640ec8c1de0efb484" },
  { sym: "BALLc", ticker: "BALL", name: "Ball Corporation", token: "0xb200000000000000000000747bffa52fe2c2510b" },
  { sym: "BBAIc", ticker: "BBAI", name: "BigBear.ai Holdings, Inc.", token: "0xb200000000000000000000898ed394469db1845c" },
  { sym: "BEc", ticker: "BE", name: "Bloom Energy Corporation", token: "0xb20000000000000000000016f9dfe862feba122b" },
  { sym: "BIDUc", ticker: "BIDU", name: "Baidu, Inc.", token: "0xb200000000000000000000d2b7d9aee52f6c6bef" },
  { sym: "BILIc", ticker: "BILI", name: "Bilibili Inc.", token: "0xb200000000000000000000ca7c6d1438e7245eb6" },
  { sym: "BIRDc", ticker: "BIRD", name: "Smartbird, Inc.", token: "0xb200000000000000000000535fe96f18204bfd96" },
  { sym: "BJc", ticker: "BJ", name: "BJ's Wholesale Club Holdings, Inc.", token: "0xb200000000000000000000082f7fea8f2ee8f438" },
  { sym: "BKSYc", ticker: "BKSY", name: "BlackSky Technology Inc.", token: "0xb200000000000000000000bc4d895df1eeed1d06" },
  { sym: "BLNKc", ticker: "BLNK", name: "Blink Charging Co.", token: "0xb2000000000000000000004ec7c19212979672f9" },
  { sym: "BMNRc", ticker: "BMNR", name: "BitMine Immersion Technologies, Inc.", token: "0xb200000000000000000000ea2df44a307cab279c" },
  { sym: "BOOTc", ticker: "BOOT", name: "Boot Barn Holdings, Inc.", token: "0xb2000000000000000000003e5e2892158e25dd7b" },
  { sym: "BRK.Bc", ticker: "BRK.B", name: "Berkshire Hathaway Inc. Class B", token: "0xb20000000000000000000024170488e788cbbcb4" },
  { sym: "BUDc", ticker: "BUD", name: "Anheuser-Busch InBev SA/NV", token: "0xb200000000000000000000c36ce081dd09e86ca2" },
  { sym: "BYNDc", ticker: "BYND", name: "Beyond Meat, Inc.", token: "0xb200000000000000000000801830b13b8e493423" },
  { sym: "CAKEc", ticker: "CAKE", name: "Cheesecake Factory Inc", token: "0xb200000000000000000000f215e4c890cfb7176b" },
  { sym: "CANc", ticker: "CAN", name: "Canaan Inc.", token: "0xb200000000000000000000f32d61ba597eddfbfd" },
  { sym: "CAVAc", ticker: "CAVA", name: "CAVA Group, Inc.", token: "0xb2000000000000000000001b6e407239eb31edcf" },
  { sym: "CBRSc", ticker: "CBRS", name: "Cerebras Systems Inc.", token: "0xb200000000000000000000720133eedf525f93e2" },
  { sym: "CELHc", ticker: "CELH", name: "Celsius Holdings, Inc.", token: "0xb2000000000000000000004161b4168d03841511" },
  { sym: "CHPTc", ticker: "CHPT", name: "ChargePoint Holdings, Inc.", token: "0xb2000000000000000000001ca01a48688ec7d3cc" },
  { sym: "CHWYc", ticker: "CHWY", name: "Chewy, Inc.", token: "0xb200000000000000000000a5e12a1842dfcdb118" },
  { sym: "CIFRc", ticker: "CIFR", name: "Cipher Digital Inc.", token: "0xb200000000000000000000690275843b6e246286" },
  { sym: "CLOVc", ticker: "CLOV", name: "Clover Health Investments, Corp.", token: "0xb20000000000000000000055e63c4c1cdc6b7a36" },
  { sym: "CLSKc", ticker: "CLSK", name: "CleanSpark, Inc.", token: "0xb200000000000000000000fa63cfff5c794dbb95" },
  { sym: "COINc", ticker: "COIN", name: "Coinbase Global Inc.", token: "0xb200000000000000000000c85a31389d71f3ecfb" },
  { sym: "CORZc", ticker: "CORZ", name: "Core Scientific, Inc.", token: "0xb2000000000000000000001aaa9010cd65f82c5e" },
  { sym: "CRCLc", ticker: "CRCL", name: "Circle Internet Group Inc.", token: "0xb20000000000000000000019f6e7c675b73c2e4d" },
  { sym: "CROXc", ticker: "CROX", name: "Crocs, Inc.", token: "0xb200000000000000000000431a5c1e48e3b1d130" },
  { sym: "CRWVc", ticker: "CRWV", name: "CoreWeave, Inc.", token: "0xb200000000000000000000f111184a74720787e6" },
  { sym: "CVNAc", ticker: "CVNA", name: "Carvana Co.", token: "0xb200000000000000000000ffb10718f880a48274" },
  { sym: "DASHc", ticker: "DASH", name: "DoorDash, Inc.", token: "0xb200000000000000000000bf391678bf2e38cedb" },
  { sym: "DJTc", ticker: "DJT", name: "Trump Media & Technology Group Corp.", token: "0xb200000000000000000000428e3a3eebbb20692b" },
  { sym: "DKNGc", ticker: "DKNG", name: "DraftKings Inc.", token: "0xb2000000000000000000009b870441031d4d8a41" },
  { sym: "DNAc", ticker: "DNA", name: "Ginkgo Bioworks Holdings, Inc.", token: "0xb200000000000000000000cc17eea8c9495e1499" },
  { sym: "DUOLc", ticker: "DUOL", name: "Duolingo, Inc.", token: "0xb200000000000000000000a613d12deafbbb1db7" },
  { sym: "EATc", ticker: "EAT", name: "Brinker International, Inc.", token: "0xb200000000000000000000808e9cca9ed8e4da61" },
  { sym: "ELFc", ticker: "ELF", name: "e.l.f. Beauty, Inc.", token: "0xb2000000000000000000006b7f6966ee0453e251" },
  { sym: "ENPHc", ticker: "ENPH", name: "Enphase Energy, Inc.", token: "0xb2000000000000000000007a90b2d9ed101035a8" },
  { sym: "FIGRc", ticker: "FIGR", name: "Figure Technology Solutions, Inc.", token: "0xb2000000000000000000005a41bef59807119850" },
  { sym: "FIZZc", ticker: "FIZZ", name: "National Beverage Corp.", token: "0xb200000000000000000000ee6fd7de967ea1a0dc" },
  { sym: "FSLRc", ticker: "FSLR", name: "First Solar, Inc.", token: "0xb200000000000000000000b096f2f6021ac39617" },
  { sym: "FWDIc", ticker: "FWDI", name: "Forward Industries, Inc.", token: "0xb2000000000000000000001e838d4beb66cf8fb7" },
  { sym: "GAMEc", ticker: "GAME", name: "GameSquare Holdings, Inc.", token: "0xb2000000000000000000005550e8506124236271" },
  { sym: "GEMIc", ticker: "GEMI", name: "Gemini Space Station, Inc.", token: "0xb2000000000000000000009c52748e1d1cbd5fd6" },
  { sym: "GLXYc", ticker: "GLXY", name: "Galaxy Digital Inc.", token: "0xb2000000000000000000006de7888c3fffd803ac" },
  { sym: "GMEc", ticker: "GME", name: "GameStop Corp.", token: "0xb2000000000000000000007790ed6e48e06ed935" },
  { sym: "GOOGLc", ticker: "GOOGL", name: "Alphabet Inc.", token: "0xb2000000000000000000002d0ba3164cc74f58b7" },
  { sym: "GPROc", ticker: "GPRO", name: "GoPro, Inc.", token: "0xb200000000000000000000f0e13d9c1cdfd211c8" },
  { sym: "HIMSc", ticker: "HIMS", name: "Hims & Hers Health, Inc.", token: "0xb20000000000000000000043a599976181bcf336" },
  { sym: "HPQc", ticker: "HPQ", name: "HP Inc.", token: "0xb2000000000000000000009a3602cf5d020afa98" },
  { sym: "HSAIc", ticker: "HSAI", name: "Hesai Group", token: "0xb200000000000000000000f3049f4aa834b23b64" },
  { sym: "HSYc", ticker: "HSY", name: "The Hershey Company", token: "0xb200000000000000000000f327a373aa86ac86a8" },
  { sym: "HTZc", ticker: "HTZ", name: "Hertz Global Holdings, Inc.", token: "0xb2000000000000000000002601c5c94f435da168" },
  { sym: "HUTc", ticker: "HUT", name: "Hut 8 Corp.", token: "0xb2000000000000000000006ee1c139a723872e09" },
  { sym: "IBRXc", ticker: "IBRX", name: "ImmunityBio, Inc.", token: "0xb20000000000000000000077d13d6c79b6c11c5a" },
  { sym: "INFYc", ticker: "INFY", name: "Infosys Limited", token: "0xb200000000000000000000f6b0417af5f52341fc" },
  { sym: "INTCc", ticker: "INTC", name: "Intel Corporation", token: "0xb2000000000000000000004aff16039ba04bdfbc" },
  { sym: "IONQc", ticker: "IONQ", name: "IonQ, Inc.", token: "0xb20000000000000000000058f143099d5f79b0ec" },
  { sym: "JACKc", ticker: "JACK", name: "Jack in the Box Inc.", token: "0xb200000000000000000000b44f193b3ffdf17037" },
  { sym: "KODKc", ticker: "KODK", name: "Eastman Kodak Company", token: "0xb200000000000000000000a63e35e673e3776b88" },
  { sym: "KSSc", ticker: "KSS", name: "Kohl's Corporation", token: "0xb200000000000000000000105a1f43ff3605c5de" },
  { sym: "LCIDc", ticker: "LCID", name: "Lucid Group, Inc.", token: "0xb20000000000000000000081050ac3d4395df527" },
  { sym: "LEUc", ticker: "LEU", name: "Centrus Energy Corp.", token: "0xb200000000000000000000fab55ad3773f2c8ef1" },
  { sym: "LFMDc", ticker: "LFMD", name: "LifeMD, Inc.", token: "0xb200000000000000000000db15c02e133a9dab99" },
  { sym: "LIc", ticker: "LI", name: "Li Auto Inc.", token: "0xb200000000000000000000d61efd9f54a23ef9eb" },
  { sym: "LITEc", ticker: "LITE", name: "Lumentum Holdings Inc", token: "0xb200000000000000000000eda6c2c6f11e0f838f" },
  { sym: "LLYc", ticker: "LLY", name: "Eli Lilly & Co", token: "0xb200000000000000000000f1a0f91e34892e4718" },
  { sym: "LOVEc", ticker: "LOVE", name: "The Lovesac Company", token: "0xb200000000000000000000c3e498043bb44e8cbf" },
  { sym: "LUNRc", ticker: "LUNR", name: "Intuitive Machines, Inc.", token: "0xb200000000000000000000674e1325dbdf06b309" },
  { sym: "LUVc", ticker: "LUV", name: "Southwest Airlines Company", token: "0xb200000000000000000000d5c0393796e92fcab0" },
  { sym: "LYVc", ticker: "LYV", name: "Live Nation Entertainment, Inc.", token: "0xb2000000000000000000001347ccd9e83d5bf3e0" },
  { sym: "MARAc", ticker: "MARA", name: "MARA Holdings, Inc.", token: "0xb200000000000000000000a310e034e09186fb2d" },
  { sym: "MCDc", ticker: "MCD", name: "McDonald's Corporation", token: "0xb200000000000000000000d2f4cf2f7debb244bb" },
  { sym: "METAc", ticker: "META", name: "Meta Platforms Inc.", token: "0xb2000000000000000000008bc8786b856e61707c" },
  { sym: "MNSTc", ticker: "MNST", name: "Monster Beverage Corporation", token: "0xb2000000000000000000005bcde0a6926919fef9" },
  { sym: "MRNAc", ticker: "MRNA", name: "Moderna, Inc.", token: "0xb200000000000000000000e215e9b76ecba02468" },
  { sym: "MRVLc", ticker: "MRVL", name: "Marvell Technology, Inc.", token: "0xb200000000000000000000ec3c4c7395cc609813" },
  { sym: "MSFTc", ticker: "MSFT", name: "Microsoft Corporation", token: "0xb200000000000000000000ab99cfa739e253872b" },
  { sym: "MSTRc", ticker: "MSTR", name: "Strategy Inc.", token: "0xb2000000000000000000004884b426556b92883d" },
  { sym: "MTCHc", ticker: "MTCH", name: "Match Group, Inc.", token: "0xb200000000000000000000441ec9266133f611ef" },
  { sym: "MUc", ticker: "MU", name: "Micron Technology Inc.", token: "0xb200000000000000000000fd2f87532b90095211" },
  { sym: "NFLXc", ticker: "NFLX", name: "Netflix Inc", token: "0xb20000000000000000000058b8c947e44011dfe6" },
  { sym: "NIOc", ticker: "NIO", name: "NIO Inc.", token: "0xb2000000000000000000002d2b5dc53c61f1ba06" },
  { sym: "NOKc", ticker: "NOK", name: "Nokia Corporation", token: "0xb2000000000000000000005ac674f707e357409c" },
  { sym: "NOWc", ticker: "NOW", name: "ServiceNow, Inc.", token: "0xb20000000000000000000082cd2c7801305808df" },
  { sym: "NVAXc", ticker: "NVAX", name: "Novavax Inc", token: "0xb200000000000000000000c597c476fcf9aed3a8" },
  { sym: "NVDAc", ticker: "NVDA", name: "NVIDIA Corporation", token: "0xb20000000000000000000078ee7ce2fe4908108c" },
  { sym: "NVOc", ticker: "NVO", name: "Novo Nordisk A/S", token: "0xb2000000000000000000008d5328e9208773dc58" },
  { sym: "OKLOc", ticker: "OKLO", name: "Oklo Inc.", token: "0xb2000000000000000000009188edfd2fcc8cc81e" },
  { sym: "ONDSc", ticker: "ONDS", name: "Ondas Inc.", token: "0xb200000000000000000000e7137ca231c5e35f25" },
  { sym: "OPENc", ticker: "OPEN", name: "Opendoor Technologies Inc.", token: "0xb200000000000000000000259694b27bf052e7d7" },
  { sym: "ORCLc", ticker: "ORCL", name: "Oracle Corporation", token: "0xb200000000000000000000347afba223d7b6b63c" },
  { sym: "OURAc", ticker: "OURA", name: "Oura Inc.", token: "0xb2000000000000000000008536298e05fdfb65f4" },
  { sym: "PDDc", ticker: "PDD", name: "PDD Holdings Inc.", token: "0xb200000000000000000000c8a7223510467d8563" },
  { sym: "PFEc", ticker: "PFE", name: "Pfizer Inc", token: "0xb20000000000000000000018fe7ec7d6dfeeb528" },
  { sym: "PLAYc", ticker: "PLAY", name: "Dave & Buster’s Entertainment, Inc.", token: "0xb20000000000000000000087d144f2c70cd1a5f6" },
  { sym: "PLc", ticker: "PL", name: "Planet Labs PBC", token: "0xb200000000000000000000cb6b2f4e33f0471556" },
  { sym: "PLNTc", ticker: "PLNT", name: "Planet Fitness, Inc.", token: "0xb20000000000000000000011b20aebe0bd567f1c" },
  { sym: "PLTRc", ticker: "PLTR", name: "Palantir Technologies Inc.", token: "0xb2000000000000000000007d16372840df4dabbe" },
  { sym: "PMc", ticker: "PM", name: "Philip Morris International Inc.", token: "0xb2000000000000000000008fc2a8c23cf5937b66" },
  { sym: "PTONc", ticker: "PTON", name: "Peloton Interactive, Inc.", token: "0xb2000000000000000000009272a491812842aa84" },
  { sym: "PURRc", ticker: "PURR", name: "Hyperliquid Strategies Inc", token: "0xb20000000000000000000065ca0f772a5502e976" },
  { sym: "PYPLc", ticker: "PYPL", name: "PayPal Holdings, Inc.", token: "0xb200000000000000000000450ad3abe5d4846c6e" },
  { sym: "PZZAc", ticker: "PZZA", name: "Papa John’s International, Inc.", token: "0xb20000000000000000000068987dacde1db79cd4" },
  { sym: "QUBTc", ticker: "QUBT", name: "Quantum Computing Inc.", token: "0xb200000000000000000000ca425ab42e07c35bc3" },
  { sym: "RBLXc", ticker: "RBLX", name: "Roblox Corporation", token: "0xb2000000000000000000005bd7ae89b9e6189bb5" },
  { sym: "RDDTc", ticker: "RDDT", name: "Reddit, Inc.", token: "0xb20000000000000000000066242d4067724cb7a1" },
  { sym: "RDWc", ticker: "RDW", name: "Redwire Corporation", token: "0xb200000000000000000000cd7dfaef0423f1f103" },
  { sym: "RGTIc", ticker: "RGTI", name: "Rigetti Computing, Inc.", token: "0xb200000000000000000000c22fff2785bb27b39a" },
  { sym: "RIOTc", ticker: "RIOT", name: "Riot Platforms, Inc.", token: "0xb200000000000000000000bd0c7627b663c581a6" },
  { sym: "RIVNc", ticker: "RIVN", name: "Rivian Automotive, Inc.", token: "0xb2000000000000000000003e4249c65bd6c037d9" },
  { sym: "RKLBc", ticker: "RKLB", name: "Rocket Lab Corporation", token: "0xb200000000000000000000e8e50cbbb9a3861a3c" },
  { sym: "RKTc", ticker: "RKT", name: "Rocket Companies, Inc.", token: "0xb200000000000000000000000d3176ee4af1102d" },
  { sym: "ROOTc", ticker: "ROOT", name: "Root, Inc.", token: "0xb2000000000000000000004aa2b559ca0a0bbf5d" },
  { sym: "RUNc", ticker: "RUN", name: "Sunrun Inc.", token: "0xb200000000000000000000b1b9200405fb52a8cf" },
  { sym: "RXRXc", ticker: "RXRX", name: "Recursion Pharmaceuticals, Inc.", token: "0xb200000000000000000000501ef81f911eb57656" },
  { sym: "SAMc", ticker: "SAM", name: "The Boston Beer Company, Inc.", token: "0xb200000000000000000000e410ae30abdda3aee0" },
  { sym: "SANc", ticker: "SAN", name: "Banco Santander, S.A.", token: "0xb20000000000000000000017bb66e9301e913a99" },
  { sym: "SAPc", ticker: "SAP", name: "SAP SE", token: "0xb200000000000000000000da6f64c306234127e0" },
  { sym: "SBETc", ticker: "SBET", name: "Sharplink, Inc.", token: "0xb200000000000000000000559ec0bedaacf436ea" },
  { sym: "SEc", ticker: "SE", name: "Sea Limited", token: "0xb2000000000000000000003088798f6d0722aaac" },
  { sym: "SEZLc", ticker: "SEZL", name: "Sezzle Inc.", token: "0xb2000000000000000000000c1f8acd3c4496a762" },
  { sym: "SGc", ticker: "SG", name: "Sweetgreen, Inc.", token: "0xb200000000000000000000b57f99acec3a7490d0" },
  { sym: "SHAZc", ticker: "SHAZ", name: "SharonAI Holdings Inc.", token: "0xb2000000000000000000000d9947c759429e7fe5" },
  { sym: "SIDUc", ticker: "SIDU", name: "Sidus Space, Inc.", token: "0xb2000000000000000000002b9ac07a0544688079" },
  { sym: "SKHYc", ticker: "SKHY", name: "SK hynix Inc.", token: "0xb200000000000000000000187f7071d6e321a7d2" },
  { sym: "SLDPc", ticker: "SLDP", name: "Solid Power, Inc.", token: "0xb200000000000000000000df3eb2af7316b29122" },
  { sym: "SMPLc", ticker: "SMPL", name: "The Simply Good Foods Company", token: "0xb2000000000000000000001409f816682b7772b7" },
  { sym: "SMRc", ticker: "SMR", name: "NuScale Power Corporation", token: "0xb200000000000000000000978546fe604b8dcbc6" },
  { sym: "SNDKc", ticker: "SNDK", name: "Sandisk Corporation", token: "0xb200000000000000000000397293cb8cda9a10c5" },
  { sym: "SOFIc", ticker: "SOFI", name: "SoFi Technologies, Inc.", token: "0xb2000000000000000000003ef37a7c863dc1482a" },
  { sym: "SONYc", ticker: "SONY", name: "Sony Group Corporation", token: "0xb200000000000000000000a26326a922ffa87f6c" },
  { sym: "SOUNc", ticker: "SOUN", name: "SoundHound AI, Inc.", token: "0xb2000000000000000000002137743d4a01fe4e88" },
  { sym: "SPCXc", ticker: "SPCX", name: "Space Exploration Technologies Corp.", token: "0xb2000000000000000000007b9fcbd005511acbd5" },
  { sym: "STZc", ticker: "STZ", name: "Constellation Brands, Inc.", token: "0xb2000000000000000000001ac12227a8ae0ef3ac" },
  { sym: "SWBIc", ticker: "SWBI", name: "Smith & Wesson Brands, Inc.", token: "0xb2000000000000000000003fe90a64263b7f9e74" },
  { sym: "TAPc", ticker: "TAP", name: "Molson Coors Beverage Company", token: "0xb200000000000000000000e0b9460c97f38f412f" },
  { sym: "TKOc", ticker: "TKO", name: "TKO Group Holdings, Inc.", token: "0xb200000000000000000000b8f841940325db6b2c" },
  { sym: "TSLAc", ticker: "TSLA", name: "Tesla Inc.", token: "0xb2000000000000000000001e800a7f5189430cd0" },
  { sym: "TTDc", ticker: "TTD", name: "The Trade Desk, Inc.", token: "0xb2000000000000000000008baf7bb82e4c37743f" },
  { sym: "TTWOc", ticker: "TTWO", name: "Take-Two Interactive Software, Inc.", token: "0xb200000000000000000000f720c26062bc3067da" },
  { sym: "UAAc", ticker: "UAA", name: "Under Armour, Inc.", token: "0xb200000000000000000000879a74c76c73a27d71" },
  { sym: "UBERc", ticker: "UBER", name: "Uber Technologies, Inc.", token: "0xb200000000000000000000cae20cb1446462e24c" },
  { sym: "Uc", ticker: "U", name: "Unity Software Inc.", token: "0xb200000000000000000000902f48cba1f39149f7" },
  { sym: "ULc", ticker: "UL", name: "Unilever Plc", token: "0xb200000000000000000000349ef3aa93a0897476" },
  { sym: "UNHc", ticker: "UNH", name: "UnitedHealth Group Incorporated", token: "0xb200000000000000000000c367d37d07150182a2" },
  { sym: "USDEc", ticker: "USDE", name: "StablecoinX Inc.", token: "0xb2000000000000000000009426b660396ebcf343" },
  { sym: "VALEc", ticker: "VALE", name: "Vale S.A.", token: "0xb20000000000000000000063376b142c0764b489" },
  { sym: "VKTXc", ticker: "VKTX", name: "Viking Therapeutics, Inc.", token: "0xb200000000000000000000979ef4dd6a001b58b1" },
  { sym: "VVVc", ticker: "VVV", name: "Valvoline Inc", token: "0xb200000000000000000000fec679b39992f67627" },
  { sym: "Wc", ticker: "W", name: "Wayfair Inc.", token: "0xb20000000000000000000089bc72c3e637a02adb" },
  { sym: "WDCc", ticker: "WDC", name: "Western Digital Corporation", token: "0xb2000000000000000000008fde21a1f5c69fec0b" },
  { sym: "WENc", ticker: "WEN", name: "Wendy's Co", token: "0xb20000000000000000000044e3cd7a0e1028e57a" },
  { sym: "WINGc", ticker: "WING", name: "Wingstop Inc.", token: "0xb200000000000000000000281c973bf2555dd94b" },
  { sym: "WKHSc", ticker: "WKHS", name: "Workhorse Group Inc.", token: "0xb200000000000000000000dfa6c77aea5329d187" },
  { sym: "WMTc", ticker: "WMT", name: "Walmart Inc.", token: "0xb2000000000000000000008a7508619c717a7106" },
  { sym: "WOLFc", ticker: "WOLF", name: "Wolfspeed, Inc.", token: "0xb2000000000000000000008df9bc22db1d7da2a5" },
  { sym: "WRDc", ticker: "WRD", name: "WeRide Inc.", token: "0xb200000000000000000000e88efe88d8ade3f0da" },
  { sym: "WULFc", ticker: "WULF", name: "TeraWulf Inc.", token: "0xb200000000000000000000432a1d2bd864acec82" },
  { sym: "WWc", ticker: "WW", name: "WW International, Inc.", token: "0xb20000000000000000000089221e238277d52515" },
  { sym: "XXIc", ticker: "XXI", name: "Twenty One Capital, Inc.", token: "0xb200000000000000000000115bf2283265fb04db" },
  { sym: "XYZc", ticker: "XYZ", name: "Block, Inc.", token: "0xb20000000000000000000067c8c151f24e1c9924" },
  { sym: "YETIc", ticker: "YETI", name: "YETI Holdings, Inc.", token: "0xb200000000000000000000613c15f118df2b189b" },
  { sym: "YUMc", ticker: "YUM", name: "YUM! Brands, Inc.", token: "0xb2000000000000000000005c8324136de0f4134a" },
] as const;

/** Case-insensitive lookup, so a caller's checksummed address still matches. */
/**
 * The roster as it is TODAY: the seed above plus every record in Coinbase's own
 * Tokenized Stocks API (api.coinbase.com/v1/tokenized-stocks — the issuer's list,
 * public, no key). The seed went stale once already: on 2026-10-17 it held 82 while
 * the API listed 174, and 19 of the missing were minted and trading (the 2026-10-09
 * international batch — SAPc, SONYc, ARMc…). Coinbase plans ~250, so a hand-kept
 * list cannot keep up.
 *
 * Seed entries are never dropped (four of them — COINc, DKNGc, MTCHc, OURAc — are
 * real B20s with zero supply that the API no longer lists). The API can only ADD.
 * Cached in KV for 6 h; if the API is down we serve the last good copy, and with no
 * copy at all, the seed — a missing new listing is the failure, never a wrong one.
 */
const ROSTER_CACHE = "stocks:roster:v1";
const ROSTER_TTL = 6 * 3600;
let memo: { at: number; list: TokenizedStock[] } | null = null;

export interface ApiStock {
  contract_address?: string;
  symbol?: string;
  name?: string;
  /** Token-to-share ratio, already un-WAD'd. */
  multiplier?: number;
  total_supply?: number;
  /** Chainlink reference value — not a quote. Absent = unknown, never 0. */
  nav_price?: number;
  nav_price_updated_at?: string;
  paused_features?: string[];
}

/** Parse API records into roster entries. Pure; exported for tests. */
export function apiStocksToRoster(records: readonly ApiStock[]): TokenizedStock[] {
  const out: TokenizedStock[] = [];
  for (const r of records) {
    const token = (r.contract_address ?? "").toLowerCase();
    const sym = (r.symbol ?? "").trim();
    // Every Coinbase equity is a B20 (0xb2 prefix) with a ticker+"c" symbol.
    if (!/^0xb2[0-9a-f]{38}$/.test(token) || !/^[A-Za-z0-9.]+c$/.test(sym)) continue;
    out.push({ sym, ticker: sym.slice(0, -1), name: (r.name ?? sym.slice(0, -1)).trim(), token: token as `0x${string}` });
  }
  return out;
}

/** Seed ∪ extra, seed first; extra only adds addresses the seed does not have. */
export function mergeRoster(seed: readonly TokenizedStock[], extra: readonly TokenizedStock[]): TokenizedStock[] {
  const have = new Set(seed.map((s) => s.token));
  return [...seed, ...extra.filter((s) => !have.has(s.token) && (have.add(s.token), true))];
}

async function fetchApiRecords(): Promise<ApiStock[] | null> {
  const all: ApiStock[] = [];
  let page: string | undefined;
  for (let i = 0; i < 10; i++) {
    const url = `https://api.coinbase.com/v1/tokenized-stocks?page_size=500${page ? `&page_token=${encodeURIComponent(page)}` : ""}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) }).catch(() => null);
    if (!res || !res.ok) return null;
    const j = (await res.json().catch(() => null)) as { tokens?: ApiStock[]; next_page_token?: string } | null;
    if (!j || !Array.isArray(j.tokens)) return null;
    all.push(...j.tokens);
    page = j.next_page_token;
    if (!page) break;
  }
  return all;
}

async function fetchApiRoster(): Promise<TokenizedStock[] | null> {
  const all = await fetchApiRecords();
  return all ? apiStocksToRoster(all) : null;
}

/**
 * Coinbase's live record for one stock (reference NAV, its age, paused features,
 * multiplier). The whole list is one request, cached 5 min. null = unavailable.
 */
let recMemo: { at: number; byAddr: Map<string, ApiStock> } | null = null;
export async function stockApiRecord(token: string): Promise<ApiStock | null> {
  const a = token.toLowerCase();
  if (!recMemo || Date.now() - recMemo.at > 5 * 60_000) {
    const all = await fetchApiRecords();
    if (!all) return recMemo?.byAddr.get(a) ?? null;
    recMemo = { at: Date.now(), byAddr: new Map(all.map((r) => [(r.contract_address ?? "").toLowerCase(), r])) };
  }
  return recMemo.byAddr.get(a) ?? null;
}

export async function stockRoster(): Promise<TokenizedStock[]> {
  if (memo && Date.now() - memo.at < 10 * 60_000) return memo.list;
  const seed = TOKENIZED_STOCKS as readonly TokenizedStock[];
  // Unit tests run on the seed alone, so they never depend on Coinbase's API.
  if (process.env.VITEST) return [...seed];
  let extra: TokenizedStock[] | null = null;
  const cached = await kvGet(ROSTER_CACHE).catch(() => null);
  if (cached) {
    try {
      const c = JSON.parse(cached) as { at: number; list: TokenizedStock[] };
      if (Date.now() - c.at < ROSTER_TTL * 1000) extra = c.list;
    } catch {
      /* refetch */
    }
  }
  if (!extra) {
    const fresh = await fetchApiRoster();
    if (fresh && fresh.length) {
      extra = fresh;
      await kvSet(ROSTER_CACHE, JSON.stringify({ at: Date.now(), list: fresh }), 7 * 86400).catch(() => {});
    } else if (cached) {
      try {
        extra = (JSON.parse(cached) as { list: TokenizedStock[] }).list; // stale but real
      } catch {
        extra = [];
      }
    } else extra = [];
  }
  const list = mergeRoster(seed, extra);
  memo = { at: Date.now(), list };
  return list;
}

/** Async lookup against the live roster. */
export async function findStock(address: string): Promise<TokenizedStock | null> {
  const a = (address || "").trim().toLowerCase();
  return (await stockRoster()).find((s) => s.token === a) ?? null;
}

/** Match by ticker (AAPL), on-chain symbol (AAPLc) or address. */
export async function findStockBySymbol(raw: string): Promise<TokenizedStock | null> {
  const q = (raw || "").trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(q)) return findStock(q);
  const up = q.toUpperCase();
  const roster = await stockRoster();
  return (
    roster.find((s) => s.sym.toUpperCase() === up) ??
    roster.find((s) => s.ticker.toUpperCase() === up) ??
    (up.endsWith("C") ? roster.find((s) => s.ticker.toUpperCase() === up.slice(0, -1)) : undefined) ??
    null
  );
}

export function tokenizedStockFor(address: string): TokenizedStock | null {
  const a = (address || "").trim().toLowerCase();
  return TOKENIZED_STOCKS.find((s) => s.token === a) ?? null;
}

const client = createPublicClient({ chain: base, transport: baseTransport(8000) });

/**
 * One multicall per ~50 sub-calls (Multicall3 — a single eth_call each) instead
 * of hundreds of sequential reads with sleeps. The roster grew from 13 to 80+,
 * and the per-token loop that was fine for 13 would time out the /stocks page
 * and the daily cron. allowFailure keeps this file's load-bearing semantics: a
 * failed sub-call surfaces as a failure the caller maps to null (never 0),
 * exactly as the sequential try/catch did, and a whole-chunk RPC error marks its
 * calls failed too — a blip degrades to "unknown", never reads as a value.
 */
type MCResult = { status: "success"; result: unknown } | { status: "failure"; error: Error };
async function multicallAll(contracts: readonly unknown[], chunk = 50): Promise<MCResult[]> {
  const out: MCResult[] = [];
  for (let i = 0; i < contracts.length; i += chunk) {
    const slice = contracts.slice(i, i + chunk);
    try {
      const r = (await client.multicall({ contracts: slice as never, allowFailure: true })) as unknown as MCResult[];
      out.push(...r);
    } catch {
      for (let k = 0; k < slice.length; k++) out.push({ status: "failure", error: new Error("multicall chunk unavailable") });
    }
  }
  return out;
}
const mcVal = <T>(r: MCResult | undefined): T | null => (r && r.status === "success" ? (r.result as T) : null);

const MULTIPLIER_ABI = [
  { type: "function", name: "multiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export interface MultiplierRead {
  sym: string;
  token: string;
  /** Decimal string, or null when the read failed. NEVER 0 as a stand-in. */
  multiplier: string | null;
}

/**
 * Cobalt's ERC-8056 scheduled-multiplier surface.
 *
 * The announcement the watcher below was built around deferred one thing: it
 * could see a multiplier MOVE but not tell a scheduled corporate action from an
 * emergency one, because no sample and no readable schedule existed. Cobalt
 * (live 2026-10-01) aligns the B20 Asset multiplier with ERC-8056 and adds the
 * part that was missing — a PENDING change can now be read before it lands:
 *
 *   newUIMultiplier()  – the multiplier that is scheduled but not yet effective
 *   effectiveAt()      – the unix second at which it becomes effective
 *
 * This closes the gap in both directions. We can now ANNOUNCE a split before it
 * happens (effectiveAt in the future ⇒ a cancelable, scheduled change is queued),
 * and when a move does land we can call it SCHEDULED if we had read its pending
 * value beforehand, or EMERGENCY if it appeared with no prior schedule.
 *
 * Same discipline as everything else here: a revert on these selectors is an
 * ANSWER — the token has not adopted the ERC-8056 scheduled surface (a pre-Cobalt
 * or non-Asset token) — not a failure, and it maps to "none"/"unknown" so it can
 * never manufacture a scheduled-action alert. A value only counts as scheduled
 * when effectiveAt is set, in the future, and newUIMultiplier actually differs.
 */
const SCHEDULED_ABI = [
  { type: "function", name: "newUIMultiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "effectiveAt", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export interface ScheduledMultiplier {
  /** Pending multiplier as a decimal WAD string, or null when none/unread. */
  pending: string | null;
  /** Unix seconds the pending multiplier becomes effective, or null. */
  effectiveAt: number | null;
  /**
   * "none"      – nothing scheduled (effectiveAt=0, or a pending equal to current).
   * "scheduled" – a different multiplier is queued for a future time (cancelable).
   * "unknown"   – the ERC-8056 scheduled selectors could not be read (reverts on a
   *               pre-Cobalt / non-Asset token, or an RPC failure). Never alerted on.
   */
  status: "none" | "scheduled" | "unknown";
}

/**
 * The scheduled/emergency distinction, isolated so it can be tested without a
 * chain and so a future edit has one place to get it wrong rather than three.
 *
 * `pending`/`effectiveAt` are the raw ERC-8056 reads (null = the selector
 * reverted or the RPC failed); `current` is the live multiplier(); `nowSec` is
 * the wall clock. A scheduled change is only asserted when effectiveAt is set,
 * still in the future, and the pending value genuinely differs from current —
 * so a zeroed slot, a stale past schedule, or a no-op can never read as queued.
 */
export function classifyScheduledMultiplier(
  pending: bigint | null,
  effectiveAt: bigint | null,
  current: bigint | null,
  nowSec: number,
): "none" | "scheduled" | "unknown" {
  if (effectiveAt === null) return "unknown"; // couldn't read the schedule leg
  if (effectiveAt === 0n) return "none"; // slot unset — nothing queued
  if (Number(effectiveAt) <= nowSec) return "none"; // already effective/stale — the plain multiplier watch owns it
  if (pending === null) return "unknown"; // time is set but we couldn't read the value
  if (current !== null && pending === current) return "none"; // a no-op schedule
  return "scheduled";
}

/**
 * Read a token's pending ERC-8056 multiplier change, if any. `current` is the
 * live multiplier() the caller already read, used to reject no-op schedules.
 */
export async function readScheduledMultiplier(
  token: string,
  current: bigint | null,
): Promise<ScheduledMultiplier> {
  const addr = getAddress(token);
  const read = async (fn: "newUIMultiplier" | "effectiveAt") => {
    try {
      return (await client.readContract({ address: addr, abi: SCHEDULED_ABI, functionName: fn })) as bigint;
    } catch {
      return null;
    }
  };
  const effectiveAt = await read("effectiveAt");
  await new Promise((r) => setTimeout(r, 90));
  const pending = await read("newUIMultiplier");
  const status = classifyScheduledMultiplier(pending, effectiveAt, current, Math.floor(Date.now() / 1000));
  return {
    pending: status === "scheduled" && pending !== null ? pending.toString() : null,
    effectiveAt: status === "scheduled" && effectiveAt !== null ? Number(effectiveAt) : null,
    status,
  };
}

/**
 * Describe a queued change the way an operator needs to hear it: the unit effect
 * (reusing describeMultiplierChange) plus WHEN it lands, stated as a date so a
 * raw unix second never ends up in an alert.
 */
export function describeScheduledMultiplier(current: string | null, s: ScheduledMultiplier): string | null {
  if (s.status !== "scheduled" || s.pending === null || s.effectiveAt === null) return null;
  const when = new Date(s.effectiveAt * 1000).toISOString();
  let effect = "a multiplier change";
  try {
    if (current !== null) effect = describeMultiplierChange(BigInt(current), BigInt(s.pending));
  } catch {
    /* fall back to the generic phrasing */
  }
  return `scheduled for ${when}: ${effect}. It is pending and cancelable until then; raw balances and transfers are unaffected.`;
}

/**
 * What a change between two schedule fingerprints means — isolated and pure so a
 * watcher can act and a test can pin it without a chain or KV.
 *
 * A fingerprint is `${pending}@${effectiveAt}` (both decimal) or "none". The one
 * thing this exists to get right: when a schedule DISAPPEARS, that is "cancelled"
 * ONLY if it was pulled before its effective time. Once effectiveAt has passed,
 * the schedule clears because it APPLIED (or is about to, and this read simply
 * beat the move) — classifyScheduledMultiplier flips to "none" the instant the
 * time passes, so keying "cancelled" off the disappearance alone fires a false
 * alert in exactly that window. The multiplier watch reports the real move, so
 * an applied/ambiguous clear stays silent here.
 *
 *   "seed"       caller's first sight (prev unknown) — handled by the caller
 *   "unchanged"  identical fingerprint
 *   "scheduled"  newly queued or rescheduled (now points at a future change)
 *   "cancelled"  a future schedule was removed BEFORE its effective time
 *   "applied"    a schedule cleared at/after its time (the move is the event)
 */
export function scheduleTransition(
  prev: string,
  now: string,
  currentMultiplier: string | undefined,
  nowSec: number,
): "unchanged" | "scheduled" | "cancelled" | "applied" {
  if (prev === now) return "unchanged";
  if (now !== "none") return "scheduled";
  // now === "none": the schedule is gone. Took effect, or was cancelled.
  const [pendingP, effAtStr] = prev.split("@");
  // The multiplier already reads the pending value → it applied, unambiguously.
  if (currentMultiplier !== undefined && currentMultiplier === pendingP) return "applied";
  const prevEffAt = Number(effAtStr);
  // Removed while still in the future → a genuine cancellation.
  if (Number.isFinite(prevEffAt) && prevEffAt > nowSec) return "cancelled";
  // Effective time already passed (or unparseable): treat as applied/lag, never
  // a false cancel. The multiplier watch owns the actual move.
  return "applied";
}

/**
 * Read multiplier() for every stock in one batched multicall.
 *
 * A failed read yields null rather than a number — the caller has to be able to
 * tell "unchanged" from "unknown", or a network blip would be recorded as the
 * new baseline and the real change that follows it would never be reported.
 */
export async function readMultipliers(
  given?: readonly TokenizedStock[],
): Promise<MultiplierRead[]> {
  const stocks = given ?? (await stockRoster());
  const res = await multicallAll(stocks.map((s) => ({ address: getAddress(s.token), abi: MULTIPLIER_ABI, functionName: "multiplier" })));
  return stocks.map((s, i) => {
    const m = mcVal<bigint>(res[i]);
    return { sym: s.sym, token: s.token, multiplier: m === null ? null : m.toString() };
  });
}

/**
 * Pending ERC-8056 schedule for every stock in two batched multicalls' worth of
 * sub-calls (effectiveAt + newUIMultiplier per token). `currentBySym` carries the
 * live multiplier() per symbol so a no-op schedule can be rejected. Returns a map
 * keyed by symbol; the single-token readScheduledMultiplier above still serves
 * one-off callers (b20-rebase), this is the roster-scale path.
 */
export async function readSchedules(
  stocks: readonly TokenizedStock[],
  currentBySym: Map<string, bigint | null>,
): Promise<Map<string, ScheduledMultiplier>> {
  const contracts: unknown[] = [];
  for (const s of stocks) {
    const address = getAddress(s.token);
    contracts.push({ address, abi: SCHEDULED_ABI, functionName: "effectiveAt" });
    contracts.push({ address, abi: SCHEDULED_ABI, functionName: "newUIMultiplier" });
  }
  const res = await multicallAll(contracts);
  const nowSec = Math.floor(Date.now() / 1000);
  const map = new Map<string, ScheduledMultiplier>();
  stocks.forEach((s, i) => {
    const effectiveAt = mcVal<bigint>(res[i * 2]);
    const pending = mcVal<bigint>(res[i * 2 + 1]);
    const status = classifyScheduledMultiplier(pending, effectiveAt, currentBySym.get(s.sym) ?? null, nowSec);
    map.set(s.sym, {
      pending: status === "scheduled" && pending !== null ? pending.toString() : null,
      effectiveAt: status === "scheduled" && effectiveAt !== null ? Number(effectiveAt) : null,
      status,
    });
  });
  return map;
}

const BOARD_ABI = [
  { type: "function", name: "multiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "isPaused", stateMutability: "view", inputs: [{ type: "uint8" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "policyId", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint64" }] },
] as const;

/**
 * Who may send and receive these tokens — a question every builder on top of
 * them has to answer, and one nobody publishes.
 *
 * Base's own Request for Builders repeats three times that tokenized stocks are
 * "available to eligible users in permitted jurisdictions outside the United
 * States", and every category it names — brokerage front-ends, personalised
 * indices, gifting, yield stripping, agents allocating on their own — has to
 * know whether a given address can hold the asset before it builds a
 * transaction that would revert.
 *
 * Measured on 2026-09-14 against AAPLc and AMZNc: both carry sender and receiver
 * policy id 5 — set, not the unset 0 that reads as always-allow — and the
 * registry answered `true` for every address tried, including a burn address, a
 * token contract, a DEX factory and an EOA that has never existed. So the
 * eligibility restriction is not enforced at transfer. It lives at issuance and
 * redemption, in Coinbase's own app.
 *
 * Which is the finding worth publishing, and also the reason to watch it: this
 * is a POLICY, not a property of the token. Policy 5 is live and its admin can
 * change what it authorizes at any block, and on that day every integration
 * built on "these transfer freely" breaks at once — silently, because nothing
 * about the token address or its ABI will have changed.
 *
 * CANARY is an address with no relationship to any of this: never KYC'd, never
 * a holder. If the policy ever stops authorizing it, the permissive era is over.
 * Deliberately not one of our own wallets — a canary that could be individually
 * allow-listed cannot detect a general tightening.
 */
const TRANSFER_SENDER_POLICY = keccak256(toBytes("TRANSFER_SENDER_POLICY"));
const TRANSFER_RECEIVER_POLICY = keccak256(toBytes("TRANSFER_RECEIVER_POLICY"));

export const B20_POLICY_REGISTRY = "0x8453000000000000000000000000000000000002" as const;
export const CANARY = "0x1234567890AbcdEF1234567890aBcdef12345678" as const;

const REGISTRY_ABI = [
  { type: "function", name: "isAuthorized", stateMutability: "view", inputs: [{ type: "uint64" }, { type: "address" }], outputs: [{ type: "bool" }] },
] as const;

export interface TransferPolicyRead {
  /** null when the read failed — never 0, which would read as "no policy, allow all". */
  senderPolicyId: string | null;
  receiverPolicyId: string | null;
  /** Whether an unrelated address may send / receive. null when unread. */
  canaryMaySend: boolean | null;
  canaryMayReceive: boolean | null;
}

/**
 * Read one token's transfer policy and whether the canary passes it.
 *
 * A policy id of 0 means the slot is unset, which the registry treats as
 * always-allow; that is reported as-is rather than collapsed into "permissive",
 * because "no policy" and "a policy that currently permits everyone" are
 * different facts with different futures.
 */
export async function readTransferPolicy(token: string): Promise<TransferPolicyRead> {
  const addr = getAddress(token);
  const readId = async (scope: `0x${string}`) => {
    try {
      return (await client.readContract({ address: addr, abi: BOARD_ABI, functionName: "policyId", args: [scope] })) as bigint;
    } catch {
      return null;
    }
  };
  const authorised = async (id: bigint | null) => {
    if (id === null) return null;
    try {
      return (await client.readContract({
        address: B20_POLICY_REGISTRY,
        abi: REGISTRY_ABI,
        functionName: "isAuthorized",
        args: [id, CANARY],
      })) as boolean;
    } catch {
      return null;
    }
  };

  const senderId = await readId(TRANSFER_SENDER_POLICY);
  await new Promise((r) => setTimeout(r, 90));
  const receiverId = await readId(TRANSFER_RECEIVER_POLICY);
  await new Promise((r) => setTimeout(r, 90));
  const maySend = await authorised(senderId);
  await new Promise((r) => setTimeout(r, 90));
  const mayReceive = await authorised(receiverId);

  return {
    senderPolicyId: senderId === null ? null : senderId.toString(),
    receiverPolicyId: receiverId === null ? null : receiverId.toString(),
    canaryMaySend: maySend,
    canaryMayReceive: mayReceive,
  };
}

/**
 * The same read as readTransferPolicy, batched across the whole roster: one
 * multicall for the sender/receiver policy ids, then one for the canary's
 * isAuthorized on the ids we could read. Same null-on-failure semantics (a failed
 * id read is null, never 0; its auth leg is then null too).
 */
export async function readTransferPolicies(
  stocks: readonly TokenizedStock[],
): Promise<Map<string, TransferPolicyRead>> {
  const idContracts: unknown[] = [];
  for (const s of stocks) {
    const address = getAddress(s.token);
    idContracts.push({ address, abi: BOARD_ABI, functionName: "policyId", args: [TRANSFER_SENDER_POLICY] });
    idContracts.push({ address, abi: BOARD_ABI, functionName: "policyId", args: [TRANSFER_RECEIVER_POLICY] });
  }
  const idRes = await multicallAll(idContracts);
  const senderIds = stocks.map((_, i) => mcVal<bigint>(idRes[i * 2]));
  const receiverIds = stocks.map((_, i) => mcVal<bigint>(idRes[i * 2 + 1]));

  // Only ask the registry about ids we actually read (null = read failed → auth
  // stays null). id 0 is kept: the registry treats it as always-allow and never
  // reverts, matching the single-token path.
  const authContracts: unknown[] = [];
  const authSlots: Array<{ i: number; leg: "s" | "r" }> = [];
  stocks.forEach((_, i) => {
    if (senderIds[i] !== null) {
      authContracts.push({ address: B20_POLICY_REGISTRY, abi: REGISTRY_ABI, functionName: "isAuthorized", args: [senderIds[i], CANARY] });
      authSlots.push({ i, leg: "s" });
    }
    if (receiverIds[i] !== null) {
      authContracts.push({ address: B20_POLICY_REGISTRY, abi: REGISTRY_ABI, functionName: "isAuthorized", args: [receiverIds[i], CANARY] });
      authSlots.push({ i, leg: "r" });
    }
  });
  const authRes = await multicallAll(authContracts);
  const send: Array<boolean | null> = stocks.map(() => null);
  const recv: Array<boolean | null> = stocks.map(() => null);
  authSlots.forEach((slot, k) => {
    const v = mcVal<boolean>(authRes[k]);
    if (slot.leg === "s") send[slot.i] = v;
    else recv[slot.i] = v;
  });

  const map = new Map<string, TransferPolicyRead>();
  stocks.forEach((s, i) => {
    map.set(s.sym, {
      senderPolicyId: senderIds[i] === null ? null : (senderIds[i] as bigint).toString(),
      receiverPolicyId: receiverIds[i] === null ? null : (receiverIds[i] as bigint).toString(),
      canaryMaySend: send[i],
      canaryMayReceive: recv[i],
    });
  });
  return map;
}

/** Tokenized equities carry 8 decimals, not the 18 an ERC-20 reader would assume. */
const SHARE_UNIT = 10n ** 8n;

export interface StockBoardRow {
  sym: string;
  ticker: string;
  name: string;
  token: string;
  /** null when the read failed — never 0, which would read as "no supply". */
  supplyShares: number | null;
  multiplier: string | null;
  multiplierRatio: number | null;
  transferPaused: boolean | null;
  /**
   * Deployed but never issued. All thirteen contracts were created within five
   * minutes of each other on 2026-07-26; supply arrives in batches, so a zero
   * here means "announced, not yet launched" rather than "not real".
   */
  issued: boolean | null;
  /** Who may send and receive this token today — see readTransferPolicy. */
  policy: TransferPolicyRead;
  /** A pending ERC-8056 multiplier change, if one is queued (Cobalt). */
  scheduled: ScheduledMultiplier;
}

/**
 * Read the whole board, sequentially.
 *
 * Base's public RPC rate-limits parallel eth_calls and this is a public page, so
 * one read at a time with a small gap. A failure yields null rather than a
 * number: on a board whose entire point is "the number you are reading is not
 * the number you think", silently substituting a zero would be the worst
 * available bug.
 */
export async function readStockBoard(): Promise<{
  asOf: string;
  count: number;
  issuedCount: number;
  rows: StockBoardRow[];
  degraded: boolean;
  transferPolicy: string;
  finding: string;
  scheduledActions: string;
  note: string;
}> {
  const roster = await stockRoster();
  // Batched: one multicall for multiplier/totalSupply/isPaused across the roster,
  // then the transfer policies and schedules (each its own batched read) in
  // parallel. The old per-token sequential loop with sleeps did ~9 RPCs × 80+
  // tokens and would time the page out; this is a handful of eth_calls.
  const coreContracts: unknown[] = [];
  for (const s of roster) {
    const address = getAddress(s.token);
    coreContracts.push({ address, abi: BOARD_ABI, functionName: "multiplier" });
    coreContracts.push({ address, abi: BOARD_ABI, functionName: "totalSupply" });
    coreContracts.push({ address, abi: BOARD_ABI, functionName: "isPaused", args: [0] });
  }
  const core = await multicallAll(coreContracts);
  const multBySym = new Map<string, bigint | null>();
  roster.forEach((s, i) => multBySym.set(s.sym, mcVal<bigint>(core[i * 3])));

  const [policies, schedules] = await Promise.all([
    readTransferPolicies(roster),
    readSchedules(roster, multBySym),
  ]);

  const rows: StockBoardRow[] = roster.map((s, i) => {
    const mult = mcVal<bigint>(core[i * 3]);
    const supply = mcVal<bigint>(core[i * 3 + 1]);
    const paused = mcVal<boolean>(core[i * 3 + 2]);
    return {
      sym: s.sym,
      ticker: s.ticker,
      name: s.name,
      token: s.token,
      supplyShares: supply === null ? null : Number((supply * 1000n) / SHARE_UNIT) / 1000,
      multiplier: mult === null ? null : mult.toString(),
      multiplierRatio: mult === null ? null : Number((mult * 1_000_000n) / WAD) / 1_000_000,
      transferPaused: paused,
      issued: supply === null ? null : supply > 0n,
      policy: policies.get(s.sym) as TransferPolicyRead,
      scheduled: schedules.get(s.sym) as ScheduledMultiplier,
    };
  });

  const degraded = rows.some((r) => r.multiplier === null || r.supplyShares === null);
  const moved = rows.filter((r) => r.multiplierRatio !== null && r.multiplierRatio !== 1);
  const issuedCount = rows.filter((r) => r.issued === true).length;

  /**
   * One sentence on who may move these today, derived rather than asserted.
   *
   * Stated as what was measured — "the registry authorises an unrelated address"
   * — and never as "anyone can hold these", which is a claim about a policy's
   * future that no read can support.
   */
  const policed = rows.filter((r) => r.policy.senderPolicyId !== null && r.policy.senderPolicyId !== "0");
  const openToCanary = rows.filter((r) => r.policy.canaryMaySend === true && r.policy.canaryMayReceive === true);
  const closedToCanary = rows.filter((r) => r.policy.canaryMaySend === false || r.policy.canaryMayReceive === false);

  return {
    asOf: new Date().toISOString(),
    count: rows.length,
    issuedCount,
    rows,
    degraded,
    transferPolicy:
      closedToCanary.length > 0
        ? `${closedToCanary.length} of ${rows.length} no longer authorise an unrelated address to send or receive. The permissive era is over for those: a contract, pool or agent holding them needs the policy checked before it builds a transfer.`
        : `${policed.length} of ${rows.length} carry a transfer policy (a set id, not the unset 0 that means always-allow), and for ${openToCanary.length} the registry still authorises an address with no relationship to the issuer — never KYC'd, never a holder. So eligibility is not enforced at transfer today; it is enforced at issuance and redemption. That is a policy, not a property: its admin can change it at any block, and nothing about the token address or its ABI would change with it.`,
    finding:
      moved.length > 0
        ? `${moved.length} of ${rows.length} carry a multiplier other than 1.0 — for those, balanceOf understates or overstates the real position by exactly that factor.`
        : // Not "no corporate action has been applied yet" — GOOGLc's landed on
          // 2026-09-14 and this sentence would have gone on denying it. All this
          // branch can say is what it just read.
          "Every multiplier currently reads 1.0. That is a statement about right now, not a history: GOOGLc moved on 2026-09-14 and its balanceOf did not, which is what happens to a naive reader every time one of these moves.",
    // Pending ERC-8056 changes, read before they land (Cobalt). Stated only when
    // one is actually queued — a revert on the scheduled selectors (pre-Cobalt /
    // non-Asset) reads as "none" and never fabricates a forward-looking claim.
    scheduledActions: (() => {
      const queued = rows.filter((r) => r.scheduled.status === "scheduled");
      if (queued.length === 0) {
        return "No scheduled multiplier change is queued on any of these right now. Cobalt makes a pending split/accrual readable (newUIMultiplier/effectiveAt) before it takes effect; this says there is nothing waiting as of this read.";
      }
      return queued
        .map((r) => `${r.sym} (${r.ticker}): ${describeScheduledMultiplier(r.multiplier, r.scheduled)}`)
        .join(" ");
    })(),
    note:
      "B20 Asset tokens do not apply multiplier() to balanceOf() — measured on chain: a multiplier moved 1.0 to 2.0 and holder balances read identically before and after. This board is free; per-wallet answers are the paid stock-position endpoint. Not financial advice.",
  };
}

/**
 * Describe a multiplier move the way a holder experiences it.
 *
 * A multiplier is not a price. Going from 1.0 to 4.0 does not mean the position
 * gained 300% — it means the same value is now denominated in four times as
 * many units, which is what a 4-for-1 split looks like on chain. The wording
 * here says that explicitly, because the failure mode of a terse alert is an
 * operator reading a split as a windfall.
 */
export function describeMultiplierChange(from: bigint, to: bigint): string {
  if (to === from) return "unchanged";
  const ratio = Number((to * 10000n) / (from === 0n ? WAD : from)) / 10000;
  const direction = to > from ? "up" : "down";
  const unitEffect =
    to > from
      ? `every holder's unit count is multiplied by ${ratio}× (a split-shaped move: more units, not more value)`
      : `every holder's unit count is multiplied by ${ratio}× (a reverse-split-shaped move: fewer units, not less value)`;
  return `${direction} ${ratio}× — ${unitEffect}`;
}
